# Continuidade da implementação

## Objetivo e contratos

O desafio da Jungle Gaming é processar operações de apostas de vários provedores com entrega *at-least-once*, referências fora de ordem e múltiplas instâncias. O [README oficial](../README.md) define os contratos e critérios de avaliação. O [ARCHITECTURE.md](../ARCHITECTURE.md) registra as escolhas e os detalhes de implementação.

Preserve dinheiro exato, saldo não negativo, ledger imutável e ausência de débito ou crédito duplicado. A consistência depende das constraints e dos locks do PostgreSQL. Os eventos só podem chegar ao broker após o commit financeiro. Use migrations versionadas e reversíveis.

## Stack e mapa do código

O projeto é um monólito modular em Bun 1.x, NestJS e TypeScript strict. O build usa `tsc` para emitir decorators e metadados e roda com Bun. MikroORM separa registros SQL das entidades de domínio. `Money` usa `decimal.js` e trafega como string decimal até as colunas `NUMERIC(20,2)`. O Compose fornece PostgreSQL 17 e SQS via LocalStack 4.4.0.

| Local | Responsabilidade |
| --- | --- |
| [`src/domain`](../src/domain) | `Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction` e envelopes de integração versionados |
| [`src/application`](../src/application) | `OpenWallet`, `SubmitWager` e validação de entrada compartilhada |
| [`src/infrastructure/database`](../src/infrastructure/database) | Transações, mapeadores, registros, quatro migrations explícitas e worker de referências |
| [`src/infrastructure/http`](../src/infrastructure/http) | Controllers e composição NestJS da API |
| [`src/infrastructure/sqs`](../src/infrastructure/sqs) | Consumidor e publicador, com pontos de entrada independentes |
| [`infra/localstack`](../infra/localstack) e [`test`](../test) | Provisionamento local das filas e testes de domínio, HTTP e integração |

## Blocos concluídos

| Bloco | Estado verificado |
| --- | --- |
| 01 | Infraestrutura, configuração PostgreSQL e `GET /health/live` |
| 02 | `Money` imutável, com validação de moeda, escala e limites |
| 03 | `Wallet` com saldo encapsulado, crédito, débito, versão e reidratação |
| 04 | Ledger imutável, com direção e aritmética validadas |
| 05 | `WagerTransaction` com estados, referências e resultado observado |
| 06 | Schema financeiro reversível, constraints, trigger de imutabilidade e mapeamentos |
| 07 | `POST /wallets`, `OPENING` interno para saldo inicial positivo e Outbox transacional |
| 08 | `BET` com débito, idempotência persistente e lock por wallet |
| 09 | `WIN` com crédito e referência opcional, `LOSS` sem movimentação |
| 10 | `REFUND` integral de `BET`, com reserva de reversão e referência pendente |
| 11 | `ROLLBACK` integral de `BET`, `WIN` ou `REFUND`, com proteção contra dupla compensação |
| 12 | Consumidor SQS, Inbox transacional, redelivery, DLQ e shutdown |
| 13 | Publicador Outbox concorrente, retry persistente e recuperação após falha |
| 14 | Worker de referências pendentes com retry persistente, TTL e desfecho transacional |

## Fluxos e garantias atuais

- **HTTP.** `POST /wallets` abre a wallet. `POST /wagering/transactions` exige `Idempotency-Key` e distingue entrada inválida, conflito, rejeição de negócio, referência pendente e indisponibilidade. `GET /health/live` verifica a API. `OPENING` só é criado internamente.
- **Transação financeira.** `PostgresWagerStore` usa `SELECT … FOR UPDATE` na wallet e persiste decisão, saldo, ledger e Outbox no mesmo commit. Wallets diferentes podem progredir em paralelo. O índice por tipo reserva estornos por referência, e a proteção entre `REFUND` e `ROLLBACK` é avaliada sob o lock da wallet. O trigger do ledger impede `UPDATE`, `DELETE` e `TRUNCATE`.
- **Replay.** O provedor delimita a unicidade da chave e do ID externo. O hash SHA-256 canônico dos campos de negócio detecta divergência entre HTTP e SQS. A operação gravada fornece o resultado e o saldo originalmente observado quando aplicável. O algoritmo e a política de compensação estão no `ARCHITECTURE.md`.
- **SQS e Inbox.** `wager-transactions.fifo` usa redrive para `wager-transactions-dlq.fifo` após cinco recebimentos. O consumidor reutiliza `SubmitWager`. A chave `(consumer_name, message_id)`, o hash do envelope e a conclusão ficam na mesma transação dos efeitos. O ACK ocorre depois do commit, inclusive para rejeições persistidas e referências pendentes. Falhas transitórias usam backoff de visibilidade e falhas permanentes seguem para a DLQ.
- **Outbox.** O publicador lê eventos confirmados com `FOR UPDATE SKIP LOCKED`, seleciona o primeiro evento por agregado e publica o envelope em `wagering-events.fifo`. São emitidos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` conforme o resultado. O publicador grava sucesso após o ACK do broker e persiste os retries. `aggregateId` ordena o grupo e `eventId` é estável para deduplicação.
- **Referências pendentes.** O worker reavalia `WIN`, `REFUND` e `ROLLBACK` sob lock da wallet, com retry persistente de 5 segundos a 5 minutos e prazo de 24 horas. O desfecho fica na operação original e é publicado pela Outbox.

## Execução e validação

Para executar a aplicação localmente, copie `.env.example` para `.env`, defina a senha local, execute `bun install --frozen-lockfile` e `docker compose up -d --wait`. Rode `bun run migration:status`, `bun run migration:up` e `bun run build`. Inicie os processos necessários em terminais separados com `bun run start`, `bun run sqs:consume`, `bun run outbox:publish` e `bun run references:process`. `bun run migration:down` reverte a última migration aplicada e deve ser exercitado em ambiente descartável.

Para reproduzir a validação completa a partir da raiz, use um projeto Compose separado e portas locais livres. O exemplo usa as credenciais de demonstração do `.env.example` para o ambiente descartável.

```sh
bun run typecheck
bun run build
docker compose --env-file .env.example config --quiet

