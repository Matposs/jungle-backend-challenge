import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from '../../src/domain/wager-transaction.js';
import { WagerTransactionRecord, WalletRecord } from '../../src/infrastructure/database/financial-records.js';
import { encodeLedgerCursor } from '../../src/infrastructure/http/financial-query-contracts.js';
import { WageringModule } from '../../src/infrastructure/http/wagering.module.js';
import { WalletsModule } from '../../src/infrastructure/http/wallets.module.js';
import { financialTestConfig } from './financial-test-config.js';

const databaseUrl = process.env.FINANCIAL_TEST_DATABASE_URL;

test.each([
  ['a missing', undefined],
  ['an invalid', 'z'.repeat(64)],
] as const)('HTTP startup refuses %s ledger cursor secret', async (_label, secret) => {
  const env: Record<string, string | undefined> = { ...process.env, PORT: '0' };
  if (secret === undefined) delete env.LEDGER_CURSOR_SECRET;
  else env.LEDGER_CURSOR_SECRET = secret;
  const child = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(new URL('../../src/main.ts', import.meta.url))], {
    env, stdout: 'pipe', stderr: 'pipe', timeout: 3000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain('LEDGER_CURSOR_SECRET must contain 64 hexadecimal characters (32 bytes).');
  if (secret !== undefined) expect(stdout + stderr).not.toContain(secret);
});

