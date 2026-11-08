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
- As movimentações obtêm lock por wallet e persistem a decisão, o saldo, o lançamento e a Outbox de forma atômica. O schema valida cada lançamento, e os testes de integração comparam o saldo materializado com o ledger. O schema financeiro fornece o contador, a data da próxima tentativa e o índice usados pelo worker de referências.
- A escala do SQL é fixa. O PostgreSQL pode arredondar um literal SQL de escala maior antes de avaliar os `CHECK`s. Os mapeadores recebem `Money`, que já rejeita entradas com escala diferente de duas casas. O banco verifica o formato de três letras da moeda, e `Money` valida o código.

## Testes com PostgreSQL real

Execute a suíte de integração com uma URL para um banco descartável cujo nome termine em `_test`. A suíte cria e remove apenas um schema próprio com nome aleatório.

```sh
FINANCIAL_TEST_DATABASE_URL='postgresql://usuario:senha@127.0.0.1:5432/jungle_test' \
  bun test test/integration
```

Sem `FINANCIAL_TEST_DATABASE_URL`, `bun test` pula os testes de integração PostgreSQL.

Para incluir os testes do consumidor, suba o Compose com o banco de testes e forneça também `FINANCIAL_TEST_SQS_ENDPOINT`, com a URL HTTP local do LocalStack. Essa suíte cria filas FIFO próprias, com nomes aleatórios, e remove somente essas filas. Os testes usam PostgreSQL e SQS reais. A falha de ACK é injetada no cliente antes do envio do `DeleteMessage`, e a reentrega vem do broker.

## Abertura de wallet e Outbox

`POST /wallets` recebe `playerId` como string opaca não vazia, pois o README usa UUID como exemplo e mantém o tipo `string`. A moeda e a escala são validadas por `Money`. O endpoint retorna `201` com a wallet na versão `1`, `400` para entrada inválida e `409` para conflito na constraint `wallets_player_currency_unique`.

Uma abertura positiva usa UUIDs internos para wallet, transação, lançamento e eventos. `OPENING` usa o provedor reservado `internal:wallet-opening`, `opening:<walletId>` para ID externo, chave de idempotência e rodada, e `wallet-opening` para jogo. O hash interno é SHA-256 do JSON com `walletId`, `playerId`, `kind` e `money` nessa ordem. A unicidade por jogador e moeda resolve disputas de abertura no banco. O adaptador grava wallet, transação, ledger e Outbox em uma única transação PostgreSQL via MikroORM.

Uma abertura positiva persiste `WagerTransactionProcessed` e `WalletBalanceChanged` na versão `1`. O primeiro tem a transação como agregado e o segundo tem a wallet. Ambos usam o ID da wallet como correlação, e `WalletBalanceChanged` usa o ID de `OPENING` como causa. O ID da linha da Outbox coincide com `eventId` no envelope JSONB, que inclui os metadados oficiais. Abertura com saldo zero grava apenas a wallet na versão `1`.

O índice parcial de eventos pendentes ordena por `next_attempt_at NULLS FIRST`, `occurred_at` e `id`. Um próximo horário nulo representa disponibilidade imediata. O publicador coordena a seleção por locks de linha com `FOR UPDATE SKIP LOCKED`, como descrito na seção de publicação. A segunda migration reverte apenas `outbox_messages` e seu índice.

## Submissão de operações financeiras

`POST /wagering/transactions` recebe a chave pelo header `Idempotency-Key`. O hash é SHA-256 do JSON com as chaves de negócio em ordem lexicográfica fixa (`externalTransactionId`, `gameId`, `kind`, `money` com `amount` e `currency`, `playerId`, `providerId`, `referenceExternalTransactionId` quando informado, `roundId` e `walletId`). A ausência de referência preserva o hash de `BET` anterior. `Money` fornece o valor decimal normalizado. Header e metadados de transporte ficam fora do hash. A mesma chave e o mesmo conteúdo devolvem o resultado gravado, incluindo saldo e código de falha quando aplicável. Um ID externo já associado a outra chave, ou uma chave já associada a outro payload, retorna `409`.