export POSTGRES_PORT=15434 LOCALSTACK_PORT=14568 POSTGRES_DB=jungle_prepush_test
docker compose --env-file .env.example -p jungle-prepush-validation up -d --wait
FINANCIAL_TEST_DATABASE_URL='postgresql://jungle:replace-with-a-local-password@127.0.0.1:15434/jungle_prepush_test' \
  FINANCIAL_TEST_SQS_ENDPOINT='http://127.0.0.1:14568' bun test
docker compose --env-file .env.example -p jungle-prepush-validation down --volumes
unset POSTGRES_PORT LOCALSTACK_PORT POSTGRES_DB
```

Use um banco que termine em `_test` e um endpoint LocalStack HTTP em loopback. As suítes criam schemas e filas exclusivos. Sem a URL do banco, os testes financeiros de integração são pulados. Sem o endpoint SQS, as suítes de Inbox e publisher também são puladas.

A validação do checkpoint do Bloco 13 obteve 137 aprovações em 10 arquivos, com 65 testes de integração que acessam PostgreSQL, dos quais 17 também acessam LocalStack. A suíte verifica aplicação, reversão e reaplicação das migrations, 50 submissões simultâneas em três instâncias, disputa de saldo, independência entre wallets, redelivery, DLQ, falhas no commit e concorrência de publicadores. As falhas são injetadas em pontos controlados e os efeitos são verificados nos serviços reais.

O Bloco 14 acrescentou 13 testes de integração com PostgreSQL. A suíte completa passou com 150 testes em 11 arquivos, incluindo os cenários com LocalStack. Os testes do worker cobrem resolução tardia, cadeias, retry, fronteira do TTL, ordem de seleção sob backlog, concorrência, progresso entre ciclos com falha persistente, retomada após falha no commit, replay terminal, consistência do ledger e ordem do desfecho na Outbox.

## Pendências e ordem de retomada

1. **Consultas HTTP e reconciliação.** Implemente `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger` com cursor estável e opaco, `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`. Implemente `POST /wallets/:walletId/reconciliation` com leitura consistente do saldo e do ledger, resposta da divergência, log e métrica. O contrato exige preservar os dados e sinalizar diferenças para análise.
2. **Readiness e observabilidade.** Falta `GET /health/ready` com PostgreSQL e SQS, além das métricas oficiais de status, duplicatas, retries, DLQ, conflitos de lock, atraso da Outbox e latência. Consumidor e publisher já emitem logs JSON. Falta completar a correlação entre os transportes e os fluxos financeiros, mantendo payloads completos e segredos fora dos logs.
3. **Validação e entrega.** Complete a matriz do README, incluindo um cenário automatizado que mate o consumidor entre commit e ACK e reinicie em processo independente. A suíte atual valida a mesma fronteira com falha de ACK injetada e redelivery real. Verifique o saldo reconstruído pelo ledger nas novas suítes. Finalize setup, comandos e evidências de entrega. Se mantida a decisão de omitir autenticação, documente o desenho e explicite o ponto de extensão conforme o README §2.

## Limitações operacionais

- A migration `OutboxPublication` reordena as linhas existentes. Aplique-a antes de subir publicadores e considere o volume da Outbox na janela de migration.
- A publicação oferece entrega *at-least-once*. Consumidores de eventos devem deduplicar por `eventId` após a janela de deduplicação do FIFO. Uma falha permanente na cabeça de um agregado bloqueia seus sucessores até intervenção operacional.
- O publicador mantém locks da Outbox durante o envio com timeout. Dimensione lote e conexões separadamente da API ao medir atraso e recuperação.
