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
| [`src/infrastructure/database`](../src/infrastructure/database) | Transações, mapeadores, registros, seis migrations explícitas e worker de referências |
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
| 15 | Consultas HTTP de wallet, ledger paginado e transações por ID interno ou identidade do provedor |
| 16 | Reconciliação financeira por wallet em um único snapshot, com log e métrica de divergência |
| 17 | Readiness de PostgreSQL e SQS, logs correlacionados e métricas de processamento |
| 18 | Recuperação do consumidor após `SIGKILL` entre commit e ACK, com reentrega real e consistência comprovada |

## Fluxos e garantias atuais

- **HTTP.** `POST /wallets` abre a wallet. `POST /wagering/transactions` exige `Idempotency-Key` e distingue entrada inválida, conflito, rejeição de negócio, referência pendente e indisponibilidade. `GET /health/live` verifica a API. `OPENING` só é criado internamente.
- **Transação financeira.** `PostgresWagerStore` usa `SELECT … FOR UPDATE` na wallet e persiste decisão, saldo, ledger e Outbox no mesmo commit. Wallets diferentes podem progredir em paralelo. O índice reserva estornos por provedor, wallet, referência externa e tipo. A proteção entre `REFUND` e `ROLLBACK` é avaliada sob o lock da wallet. O trigger do ledger impede `UPDATE`, `DELETE` e `TRUNCATE`.
- **Replay.** O provedor delimita a unicidade da chave e do ID externo. O hash SHA-256 canônico dos campos de negócio detecta divergência entre HTTP e SQS. A operação gravada fornece o resultado e o saldo originalmente observado quando aplicável. O algoritmo e a política de compensação estão no `ARCHITECTURE.md`.
- **SQS e Inbox.** `wager-transactions.fifo` usa redrive para `wager-transactions-dlq.fifo` após cinco recebimentos. O consumidor reutiliza `SubmitWager`. A chave `(consumer_name, message_id)`, o hash do envelope e a conclusão ficam na mesma transação dos efeitos. O ACK ocorre depois do commit, inclusive para rejeições persistidas e referências pendentes. Falhas transitórias usam backoff de visibilidade e falhas permanentes seguem para a DLQ.
- **Outbox.** O publicador lê eventos confirmados com `FOR UPDATE SKIP LOCKED`, seleciona o primeiro evento por agregado e publica o envelope em `wagering-events.fifo`. São emitidos `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` conforme o resultado. O publicador grava sucesso após o ACK do broker e persiste os retries. `aggregateId` ordena o grupo e `eventId` é estável para deduplicação.
- **Referências pendentes.** O worker reavalia `WIN`, `REFUND` e `ROLLBACK` sob lock da wallet, com retry persistente de 5 segundos a 5 minutos e prazo de 24 horas. O desfecho fica na operação original e é publicado pela Outbox.
- **Consultas HTTP.** Os quatro GETs do README §9 leem dados confirmados no PostgreSQL. O ledger usa cursor assinado, vinculado à wallet, e o DTO da transação distingue o saldo observado do saldo atual. A inicialização HTTP exige `LEDGER_CURSOR_SECRET` com 64 caracteres hexadecimais. Use o mesmo valor em todas as instâncias. Falhas transitórias conhecidas de conexão e do pool geram `503`.
- **Reconciliação.** `POST /wallets/:walletId/reconciliation` compara o saldo materializado com a soma assinada do ledger em uma única instrução SQL. Divergências aparecem na resposta, em log estruturado e no contador local exposto em `GET /metrics`. A operação preserva os dados financeiros.
- **Readiness e observabilidade.** `GET /health/live` é independente das dependências e `GET /health/ready` exige PostgreSQL e as três filas SQS acessíveis. A API expõe as métricas de estado compartilhado e cada processo expõe seus contadores e latência. Os logs usam os identificadores disponíveis em cada etapa. Consulte a configuração dos listeners e a agregação em [ARCHITECTURE.md](../ARCHITECTURE.md).

## Execução e validação

