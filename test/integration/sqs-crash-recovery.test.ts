import { fileURLToPath } from 'node:url';
import {
  CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { expect, test } from 'bun:test';
import { OpenWallet } from '../../src/application/open-wallet.js';
import { Money } from '../../src/domain/money.js';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { WagerTransactionRecord, WalletLedgerEntryRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { InboxRecord } from '../../src/infrastructure/database/inbox-record.js';
import { OutboxRecord } from '../../src/infrastructure/database/outbox-record.js';
import { PostgresWalletOpeningStore } from '../../src/infrastructure/database/postgres-wallet-opening-store.js';
import { WAGER_CONSUMER_NAME } from '../../src/infrastructure/sqs/wager-consumer.js';
import { parseWagerMessage } from '../../src/infrastructure/sqs/wager-message.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;
const endpoint = process.env.FINANCIAL_TEST_SQS_ENDPOINT;
const fixture = fileURLToPath(new URL('../fixtures/sqs-crash-consumer.ts', import.meta.url));

interface Checkpoint {
  event: string;
  pid: number;
  messageId?: string;
  receiveCount?: number;
  duplicate?: boolean;
}

function startConsumer(schema: string, mode: 'block-ack' | 'recover') {
  const checkpoint = Promise.withResolvers<Checkpoint>();
  const child = Bun.spawn([process.execPath, '--no-env-file', fixture, schema, mode], {
    env: { FINANCIAL_TEST_DATABASE_URL: databaseUrl, FINANCIAL_TEST_SQS_ENDPOINT: endpoint },
    stdout: 'ignore',
    stderr: 'ignore',
    ipc: (message: Checkpoint) => checkpoint.resolve(message),
  });

  return {
    child,
    async waitForCheckpoint() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          checkpoint.promise,
          child.exited.then((code) => {
            throw new Error(`Consumer ${mode} exited before its checkpoint (code ${code}, signal ${child.signalCode}).`);
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Consumer ${mode} checkpoint timed out.`)), 12_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    },
  };
}

test.skipIf(!databaseUrl || !endpoint)('recovers a committed SQS wager after SIGKILL before ACK in a separate consumer process', async () => {
  const id = crypto.randomUUID().replaceAll('-', '');
  const schema = `financial_test_${id}`;
  const config = financialTestConfig(databaseUrl!, schema);
  const parsedEndpoint = new URL(endpoint!);
  if (parsedEndpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsedEndpoint.hostname) ||
      !['127.0.0.1', 'localhost'].includes(config.host)) {
    throw new Error('Use local PostgreSQL and LocalStack for the crash recovery test.');
  }

  const sqs = new SQSClient({
    endpoint, region: 'us-east-1', maxAttempts: 1, credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: { connectionTimeout: 1000, requestTimeout: 2500, throwOnRequestTimeout: true },
  });
  let orm: MikroORM | undefined;
  let queueUrl: string | undefined;
  let first: ReturnType<typeof startConsumer> | undefined;
  let restarted: ReturnType<typeof startConsumer> | undefined;
  try {
    const parent = orm = await MikroORM.init(config);
    expect(await parent.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await parent.migrator.up();
    const wallet = await new OpenWallet(new PostgresWalletOpeningStore(parent.em)).execute(
      `crash-player-${id}`, Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const messageId = `crash-message-${id}`;
    const externalTransactionId = `crash-bet-${id}`;
    const body = JSON.stringify({
      messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: {
        providerId: 'crash-test-provider', externalTransactionId, idempotencyKey: externalTransactionId,
        walletId: wallet.id, playerId: wallet.playerId, roundId: 'crash-test-round', gameId: 'crash-test-game',
        kind: Kind.Bet, money: { amount: '25.50', currency: 'BRL' },
      },
    });

    const created = await sqs.send(new CreateQueueCommand({
      QueueName: `crash-wager-${id}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '5' },
    }));
    if (!created.QueueUrl) throw new Error('Missing crash test queue URL.');
    const queue = queueUrl = created.QueueUrl;

    async function snapshot() {
      const em = parent.em.fork();
      const storedWallet = await em.findOneOrFail(WalletRecord, wallet.id);
      const wagers = await em.find(WagerTransactionRecord, { walletId: wallet.id }, { orderBy: { id: 'asc' } });
      const ledger = await em.find(WalletLedgerEntryRecord, { walletId: wallet.id }, { orderBy: { id: 'asc' } });
      const inbox = await em.find(InboxRecord, {}, { orderBy: { messageId: 'asc' } });
      const outbox = await em.find(OutboxRecord, { payload: { data: { walletId: wallet.id } } }, { orderBy: { id: 'asc' } });
      const reconstructed = await em.execute(
        `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0.00)::text AS balance
         FROM "${schema}".wallet_ledger_entries WHERE wallet_id = ?`, [wallet.id],
      );
      expect(reconstructed).toEqual([{ balance: storedWallet.balance }]);
      return { wallet: storedWallet, wagers, ledger, inbox, outbox };
    }

    async function queueDepth() {
      const { Attributes } = await sqs.send(new GetQueueAttributesCommand({
        QueueUrl: queue, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }));
      return { visible: Attributes?.ApproximateNumberOfMessages, inFlight: Attributes?.ApproximateNumberOfMessagesNotVisible };
    }

    first = startConsumer(schema, 'block-ack');
    const { MessageId: brokerMessageId } = await sqs.send(new SendMessageCommand({
      QueueUrl: queue, MessageBody: body, MessageGroupId: wallet.id, MessageDeduplicationId: messageId,
    }));
    expect(brokerMessageId).toBeString();
    expect(await first.waitForCheckpoint()).toEqual({ event: 'before_ack', pid: first.child.pid });
    expect(first.child.pid).not.toBe(process.pid);
    expect(first.child.exitCode).toBeNull();

    // An independent PostgreSQL connection can see the commit while DeleteMessage is parked in the child.
    const committed = await snapshot();
    const wager = committed.wagers.find(({ kind }) => kind === Kind.Bet);
    expect(wager).toBeDefined();
    expect(wager).toMatchObject({
      status: Status.Processed, externalTransactionId, observedBalance: '74.50', amount: '25.50',
    });
    expect(committed.wallet).toMatchObject({ balance: '74.50', version: 2 });
    expect(committed.wagers.map(({ kind }) => kind).sort()).toEqual([Kind.Bet, Kind.Opening]);
    expect(committed.ledger).toHaveLength(2);
    expect(committed.ledger.filter(({ direction }) => direction === 'DEBIT')).toEqual([
      expect.objectContaining({
        transactionId: wager!.id, amount: '25.50', balanceBefore: '100.00', balanceAfter: '74.50',
      }),
    ]);
    expect(committed.inbox).toHaveLength(1);
    expect(committed.inbox[0]).toMatchObject({
      consumerName: WAGER_CONSUMER_NAME, messageId, payloadHash: parseWagerMessage(body).payloadHash,
    });
    expect(committed.inbox[0].processedAt).toBeInstanceOf(Date);
    expect(committed.outbox).toHaveLength(4);
    expect(committed.outbox.filter(({ payload }) => payload.correlationId === wager!.id).map(({ eventType }) => eventType).sort())
      .toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await queueDepth()).toEqual({ visible: '0', inFlight: '1' });

    first.child.kill('SIGKILL');
    await first.child.exited;
    expect(first.child.signalCode).toBe('SIGKILL');

    // Only LocalStack makes the message visible again after the original receipt expires.
    restarted = startConsumer(schema, 'recover');
    expect(restarted.child.pid).not.toBe(first.child.pid);
    expect(await restarted.waitForCheckpoint()).toEqual({
      event: 'sqs_ack', pid: restarted.child.pid, messageId, receiveCount: 2, duplicate: true,
    });
    expect(await restarted.child.exited).toBe(0);
    expect(await queueDepth()).toEqual({ visible: '0', inFlight: '0' });
    expect(await snapshot()).toEqual(committed);
  } finally {
    try {
      await Promise.all([first?.dispose(), restarted?.dispose()]);
      try {
        if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      } finally {
        if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      sqs.destroy();
      await orm?.close();
    }
  }
}, 30_000);