A transação usa `PESSIMISTIC_WRITE` (`SELECT … FOR UPDATE`) sobre a linha da wallet. O adaptador consulta a identidade antes do lock e novamente após obtê-lo. As constraints por provedor arbitram colisões que envolvem wallets distintas. Em caso de violação dessas constraints, a transação perdedora é revertida antes de consultar o resultado vencedor. `BET` gera `DEBIT`, e `WIN` e `REFUND` geram `CREDIT`. Cada movimentação persiste `WagerTransactionProcessed` e `WalletBalanceChanged` no mesmo commit. `LOSS` registra o saldo observado sob o mesmo lock e persiste apenas `WagerTransactionProcessed`, mantendo saldo e versão da wallet. O valor de `LOSS` pode ser zero ou positivo porque é informativo. Rejeições persistem a decisão, o saldo observado e `WagerTransactionRejected` sem lançamento ou mudança de saldo.

O endpoint retorna `200` para operação processada, `202` para referência pendente, `422` para rejeição de negócio, `409` para conflito de identidade ou reserva de estorno, `400` para entrada inválida ou wallet incompatível e `503` para falhas transitórias identificadas. Wallet ausente, jogador divergente ou moeda divergente tornam a submissão inválida antes de reservar a identidade. `BET`, `WIN` e `REFUND` exigem valor positivo para gerar o lançamento previsto no ledger. Um crédito que excederia o limite monetário da wallet é rejeitado com `BALANCE_LIMIT_EXCEEDED`. A identidade `internal:wallet-opening` é reservada para abertura. Os eventos usam o ID da transação como correlação.

Uma `WIN` sem referência pode ser aplicada imediatamente. Uma referência informada é buscada por provedor e ID externo. O tipo deve ser `BET`, com o mesmo jogador, wallet, moeda e rodada. O prêmio pode ter valor diferente da aposta. A ausência da `BET` ou um estado não terminal mantém a `WIN` em `PENDING_REFERENCE`, com o ID externo, os controles existentes de reprocessamento e o evento `WagerTransactionPendingReference`. O replay de uma `WIN` ainda pendente devolve `202` e o mesmo ID, mesmo após a chegada da `BET`. Uma referência incompatível é rejeitada com `INVALID_REFERENCE`. Uma `BET` terminal rejeitada ou falha gera `REFERENCE_NOT_PROCESSED`, pois o estado terminal impede que ela venha a ser processada.

`REFUND` exige a referência e usa as mesmas validações de escopo e estado. Seu valor deve ser exatamente o da `BET`. Quando a aposta já existe e o valor diverge, `REFERENCE_AMOUNT_MISMATCH` encerra a tentativa, inclusive se a aposta ainda estiver pendente, pois o valor é imutável. Quando a aposta está ausente ou pendente e a referência permanece elegível, o `REFUND` registra `PENDING_REFERENCE` e `WagerTransactionPendingReference` sem crédito. O worker retoma a pendência quando a aposta chega e a próxima tentativa vence. O estorno processado acrescenta um `CREDIT` e preserva o `DEBIT` original.

O índice `wager_reversal_reference_unique` reserva cada referência por provedor e tipo. Um `REFUND` pendente bloqueia outro `REFUND` distinto mesmo após a chegada da aposta. Se o banco acusar conflito, o adaptador reverte a tentativa e consulta a identidade para distinguir replay de `409 DUPLICATE_REFUND`. Esse `409` não cria transação ou evento. Rejeições de negócio continuam auditáveis e não ocupam a reserva.

`ROLLBACK` exige o valor integral de uma `BET`, `WIN` ou `REFUND` processada. Ele gera `CREDIT` para `BET` e `DEBIT` para `WIN` ou `REFUND`. Um débito de reversão sem saldo suficiente registra `REVERSAL_INSUFFICIENT_FUNDS` e `WagerTransactionRejected`, preservando saldo, versão e ledger. A referência ausente ou pendente elegível produz `202`, `PENDING_REFERENCE` e `WagerTransactionPendingReference`. Replays pendentes retornam o estado armazenado até o worker gravar o desfecho. Um segundo `ROLLBACK` distinto sobre o mesmo alvo usa o índice por tipo e retorna `409 DUPLICATE_ROLLBACK`.

### Compensação de BET

O índice por tipo continua garantindo unicidade separada para `REFUND` e `ROLLBACK`. Para evitar dois créditos sobre a mesma `BET`, ambos os fluxos verificam a reversão do outro tipo **depois** de obter `SELECT FOR UPDATE` na wallet, na mesma transação e em `READ COMMITTED`. Isso garante que a segunda operação veja o resultado confirmado pela primeira. Uma reversão pendente reserva a compensação no mesmo provedor, wallet, rodada e referência externa. Se o alvo ainda é desconhecido, os dois tipos competem por essa reserva, pois o alvo pode ser uma `BET`. Se o alvo é conhecido e é `WIN` ou `REFUND`, seu `ROLLBACK` não compete pela compensação de `BET`. Uma compensação pendente ou efetiva do outro tipo gera `422 BET_COMPENSATION_CONFLICT` com rejeição auditável.

