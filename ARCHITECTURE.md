# Persistência financeira

## PostgreSQL e MikroORM

O MikroORM 7.2 usa o driver PostgreSQL e registros próprios de infraestrutura. Os mapeadores escrevem valores de `Money` como strings decimais em colunas `NUMERIC(20,2)` e usam `Money.rehydrate` na leitura. O tipo do ORM compara strings e rejeita conversões de valores numéricos do JavaScript. IDs são textos opacos para preservar o contrato do domínio. As referências relacionais são colunas escalares no ORM, com foreign keys declaradas na migration.

O SQL versionado é a fonte do schema, incluindo índices parciais, constraints compostas e o trigger do ledger. A lista explícita de migrations evita depender da descoberta de arquivos ou de um loader adicional para executar os comandos com Bun.

```sh
bun run migration:status
bun run migration:up
bun run migration:down
```

Os comandos usam as variáveis `POSTGRES_*` do ambiente. `status` mostra migrations aplicadas e pendentes e pode inicializar a tabela de controle. `down` reverte a última migration aplicada. Reverter a primeira migration remove as três tabelas financeiras e seus dados.

## Garantias e fronteira transacional

- O PostgreSQL garante unicidade por jogador e moeda, e por provedor e chave de idempotência ou ID externo. A referência resolvida precisa corresponder ao provedor, ID externo, wallet e rodada. A FK da wallet garante o mesmo jogador e a mesma moeda.
- O índice de reversão usa a referência externa e o tipo, com escopo por provedor. Operações pendentes e processadas reservam a referência. Uma rejeição ou falha permanente libera a reserva, pois essa tentativa não aplicou a reversão. `REFUND` e `ROLLBACK` têm reservas distintas, conforme a unicidade por tipo do README.
- O ledger valida a aritmética de cada linha e só aceita vínculo com uma transação processada da mesma wallet, moeda e valor. `ledger_amount` é uma coluna gerada usada por essa FK. O trigger impede `UPDATE`, `DELETE` e `TRUNCATE`.
- As futuras movimentações de wallets existentes devem obter lock por wallet e persistir a transação processada, o saldo e o lançamento de forma atômica. O schema valida cada lançamento. A continuidade entre lançamentos e a igualdade do saldo materializado com o ledger serão verificadas pelo processamento e pela reconciliação. O agendamento de referências fica para o worker. A migration só fornece contador, data de próxima tentativa e índice.
- A escala do SQL é fixa. O PostgreSQL pode arredondar um literal SQL de escala maior antes de avaliar os `CHECK`s. Os mapeadores recebem `Money`, que já rejeita entradas com escala diferente de duas casas. O banco verifica o formato de três letras da moeda, e `Money` valida o código.

## Testes com PostgreSQL real

Execute a suíte de integração com uma URL para um banco descartável cujo nome termine em `_test`. A suíte cria e remove apenas um schema próprio com nome aleatório.

```sh
FINANCIAL_TEST_DATABASE_URL='postgresql://usuario:senha@127.0.0.1:5432/jungle_test' \
  bun test test/integration
```

Sem `FINANCIAL_TEST_DATABASE_URL`, `bun test` pula os testes de integração PostgreSQL.

## Abertura de wallet e Outbox

`POST /wallets` recebe `playerId` como string opaca não vazia, pois o README usa UUID como exemplo e mantém o tipo `string`. A moeda e a escala são validadas por `Money`. O endpoint retorna `201` com a wallet na versão `1`, `400` para entrada inválida e `409` para conflito na constraint `wallets_player_currency_unique`.

Uma abertura positiva usa UUIDs internos para wallet, transação, lançamento e eventos. `OPENING` usa o provedor reservado `internal:wallet-opening`, `opening:<walletId>` para ID externo, chave de idempotência e rodada, e `wallet-opening` para jogo. O hash interno é SHA-256 do JSON com `walletId`, `playerId`, `kind` e `money` nessa ordem. A unicidade por jogador e moeda resolve disputas de abertura no banco. O adaptador grava wallet, transação, ledger e Outbox em uma única transação PostgreSQL via MikroORM.

Uma abertura positiva persiste `WagerTransactionProcessed` e `WalletBalanceChanged` na versão `1`. O primeiro tem a transação como agregado e o segundo tem a wallet. Ambos usam o ID da wallet como correlação, e `WalletBalanceChanged` usa o ID de `OPENING` como causa. O ID da linha da Outbox coincide com `eventId` no envelope JSONB, que inclui os metadados oficiais. Abertura com saldo zero grava apenas a wallet na versão `1`.

O índice parcial de eventos pendentes ordena por `next_attempt_at NULLS FIRST`, `occurred_at` e `id`. Um próximo horário nulo representa disponibilidade imediata. A estrutura permite que futuros publicadores coordenem seleção por locks de linha e `FOR UPDATE SKIP LOCKED`. A segunda migration reverte apenas `outbox_messages` e seu índice.

## Submissão de operações financeiras

`POST /wagering/transactions` recebe a chave pelo header `Idempotency-Key`. O hash é SHA-256 do JSON com as chaves de negócio em ordem lexicográfica fixa (`externalTransactionId`, `gameId`, `kind`, `money` com `amount` e `currency`, `playerId`, `providerId`, `referenceExternalTransactionId` quando informado, `roundId` e `walletId`). A ausência de referência preserva o hash de `BET` anterior. `Money` fornece o valor decimal normalizado. Header e metadados de transporte ficam fora do hash. A mesma chave e o mesmo conteúdo devolvem o resultado gravado, incluindo saldo e código de falha quando aplicável. Um ID externo já associado a outra chave, ou uma chave já associada a outro payload, retorna `409`.