interface WalletResponse {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface LedgerPage {
  items: { id: string; transactionId: string; walletId: string; createdAt: string }[];
  nextCursor: string | null;
}

describe.skipIf(!databaseUrl)('Financial HTTP queries on PostgreSQL', () => {
  const schema = `financial_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const ledgerTable = `"${schema}".wallet_ledger_entries`;
  let app: INestApplication;
  let orm: MikroORM;
  let url: string;
  const originalSecret = process.env.LEDGER_CURSOR_SECRET;

  beforeAll(async () => {
    process.env.LEDGER_CURSOR_SECRET = randomBytes(32).toString('hex');
    const config = financialTestConfig(databaseUrl!, schema);
    @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule, WageringModule] })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false, abortOnError: false });
    orm = app.get(MikroORM);
    expect(await orm.em.execute('SELECT current_database() AS name')).toEqual([{ name: config.dbName }]);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });

  afterAll(async () => {
    try {
      if (orm) await orm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      if (originalSecret === undefined) delete process.env.LEDGER_CURSOR_SECRET;
      else process.env.LEDGER_CURSOR_SECRET = originalSecret;
      await app?.close();
    }
  });

  function get(path: string) {
    return fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) });
  }

  function createWalletApp(config: ReturnType<typeof financialTestConfig>) {
    @Module({ imports: [MikroOrmModule.forRoot(config), WalletsModule] })
    class WalletAppModule {}

    return NestFactory.create(WalletAppModule, { logger: false, abortOnError: false });
  }

  function post(path: string, body: object, key?: string) {
    return fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key && { 'Idempotency-Key': key }) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
  }

  async function open(amount = '100.00') {
    const response = await post('/wallets', { playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } });
    expect(response.status).toBe(201);
    return await response.json() as WalletResponse;
  }

  function transaction(wallet: WalletResponse, providerId: string, externalTransactionId: string) {
    return {
      providerId, externalTransactionId, walletId: wallet.id, playerId: wallet.playerId,
      roundId: 'round', gameId: 'game', kind: Kind.Bet, money: { amount: '1.00', currency: 'BRL' },
    };
  }

  async function submit(body: ReturnType<typeof transaction> & { referenceExternalTransactionId?: string }, status = 200) {
    const response = await post('/wagering/transactions', body, body.externalTransactionId);
    expect(response.status).toBe(status);
    return await response.json() as { transactionId: string };
  }

  function externalPath(providerId: string, externalId: string) {
    return `/providers/${encodeURIComponent(providerId)}/wagering/transactions/${encodeURIComponent(externalId)}`;
  }

  async function ledger(walletId: string, limit?: number, cursor?: string | null) {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const response = await get(`/wallets/${walletId}/ledger?${query}`);
    expect(response.status).toBe(200);
    return await response.json() as LedgerPage;
  }

  async function seedLedger(wallet: WalletResponse, entries: readonly { id: string; at: string }[]) {
    await orm.em.fork().transactional(async (tx) => {
      for (const [index, entry] of entries.entries()) {
        const id = `wager:${wallet.id}:${entry.id}`;
        const balanceBefore = `${index}.00`;
        const balanceAfter = `${index + 1}.00`;
        await tx.insert(WagerTransactionRecord, {
          id, providerId: 'fixtures', externalTransactionId: id, idempotencyKey: id, payloadHash: 'fixture',
          walletId: wallet.id, playerId: wallet.playerId, roundId: 'round', gameId: 'game',
          kind: Kind.Win, status: Status.Processed, amount: '1.00', currency: 'BRL',
          createdAt: new Date(entry.at), finalizedAt: new Date(entry.at), observedBalance: balanceAfter,
        });
        await tx.execute(
          `INSERT INTO ${ledgerTable}
             (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
           VALUES (?, ?, ?, 'CREDIT', '1.00', 'BRL', ?, ?, ?::timestamptz)`,
          [`${wallet.id}:${entry.id}`, wallet.id, id, balanceBefore, balanceAfter, entry.at],
        );
      }
      await tx.nativeUpdate(WalletRecord, { id: wallet.id }, { balance: `${entries.length}.00`, version: entries.length + 1 });
    });
  }

  test('reads exact current and observed balances, including OPENING only by its internal ID', async () => {
    const wallet = await open('9007199254740993.01');
    const opening = (await ledger(wallet.id)).items[0];
    const { transactionId } = await submit(transaction(wallet, 'provider-a', 'large-bet'));

    const walletResult = await get(`/wallets/${wallet.id}`);
    expect(walletResult.status).toBe(200);
    expect(await walletResult.json()).toEqual({ ...wallet, balance: { amount: '9007199254740992.01', currency: 'BRL' }, version: 2 });

    const openingResult = await get(`/wagering/transactions/${opening.transactionId}`);
    expect(openingResult.status).toBe(200);
    expect(await openingResult.json()).toMatchObject({
      kind: Kind.Opening, status: Status.Processed, observedBalance: wallet.balance, money: wallet.balance,
    });
    expect((await get(externalPath('internal:wallet-opening', `opening:${wallet.id}`))).status).toBe(404);

    await submit(transaction(wallet, 'provider-a', 'another-large-bet'));
    const operation = await get(externalPath('provider-a', 'large-bet'));
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({ transactionId, observedBalance: { amount: '9007199254740992.01', currency: 'BRL' } });
    expect(await (await get(`/wallets/${wallet.id}`)).json()).toMatchObject({
      balance: { amount: '9007199254740991.01', currency: 'BRL' }, version: 3,
    });
    expect((await ledger(wallet.id)).items).toContainEqual(expect.objectContaining({
      transactionId: opening.transactionId, balanceAfter: wallet.balance, money: wallet.balance,
    }));
  });

  test('returns the same transaction DTO by either identity and isolates providers sharing an external ID', async () => {
    const a = await open();
    const b = await open();
    const first = await submit(transaction(a, 'provider-a', 'shared/id'));
    const second = await submit(transaction(b, 'provider-b', 'shared/id'));
    for (const [provider, wallet, operation] of [['provider-a', a, first], ['provider-b', b, second]] as const) {
      const external = await get(externalPath(provider, 'shared/id'));
      const internal = await get(`/wagering/transactions/${operation.transactionId}`);
      expect([external.status, internal.status]).toEqual([200, 200]);
      const dto = await external.json();
      expect(dto).toEqual(await internal.json());
      expect(dto).toEqual({
        transactionId: operation.transactionId, walletId: wallet.id, providerId: provider,
        externalTransactionId: 'shared/id', roundId: 'round', gameId: 'game', kind: Kind.Bet, status: Status.Processed,
        money: { amount: '1.00', currency: 'BRL' }, observedBalance: { amount: '99.00', currency: 'BRL' },
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        finalizedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      });
    }
    expect((await get(externalPath('other-provider', 'shared/id'))).status).toBe(404);
  });

  test('reads pending, pending-reference, rejected and failed states with their stored metadata', async () => {
    const wallet = await open('0.00');
    const base = transaction(wallet, 'states', 'rejected');
    const rejected = await submit(base, 422);
    const awaiting = await submit({
      ...base, kind: Kind.Win, externalTransactionId: 'awaiting', referenceExternalTransactionId: 'missing',
    }, 202);
    for (const [id, status] of [['fixture-pending', Status.Pending], ['fixture-failed', Status.Failed]] as const) {
      const { money, ...input } = base;
      const failed = status === Status.Failed;
      await orm.em.fork().insert(WagerTransactionRecord, {
        ...input, id, externalTransactionId: id, idempotencyKey: id, payloadHash: 'fixture', status,
        ...money, createdAt: new Date(), ...(failed && { finalizedAt: new Date(), failureCode: 'INFRASTRUCTURE_FAILURE' }),
      });
    }
    const cases = [
      [rejected.transactionId, Status.Rejected, { failureCode: 'INSUFFICIENT_FUNDS', observedBalance: wallet.balance }],
      [awaiting.transactionId, Status.PendingReference, { referenceExternalTransactionId: 'missing' }],
      ['fixture-pending', Status.Pending, {}],
      ['fixture-failed', Status.Failed, { failureCode: 'INFRASTRUCTURE_FAILURE' }],
    ] as const;
    for (const [id, status, details] of cases) {
      const response = await get(`/wagering/transactions/${id}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ transactionId: id, status, ...details });
      if (status === Status.Pending || status === Status.PendingReference) {
        expect(body).not.toHaveProperty('observedBalance');
        expect(body).not.toHaveProperty('finalizedAt');
      } else {
        expect(body).toHaveProperty('finalizedAt');
      }
    }
  });

  test('distinguishes missing resources from a wallet without ledger entries and validates parameters', async () => {
    const wallet = await open('0.00');
    expect(await ledger(wallet.id)).toEqual({ items: [], nextCursor: null });
    for (const path of ['/wallets/missing', '/wallets/missing/ledger', '/wagering/transactions/missing', externalPath('missing', 'missing')]) {
      expect((await get(path)).status).toBe(404);
    }
    for (const path of [
      '/wallets/%20', '/wallets/%00/ledger', '/wagering/transactions/%00', externalPath(' ', 'id'), externalPath('provider', ' '),
      ...['', '0', '-1', '101', '1.2', '1e1', '1&limit=2'].map((limit) => `/wallets/${wallet.id}/ledger?limit=${limit}`),
      `/wallets/${wallet.id}/ledger?cursor=`, `/wallets/${wallet.id}/ledger?cursor=bad`,
    ]) {
      expect((await get(path)).status).toBe(400);
    }
  });

  test('paginates every entry across identical timestamps and microseconds despite a concurrent insert', async () => {
    const wallet = await open('0.00');
    const other = await open();
    await seedLedger(wallet, [
      { id: 'z', at: '2020-01-01T00:00:00.000100Z' },
      { id: 'b', at: '2020-01-01T00:00:00.000500Z' },
      { id: 'c', at: '2020-01-01T00:00:00.000500Z' },
      { id: 'a', at: '2020-01-01T00:00:00.000900Z' },
    ]);
    const first = await ledger(wallet.id, 1);
    expect(first.items.map(({ id }) => id)).toEqual([`${wallet.id}:a`]);
    expect(first.nextCursor).toBeString();
    const [second, inserted] = await Promise.all([
      ledger(wallet.id, 1, first.nextCursor), submit(transaction(wallet, 'provider-a', 'concurrent-bet')),
    ]);
    const third = await ledger(wallet.id, 1, second.nextCursor);
    const fourth = await ledger(wallet.id, 1, third.nextCursor);
    const items = [first, second, third, fourth].flatMap((page) => page.items);
    expect(items.map(({ id }) => id)).toEqual(['a', 'c', 'b', 'z'].map((id) => `${wallet.id}:${id}`));
    expect(items.every((item) => item.walletId === wallet.id)).toBe(true);
    expect(fourth.nextCursor).toBeNull();
    expect((await ledger(wallet.id, 1)).items[0].transactionId).toBe(inserted.transactionId);
    expect((await ledger(other.id)).items).toHaveLength(1);
  });

  test('enforces the default page size and returns the entire remaining page', async () => {
    const wallet = await open('0.00');
    await seedLedger(wallet, Array.from({ length: 51 }, (_, index) => ({
      id: String(index).padStart(2, '0'), at: '2020-01-01T00:00:00.000000Z',
    })));
    const first = await ledger(wallet.id);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBeString();
    const second = await ledger(wallet.id, 100, first.nextCursor);
    expect(second.items.map(({ id }) => id)).toEqual([`${wallet.id}:00`]);
    expect(second.nextCursor).toBeNull();
    expect((await ledger(wallet.id, 100)).items).toHaveLength(51);
  });

  test('rejects tampered, repeated and cross-wallet cursors, even with an anchor ID from another wallet', async () => {
    const wallet = await open();
    const other = await open();
    await submit(transaction(wallet, 'provider-a', 'cursor-bet'));
    const page = await ledger(wallet.id, 1);
    const cursor = page.nextCursor!;
    const [payload, signature] = cursor.split('.');
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    const otherAnchor = (await ledger(other.id)).items[0].id;
    const wrongAnchor = encodeLedgerCursor(wallet.id, otherAnchor);
    for (const [walletId, query] of [
      [wallet.id, `cursor=${payload}.${tamperedSignature}`],
      [wallet.id, `cursor=${cursor}&cursor=${cursor}`],
      [wallet.id, `cursor=${wrongAnchor}`],
      [other.id, `cursor=${cursor}`],
    ]) {
      expect((await get(`/wallets/${walletId}/ledger?${query}`)).status).toBe(400);
    }
  });

  test('continues a ledger page on another HTTP instance sharing the signing key', async () => {
    const wallet = await open();
    await submit(transaction(wallet, 'provider-a', 'shared-cursor-bet'));
    const first = await ledger(wallet.id, 1);
    expect(first.nextCursor).toBeString();
    const sameInstance = await ledger(wallet.id, 1, first.nextCursor);

    const peer = await createWalletApp(financialTestConfig(databaseUrl!, schema));
    try {
      await peer.listen(0, '127.0.0.1');
      const query = new URLSearchParams({ limit: '1', cursor: first.nextCursor! });
      const response = await fetch(`${await peer.getUrl()}/wallets/${wallet.id}/ledger?${query}`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(sameInstance);
    } finally {
      await peer.close();
    }
  });

  test('repeated GETs leave all financial tables, Inbox and Outbox unchanged', async () => {
    const wallet = await open();
    const { transactionId } = await submit(transaction(wallet, 'provider-a', 'readonly'));
    async function snapshot() {
      return Promise.all(['wallets', 'wallet_ledger_entries', 'wager_transactions', 'inbox_messages', 'outbox_messages'].map(
        (table) => orm.em.execute(`SELECT to_jsonb(row) AS data FROM "${schema}"."${table}" AS row ORDER BY to_jsonb(row)::text`),
      ));
    }
    const before = await snapshot();
    const paths = [`/wallets/${wallet.id}`, `/wallets/${wallet.id}/ledger`,
      `/wagering/transactions/${transactionId}`, externalPath('provider-a', 'readonly')];
    const responses = await Promise.all([...paths, ...paths].map(get));
    expect(responses.map(({ status }) => status)).toEqual(Array(8).fill(200));
    expect(await snapshot()).toEqual(before);
  });

  test('returns 503 for an unavailable database and 500 for unexpected read errors', async () => {
    const config = financialTestConfig(databaseUrl!, schema);
    const unavailable = await createWalletApp({ ...config, host: '127.0.0.1', port: 1 });
    try {
      await unavailable.listen(0, '127.0.0.1');
      const response = await fetch(`${await unavailable.getUrl()}/wallets/any`, { signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ message: 'Financial queries are temporarily unavailable.' });
    } finally {
      await unavailable.close();
    }

    const now = new Date();
    await orm.em.fork().insert(WalletRecord, {
      id: 'invalid-currency', playerId: 'invalid-currency', balance: '0.00', currency: 'ZZZ', createdAt: now, updatedAt: now,
    });
    const response = await get('/wallets/invalid-currency');
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: 'Internal server error' });
  });

  test('returns 503 when an established PostgreSQL connection closes without a server error', async () => {
    const wallet = await open();
    const config = financialTestConfig(databaseUrl!, schema);
    const sockets = new Set<Socket>();
    let dropNextQuery = false;
    let closedConnections = 0;
    const relay = createServer((client) => {
      sockets.add(client);
      const upstream = createConnection({ host: config.host, port: config.port });
      upstream.pipe(client);
      client.on('data', (chunk) => {
        if (dropNextQuery) {
          dropNextQuery = false;
          closedConnections++;
          // Send TCP EOF instead of a PostgreSQL ErrorResponse with a SQLSTATE.
          upstream.unpipe(client);
          client.end();
          upstream.destroy();
        } else {
          upstream.write(chunk);
        }
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.once('close', () => {
        sockets.delete(client);
        upstream.destroy();
      });
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    let throughRelay: INestApplication | undefined;
    try {
      const { port } = relay.address() as AddressInfo;
      throughRelay = await createWalletApp({ ...config, host: '127.0.0.1', port });
      await throughRelay.listen(0, '127.0.0.1');
      const target = `${await throughRelay.getUrl()}/wallets/${wallet.id}`;
      const readWallet = () => fetch(target, { signal: AbortSignal.timeout(3000) });
      const before = await readWallet();
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual(wallet);
      expect(sockets.size).toBe(1);

      dropNextQuery = true;
      const interrupted = await readWallet();
      expect(closedConnections).toBe(1);
      expect(interrupted.status).toBe(503);
      expect(await interrupted.json()).toMatchObject({ message: 'Financial queries are temporarily unavailable.' });

      const recovered = await readWallet();
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual(wallet);
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        throughRelay?.close(),
        new Promise<void>((resolve, reject) => relay.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });
});