Um `REFUND` processado continua sendo uma compensação efetiva até um `ROLLBACK(REFUND)` processado debitar seu valor. Um `ROLLBACK(REFUND)` pendente ou rejeitado mantém a compensação ativa. Depois que o crédito é desfeito, um `ROLLBACK(BET)` direto pode creditar a aposta uma vez. O índice por tipo continua reservando o `REFUND` original para fins de unicidade, preservando seu histórico e replay. O worker de referências pendentes repete a verificação sob o mesmo lock antes de creditar a wallet.

## Consumo SQS e Inbox

O Compose sobe LocalStack 4.4.0 com SQS e executa o hook de inicialização que provisiona `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. O source tem visibilidade de 60 segundos e redrive após cinco recebimentos. A aplicação usa o SDK oficial, `SQS_ENDPOINT`, `AWS_REGION` e a cadeia de credenciais da AWS. Os valores `test` do `.env.example` são exclusivos para o emulador local. Em AWS, a fila e a política de redrive devem ser provisionadas no mesmo ambiente do consumidor.

```sh
cp .env.example .env
docker compose up -d --wait
bun run migration:up
bun run build
bun run sqs:consume
```

O consumidor roda em um processo independente do HTTP. Múltiplas instâncias podem consumir a mesma fila com o nome lógico `wager-transactions`. Produtores podem usar a wallet como `MessageGroupId` para reduzir disputas, mas a correção depende das constraints e locks do PostgreSQL.

HTTP e SQS compartilham a validação de campos de negócio, o caso de uso e o hash da operação. Para SQS, a migration incremental cria a Inbox com chave primária `(consumer_name, message_id)`, usando o ID lógico do envelope. A reserva via `INSERT … ON CONFLICT DO NOTHING`, os efeitos financeiros e a marca de processamento ficam na mesma transação SQL. O hash da Inbox é SHA-256 do envelope JSON com chaves ordenadas recursivamente. Ele diferencia payloads divergentes sob o mesmo ID, inclusive se só um metadado do envelope mudar. A idempotência da transação continua evitando efeitos repetidos entre mensagens com IDs diferentes e entre HTTP e SQS.

- O consumidor remove a mensagem após o commit, inclusive em replay, rejeição de negócio persistida e `PENDING_REFERENCE`. Se houver falha no ACK depois do commit, a reentrega passa pela Inbox sem repetir efeitos financeiros.
- Falhas transitórias e inesperadas ficam disponíveis para reentrega com backoff de visibilidade exponencial de 1 a 60 segundos. O consumidor renova a visibilidade a cada 20 segundos durante o processamento.
- Envelope inválido, conflitos de identidade ou de payload da Inbox e duplicata de reversão com identidade distinta são falhas permanentes de submissão. Cada tentativa é registrada em log estruturado, sem payload financeiro ou mensagem de exceção. A visibilidade volta imediatamente a zero para o redrive nativo do SQS mover a mensagem à DLQ após o limite de recebimentos.
- Em `SIGTERM` ou `SIGINT`, o consumidor encerra o polling e aguarda a operação e o ACK em andamento. Se um poll que já estava em curso retornar durante a parada, o consumidor devolve a visibilidade da mensagem. O poll normal dura até 10 segundos. Interrupções forçadas ainda podem causar reentrega, que é esperada em SQS.

## Publicação da Outbox

Com o Compose saudável, execute `bun run migration:up`, `bun run build` e `bun run outbox:publish`. Esse processo é independente da API e do consumidor. Ele usa `SQS_ENDPOINT`, `AWS_REGION` e a cadeia de credenciais do SDK. `OUTBOX_QUEUE_NAME` seleciona a fila FIFO, com padrão `wagering-events.fifo`. O Compose provisiona essa fila separadamente da entrada de operações financeiras.

O publicador transmite o envelope JSON armazenado. Ele usa `aggregateId` como `MessageGroupId` e `eventId` como `MessageDeduplicationId`. Cada lote seleciona apenas o primeiro evento ainda não publicado de cada agregado com `SELECT FOR UPDATE SKIP LOCKED`. Assim, instâncias diferentes podem publicar agregados diferentes em paralelo, e uma tentativa adiada ou bloqueada impede que o próximo evento do mesmo agregado seja enviado antes dela. A migration incremental adiciona a sequência `publication_order` e o índice por agregado. Ela ordena o histórico de wallet pela versão e desempata os demais eventos antigos por `occurred_at` e `id`. Os produtores existentes serializam as gravações do mesmo agregado financeiro no PostgreSQL. A migration atualiza as linhas existentes da Outbox e deve ser aplicada antes de iniciar os publishers.

O lock é mantido durante o envio ao SQS e a gravação do resultado, com uma transação por lote e envios paralelos entre agregados. O SDK faz uma tentativa por chamada e limita a espera de uma requisição a cinco segundos. O processo só grava `published_at` após receber `MessageId`. Uma falha entre essa confirmação e o commit deixa a linha recuperável. A próxima instância reenvia o mesmo envelope com o mesmo `eventId`. O FIFO deduplica dentro da janela de cinco minutos, e consumidores devem deduplicar por `eventId` para lidar com reentregas fora dela.

- `OUTBOX_BATCH_SIZE` limita o lote, com padrão `10`. `OUTBOX_POLL_INTERVAL_MS`, com padrão `1000`, controla a pausa quando a consulta está vazia ou falha. O processo não dorme dentro da transação.
- Falhas de envio recuperáveis persistem o código e agendam retry exponencial com `OUTBOX_RETRY_BASE_MS` e `OUTBOX_RETRY_MAX_MS`, com padrões de um e sessenta segundos. As tentativas confirmadas no PostgreSQL incrementam `attempts`, inclusive a de sucesso. Um envio cuja transação de registro falha pode ser repetido sem incrementar o contador daquela transação.
- Erros permanentes específicos da mensagem preservam o envelope, `failed_at` e `last_error_code` para intervenção operacional. O evento permanece à frente do agregado, bloqueando seus sucessores até ser corrigido e liberado. Falhas de destino ou infraestrutura continuam elegíveis para retry. Logs registram o resultado confirmado no banco, sem o payload financeiro.
- `SIGTERM` e `SIGINT` interrompem a espera de polling e deixam o lote atual terminar. Uma interrupção forçada libera os locks quando a conexão PostgreSQL fecha.

## Worker de referências pendentes

Após aplicar as migrations existentes e executar `bun run build`, inicie `bun run references:process` em um processo próprio. O worker usa PostgreSQL e grava os eventos na Outbox. O publisher existente entrega os eventos ao SQS. O worker seleciona até dez operações por ciclo, com uma transação por operação, e espera um segundo entre ciclos. Em `SIGTERM` ou `SIGINT`, interrompe a espera e deixa a transação em andamento terminar.

A seleção usa `READ COMMITTED` e ordena as pendências pelo horário efetivo de elegibilidade, dado por `COALESCE(reference_next_attempt_at, created_at)`, com desempate por data de criação e ID. O horário nulo continua elegível na primeira avaliação. `FOR UPDATE OF wallet SKIP LOCKED` bloqueia primeiro a wallet e permite que outra instância avance em outra wallet. O worker então bloqueia a pendência e revalida o status e o próximo horário. A ordem é wallet, pendência e efeitos financeiros. As buscas pela referência e pelas compensações concorrentes são leituras. O worker mantém apenas uma wallet bloqueada por transação e segue a ordem de escrita de `SubmitWager`.

O primeiro retry é agendado para cinco segundos, seguido de atrasos exponenciais com teto de cinco minutos. O contador inclui somente avaliações confirmadas no banco, inclusive a avaliação terminal. Se uma tentativa falhar e a transação for revertida, a instância exclui o ID do restante do ciclo e o adia localmente por cinco segundos enquanto avalia outras operações. A pausa é descartada no reinício e outras instâncias podem retentar o mesmo ID. Os locks e a revalidação no PostgreSQL garantem a segurança financeira. Falhas gerais de conexão encerram o ciclo e o polling tenta novamente.

O prazo de 24 horas parte de `created_at` e limita o próximo agendamento. A avaliação usa `clock_timestamp()` do PostgreSQL depois dos locks da wallet e da pendência. Um horário maior ou igual ao prazo encerra a pendência. A rejeição usa `REFERENCE_NOT_FOUND` para referência ausente, `REFERENCE_NOT_READY` para referência existente e não terminal e `REFERENCE_WINDOW_EXPIRED` para referência processada e válida cuja avaliação só ocorreu com a janela encerrada. Alvos incompatíveis ou já rejeitados ou falhos continuam sujeitos aos códigos específicos de validação.

O schema registra a hora da decisão financeira. O instante em que o commit tornou essa decisão visível não está disponível nesses dados. Assim, uma referência válida pode ser rejeitada mesmo que tenha chegado a tempo, se o worker só conseguir avaliar a pendência no limite ou depois dele.

Retries pendentes atualizam apenas o contador e o horário. A decisão terminal atualiza a transação original, grava o saldo observado e enfileira o evento de desfecho, com atualização da wallet e entrada no ledger quando aplicável. O evento de pendência conserva sua posição anterior à do desfecho no mesmo agregado. O replay conserva a identidade e devolve o estado terminal e o saldo gravados.

## Consultas HTTP

Os quatro endpoints de consulta usam a mesma porta de leitura, com um adaptador PostgreSQL que executa consultas parametrizadas. O saldo da wallet vem do saldo materializado. O ledger usa o índice `(wallet_id, created_at, id)` e as transações usam o ID interno ou a chave única `(provider_id, external_transaction_id)`. As leituras veem dados confirmados e dispensam locks de escrita. Os DTOs usam `{ amount, currency }` com valores decimais de duas casas em strings e datas ISO 8601. Chaves de idempotência, hashes e controles de retry ficam na persistência.

| Rota | Resposta 200 |
| --- | --- |
| `GET /wallets/:walletId` | `id`, `playerId`, `balance` e `version` |
| `GET /wallets/:walletId/ledger` | `items` e `nextCursor`. Cada item contém `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter` e `createdAt`. |
| `GET /wagering/transactions/:transactionId` | `transactionId`, `walletId`, `providerId`, `externalTransactionId`, `roundId`, `gameId`, `kind`, `status`, `money` e `createdAt`. Inclui `observedBalance`, `finalizedAt`, `failureCode` e IDs de referência quando disponíveis. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Mesmo DTO, buscado pelo par de IDs da rota. |

A consulta de uma transação encontrada responde `200` em qualquer estado. O saldo observado representa a decisão gravada. `OPENING` pode ser consultada pelo ID interno para permitir a navegação a partir do ledger. A rota por provedor retorna `404` para o provedor reservado. Parâmetros inválidos geram `400` e recursos ausentes geram `404`. Falhas transitórias conhecidas de conexão ou do pool geram `503`, inclusive desconexões e timeouts de conexão que o driver reporta sem SQLSTATE. Erros inesperados continuam retornando `500`.

O ledger usa `limit` de 1 a 100, com padrão 50. Cada página ordena por `created_at DESC, id DESC` e lê `limit + 1` para determinar se há próxima página. O cursor versionado usa HMAC-SHA256 e vincula a wallet ao ID do último lançamento devolvido. Antes de executar `bun run start`, configure `LEDGER_CURSOR_SECRET` com 32 bytes aleatórios em hexadecimal, por exemplo com `openssl rand -hex 32`, e compartilhe o valor entre as instâncias HTTP. Com a variável ausente ou fora do formato de 64 caracteres hexadecimais, o processo HTTP encerra antes de abrir a porta. A mensagem de configuração omite o valor da chave. Rotacionar a chave invalida cursores anteriores.

A busca da âncora e a comparação da tupla acontecem no PostgreSQL, preservando a precisão do timestamp mesmo quando a data do DTO é serializada em milissegundos. Uma wallet existente sem lançamentos retorna `items: []` e `nextCursor: null`. Cada página lê o estado confirmado naquele instante. Lançamentos novos acima da âncora ficam disponíveis ao reiniciar pela primeira página. Um lançamento confirmado depois com chave anterior à âncora pode aparecer em uma página seguinte.

O escopo SQL por wallet ou provedor separa os registros consultados. A API do desafio assume um ambiente confiável. `FinancialQueryAccessGuard` é o ponto de extensão da autorização dos quatro GETs e atualmente permite a passagem. Para uso com clientes não confiáveis, a integração com um provedor OIDC externo deve validar o token e vincular suas identidades de jogador ou provedor aos recursos autorizados antes de entregar dados. IDs da URL e cursores não comprovam essa autorização.