A transação usa `PESSIMISTIC_WRITE` (`SELECT … FOR UPDATE`) sobre a linha da wallet. O adaptador consulta a identidade antes do lock e novamente após obtê-lo. As constraints por provedor arbitram colisões que envolvem wallets distintas. Em caso de violação dessas constraints, a transação perdedora é revertida antes de consultar o resultado vencedor. `BET` gera `DEBIT`, e `WIN` e `REFUND` geram `CREDIT`. Cada movimentação persiste `WagerTransactionProcessed` e `WalletBalanceChanged` no mesmo commit. `LOSS` registra o saldo observado sob o mesmo lock e persiste apenas `WagerTransactionProcessed`, mantendo saldo e versão da wallet. O valor de `LOSS` pode ser zero ou positivo porque é informativo. Rejeições persistem a decisão, o saldo observado e `WagerTransactionRejected` sem lançamento ou mudança de saldo.

O endpoint retorna `200` para operação processada, `202` para referência pendente, `422` para rejeição de negócio, `409` para conflito de identidade ou reserva de estorno, `400` para entrada inválida ou wallet incompatível e `503` para falhas transitórias identificadas. Wallet ausente, jogador divergente ou moeda divergente tornam a submissão inválida antes de reservar a identidade. `BET`, `WIN` e `REFUND` exigem valor positivo para gerar o lançamento previsto no ledger. Um crédito que excederia o limite monetário da wallet é rejeitado com `BALANCE_LIMIT_EXCEEDED`. A identidade `internal:wallet-opening` é reservada para abertura. Os eventos usam o ID da transação como correlação.

Uma `WIN` sem referência pode ser aplicada imediatamente. Uma referência informada é buscada por provedor e ID externo. O tipo deve ser `BET`, com o mesmo jogador, wallet, moeda e rodada. O prêmio pode ter valor diferente da aposta. A ausência da `BET` ou um estado não terminal mantém a `WIN` em `PENDING_REFERENCE`, com o ID externo, os controles existentes de reprocessamento e o evento `WagerTransactionPendingReference`. O replay de uma `WIN` ainda pendente devolve `202` e o mesmo ID, mesmo após a chegada da `BET`. Uma referência incompatível é rejeitada com `INVALID_REFERENCE`. Uma `BET` terminal rejeitada ou falha gera `REFERENCE_NOT_PROCESSED`, pois o estado terminal impede que ela venha a ser processada.

`REFUND` exige a referência e usa as mesmas validações de escopo e estado. Seu valor deve ser exatamente o da `BET`. Quando a aposta já existe e o valor diverge, `REFERENCE_AMOUNT_MISMATCH` encerra a tentativa, inclusive se a aposta ainda estiver pendente, pois o valor é imutável. Quando a aposta está ausente ou pendente e a referência permanece elegível, o `REFUND` registra `PENDING_REFERENCE` e `WagerTransactionPendingReference` sem crédito. Uma aposta que chega depois será tratada pelo futuro reprocessamento. O estorno processado acrescenta um `CREDIT` e preserva o `DEBIT` original.

O índice `wager_reversal_reference_unique` reserva cada referência por provedor e tipo. Um `REFUND` pendente bloqueia outro `REFUND` distinto mesmo após a chegada da aposta. Se o banco acusar conflito, o adaptador reverte a tentativa e consulta a identidade para distinguir replay de `409 DUPLICATE_REFUND`. Esse `409` não cria transação ou evento. Rejeições de negócio continuam auditáveis e não ocupam a reserva.

`ROLLBACK` exige o valor integral de uma `BET`, `WIN` ou `REFUND` processada. Ele gera `CREDIT` para `BET` e `DEBIT` para `WIN` ou `REFUND`. Um débito de reversão sem saldo suficiente registra `REVERSAL_INSUFFICIENT_FUNDS` e `WagerTransactionRejected`, preservando saldo, versão e ledger. A referência ausente ou pendente elegível produz `202`, `PENDING_REFERENCE` e `WagerTransactionPendingReference`. Replays pendentes mantêm o resultado armazenado até o futuro reprocessamento. Um segundo `ROLLBACK` distinto sobre o mesmo alvo usa o índice por tipo e retorna `409 DUPLICATE_ROLLBACK`.

### Compensação de BET

O índice por tipo continua garantindo unicidade separada para `REFUND` e `ROLLBACK`. Para evitar dois créditos sobre a mesma `BET`, ambos os fluxos verificam a reversão do outro tipo **depois** de obter `SELECT FOR UPDATE` na wallet, na mesma transação e em `READ COMMITTED`. Isso garante que a segunda operação veja o resultado confirmado pela primeira. Uma reversão pendente reserva a compensação no mesmo provedor, wallet, rodada e referência externa. Se o alvo ainda é desconhecido, os dois tipos competem por essa reserva, pois o alvo pode ser uma `BET`. Se o alvo é conhecido e é `WIN` ou `REFUND`, seu `ROLLBACK` não compete pela compensação de `BET`. Uma compensação pendente ou efetiva do outro tipo gera `422 BET_COMPENSATION_CONFLICT` com rejeição auditável.

Um `REFUND` processado continua sendo uma compensação efetiva até um `ROLLBACK(REFUND)` processado debitar seu valor. Um `ROLLBACK(REFUND)` pendente ou rejeitado mantém a compensação ativa. Depois que o crédito é desfeito, um `ROLLBACK(BET)` direto pode creditar a aposta uma vez. O índice por tipo continua reservando o `REFUND` original para fins de unicidade, preservando seu histórico e replay. O futuro reprocessamento de referências pendentes terá de repetir a verificação sob o mesmo lock antes de creditar a wallet.