O [roteiro de execução local no README](../README.md#execução-local-da-solução) concentra o setup, os comandos, a verificação funcional e a execução da suíte completa. Os resultados abaixo registram os checkpoints de implementação.

A validação do checkpoint do Bloco 13 obteve 137 aprovações em 10 arquivos, com 65 testes de integração que acessam PostgreSQL, dos quais 17 também acessam LocalStack. A suíte verifica aplicação, reversão e reaplicação das migrations, 50 submissões simultâneas em três instâncias, disputa de saldo, independência entre wallets, redelivery, DLQ, falhas no commit e concorrência de publicadores. As falhas são injetadas em pontos controlados e os efeitos são verificados nos serviços reais.

O Bloco 14 acrescentou 13 testes de integração com PostgreSQL. A suíte completa passou com 150 testes em 11 arquivos, incluindo os cenários com LocalStack. Os testes do worker cobrem resolução tardia, cadeias, retry, fronteira do TTL, ordem de seleção sob backlog, concorrência, progresso entre ciclos com falha persistente, retomada após falha no commit, replay terminal, consistência do ledger e ordem do desfecho na Outbox.

O Bloco 15 acrescentou 13 testes, 11 de integração HTTP com PostgreSQL e dois de inicialização do processo HTTP. A suíte completa passou com 163 testes em 12 arquivos, incluindo os cenários com LocalStack. Os testes cobrem as quatro rotas, estados e precisão monetária, isolamento de wallet e provedor, paginação e assinatura do cursor, ausência de efeitos colaterais, rejeição de chave ausente ou inválida, continuidade de página entre instâncias e recuperação de uma desconexão do PostgreSQL sem SQLSTATE.

O Bloco 16 acrescentou oito testes HTTP com PostgreSQL. A suíte completa passou com 171 testes em 13 arquivos, incluindo os cenários com LocalStack. Os testes de reconciliação cobrem operações financeiras, valores extremos, divergências dos dois sinais, commit e rollback concorrentes, contagem e logs por instância, ausência de alterações nas tabelas e tratamento de erros HTTP.

O Bloco 17 acrescentou quatro testes e ampliou as asserções dos workers existentes. A validação focada passou com 35 testes em seis arquivos e a suíte completa passou com 175 testes em 15 arquivos, sem falhas. A cobertura verifica recuperação da readiness, métricas por processo, profundidade da DLQ, conflito de lock no PostgreSQL e logs correlacionados sem payloads sensíveis.

O Bloco 18 acrescentou um teste de recuperação com dois processos consumidores, PostgreSQL e LocalStack reais. O primeiro processo é encerrado por `SIGKILL` após o commit e antes do envio de `DeleteMessage`. O segundo faz ACK da reentrega sem repetir os efeitos financeiros. A suíte focada de SQS passou com 10 testes em dois arquivos e a suíte completa passou com 176 testes em 16 arquivos, sem falhas.

## Correções C1 e C2 da auditoria

- **C1 — Progresso de retries da Outbox.** Antes da correção, dois publishers com lotes de um entregaram seis eventos novos em três rodadas. A cabeça vencida permaneceu com uma tentativa e o sucessor com zero. A seleção passou a ordenar pelo horário efetivo de elegibilidade. O mesmo teste confirmou a entrega da cabeça e depois do sucessor, com duas tentativas acumuladas na cabeça e uma no sucessor.
- **C2 — Imutabilidade de transações no PostgreSQL.** Antes da correção, o SQL reatribuiu um `REFUND` processado a outra aposta compatível. O novo `REFUND` da primeira aposta retornou `200` e elevou o saldo de `80.00` para `100.00`. Com `WagerImmutability`, o PostgreSQL rejeita o `UPDATE` com `55000`, e a segunda compensação retorna `409 DUPLICATE_REFUND`, preservando saldo, versão, ledger e Outbox. Os testes também verificam os três estados terminais, as transições de pendências, o agendamento e a reversão e reaplicação da migration.

A execução anterior às correções registrou duas falhas nos dois testes de reprodução. Após as mudanças, a execução focada com PostgreSQL e LocalStack aprovou 17 testes em quatro arquivos, incluindo os 13 testes do worker de referências. A suíte completa aprovou 180 testes em 16 arquivos, com zero falhas. `bun run typecheck`, `bun run build` e `git diff --check` também passaram.

## Correção C3 da auditoria

Uma aposta HTTP com U+FFFE no ID externo foi processada e debitou `20.00`. O corpo JSON do evento persistido violava as faixas de Unicode de `SendMessage`. Uma chamada isolada ao LocalStack também retornou `InvalidMessageContents` para U+FFFE literal.

A validação compartilhada rejeita U+FFFE e U+FFFF nos campos livres copiados para os eventos. O teste verifica a rejeição HTTP e o redrive para a DLQ de uma mensagem com escape JSON, preservando saldo, versão, transações, ledger e Outbox, sem gravar a Inbox. A abertura de wallet rejeita esses caracteres no ID do jogador. O teste de entrada válida confirma identidade, hash, evento e replay entre HTTP e SQS. Se já houver eventos incompatíveis gravados antes da correção, eles ainda exigem intervenção operacional.

A regressão falhou antes da correção. Depois, os dois testes focados e os 182 testes da suíte completa com PostgreSQL e LocalStack passaram, sem falhas. `bun run typecheck`, `bun run build` e `git diff --check` também passaram.

## Correção I1 da auditoria

Antes da correção, uma reserva pendente em A fazia as duas compensações concorrentes em B retornarem `409`, tanto para `REFUND` quanto para `ROLLBACK`. O `REFUND` via SQS chegava à DLQ como `DUPLICATE_REFUND`, sem Inbox confirmada.

A nova migration inclui a wallet no índice de reservas. Nas duas corridas, uma compensação válida foi aplicada em B e a duplicata recebeu `409`. O worker rejeitou a pendência em A com `INVALID_REFERENCE`, preservando saldo e ledger. O teste SQS recupera o corpo da DLQ após aplicar a migration e confirma que a reentrega após falha de ACK não repete os efeitos. Mensagens que já chegaram à DLQ exigem reenvio operacional.

Três cenários falharam na reprodução antes da correção. Depois, passaram os 72 testes focados e os 186 testes da suíte completa com PostgreSQL e LocalStack, sem falhas. `bun run typecheck`, `bun run build` e `git diff --check` também passaram.

## Correções I2 e I4 da auditoria

- **I2.** A abertura devolvia `500` ao perder a conexão PostgreSQL no commit ou no início da transação sem SQLSTATE. Com o classificador de escrita compartilhado, devolve `503`. O teste de desconexão no commit confirma o rollback e duas tentativas de recuperação concorrentes, com `201` e `409`, uma abertura, um lançamento e dois eventos. O teste de falha SQL inesperada continua verificando `500`.
- **I4.** Wallet, transações, ledger, Inbox e Outbox usam o relógio do PostgreSQL para os marcos persistentes. Os testes com relógios de aplicação adiantados e atrasados em dois dias confirmam timestamps de abertura, criação e resolução de pendências e a elegibilidade de retries entre instâncias. O TTL de 24 horas e os backoffs permanecem os mesmos. Timestamps gravados antes da correção conservam os valores históricos.

**I3.** O README §6.3 exige que `FAILED` seja terminal e auditável. Os cenários de execução obrigatórios não especificam um caso que deva gravá-lo. O §7.1 exige `REJECTED` para referência expirada, e o §10 distingue rejeição de negócio com ACK após commit, falha permanente de entrega com DLQ e falha transitória com retry. O modelo e o schema continuam suportando `FAILED`.

A validação final com PostgreSQL e LocalStack aprovou 57 testes focados e 188 testes na suíte completa, com zero falhas. `bun run typecheck`, `bun run build` e `git diff --check` passaram.

## Entrega e validação em ambiente limpo (I5)

O README §14 pede setup e comandos no README e decisões, trade-offs e limitações no ARCHITECTURE. O roteiro foi acrescentado ao final do README, preservando o texto do desafio. Ele inclui geração local dos segredos, Compose, migrations, inicialização, verificações HTTP e SQS e execução da suíte completa.

A validação usou uma cópia dos arquivos atuais, incluindo as alterações locais, sem `node_modules`, `dist` ou `.env` preexistentes. O Bun 1.4.4 instalou o lockfile com cache vazio. Docker 29.9.2 e Compose 5.6.1 subiram PostgreSQL 17.11 e LocalStack 4.4.0 em um projeto separado. O banco começou com zero migrations aplicadas e terminou com seis aplicadas e zero pendentes. O LocalStack provisionou as três filas FIFO.

Os quatro processos iniciaram pelos comandos do `package.json`. Liveness, readiness e métricas da API e dos três workers responderam com sucesso. A aposta HTTP de `25.00 BRL` sobre `100.00 BRL` retornou `PROCESSED`. O saldo e o ledger reconciliaram em `75.00 BRL` com dois lançamentos e diferença zero. No caminho SQS, um `REFUND` chegou antes da `BET`, ficou pendente e foi resolvido pelo worker quando a referência apareceu. A reconciliação final manteve `75.00 BRL` com quatro lançamentos. A Outbox registrou nove publicações confirmadas. Os dois eventos da aposta HTTP foram lidos na fila de saída.

O comando da suíte completa do roteiro aprovou 188 testes em 16 arquivos, com zero falhas. `bun run typecheck`, `bun run build` e `git diff --check` passaram. O checkout original foi conferido com `git status --short`.

## Limitações operacionais

- A migration `OutboxPublication` reordena as linhas existentes. Aplique-a antes de subir publicadores e considere o volume da Outbox na janela de migration.
- A publicação oferece entrega *at-least-once*. Consumidores de eventos devem deduplicar por `eventId` após a janela de deduplicação do FIFO. Uma falha permanente na cabeça de um agregado bloqueia seus sucessores até intervenção operacional.
- O publicador mantém locks da Outbox durante o envio com timeout. Dimensione lote e conexões separadamente da API ao medir atraso e recuperação.
