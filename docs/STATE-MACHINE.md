# Máquina de estados editorial — sistemandrestudio

## 1. Objetivo

A máquina representa, de forma local e determinística, o ciclo de vida de uma
notícia no MVP. Ela decide quais comandos são válidos, preserva versões, produz
eventos de auditoria e impede que conteúdo chegue a
`READY_FOR_PUBLICATION` sem verificação e aprovação humana.

O núcleo é puro: não usa rede, banco, Docker, variáveis de ambiente, relógio
real ou IDs aleatórios.

## 2. Estados

| Estado | Significado | Terminal |
| --- | --- | --- |
| `RECEIVED` | item fictício recebido, ainda não normalizado | não |
| `NORMALIZED` | título e URL canônica definidos | não |
| `DUPLICATE` | item vinculado a uma notícia canônica | sim |
| `SCORED` | relevância calculada por política versionada | não |
| `DISCARDED_LOW_RELEVANCE` | pontuação abaixo do limiar | sim |
| `PENDING_VERIFICATION` | item aguardando decisão factual | não |
| `VERIFIED` | evidências satisfazem a política | não |
| `VERIFICATION_REJECTED` | evidências rejeitam a informação | sim |
| `DRAFT_CREATED` | existe uma versão atual de rascunho | não |
| `PENDING_APPROVAL` | versão atual submetida ao humano | não |
| `CHANGES_REQUESTED` | humano pediu uma nova versão | não |
| `APPROVED` | humano aprovou a versão atual | não |
| `REJECTED` | humano rejeitou o rascunho | sim |
| `READY_FOR_PUBLICATION` | versão aprovada, sem publicar | sim |

## 3. Diagrama

```mermaid
stateDiagram-v2
    [*] --> RECEIVED
    RECEIVED --> NORMALIZED: NormalizeNews
    NORMALIZED --> DUPLICATE: MarkAsDuplicate
    NORMALIZED --> SCORED: ScoreNews
    SCORED --> DISCARDED_LOW_RELEVANCE: DiscardLowRelevance
    SCORED --> PENDING_VERIFICATION: RequestVerification
    PENDING_VERIFICATION --> VERIFIED: ApproveVerification
    PENDING_VERIFICATION --> VERIFICATION_REJECTED: RejectVerification
    VERIFIED --> DRAFT_CREATED: CreateDraft
    DRAFT_CREATED --> PENDING_APPROVAL: SubmitForApproval
    PENDING_APPROVAL --> CHANGES_REQUESTED: RequestChanges
    CHANGES_REQUESTED --> DRAFT_CREATED: CreateDraft
    PENDING_APPROVAL --> APPROVED: ApproveDraft
    PENDING_APPROVAL --> REJECTED: RejectDraft
    APPROVED --> READY_FOR_PUBLICATION: MarkReadyForPublication
```

## 4. Transições

| Origem | Comando | Destino | Regra principal |
| --- | --- | --- | --- |
| `RECEIVED` | `NormalizeNews` | `NORMALIZED` | título e URL canônica obrigatórios |
| `NORMALIZED` | `MarkAsDuplicate` | `DUPLICATE` | exige ID do item canônico |
| `NORMALIZED` | `ScoreNews` | `SCORED` | valor e limiar entre 0 e 100 |
| `SCORED` | `DiscardLowRelevance` | `DISCARDED_LOW_RELEVANCE` | valor abaixo do limiar |
| `SCORED` | `RequestVerification` | `PENDING_VERIFICATION` | valor igual ou acima do limiar |
| `PENDING_VERIFICATION` | `ApproveVerification` | `VERIFIED` | resultado `VERIFIED` |
| `PENDING_VERIFICATION` | `RejectVerification` | `VERIFICATION_REJECTED` | resultado `REJECTED` |
| `VERIFIED` | `CreateDraft` | `DRAFT_CREATED` | cria versão 1 |
| `DRAFT_CREATED` | `SubmitForApproval` | `PENDING_APPROVAL` | submete a versão atual |
| `PENDING_APPROVAL` | `RequestChanges` | `CHANGES_REQUESTED` | exige ator humano |
| `CHANGES_REQUESTED` | `CreateDraft` | `DRAFT_CREATED` | preserva anterior e cria próxima versão |
| `PENDING_APPROVAL` | `ApproveDraft` | `APPROVED` | versão atual, ator humano e chave idempotente |
| `PENDING_APPROVAL` | `RejectDraft` | `REJECTED` | versão atual, ator humano e motivo |
| `APPROVED` | `MarkReadyForPublication` | `READY_FOR_PUBLICATION` | aprovação corresponde à versão atual |

## 5. API de domínio

- `canTransition(currentState, targetState)`: consulta a topologia.
- `transition(entity, command, context)`: aplica um comando puro e retorna nova
  entidade, evento e indicador de replay.
- `validateEntity(entity)`: retorna violações estruturadas.
- `createReceivedNews(input)`: cria o estado inicial com dados fornecidos.
- `EditorialNewsRepository`: contrato substituível de persistência.
- `InMemoryEditorialNewsRepository`: adaptador para demo e testes unitários.
- `PostgresEditorialNewsRepository`: adaptador assíncrono de infraestrutura,
  implementado fora do domínio.

`TransitionContext` fornece `eventId`, ator e horário. Isso impede dependência
oculta de relógio ou gerador de UUID.

## 6. Eventos

Cada transição efetiva acrescenta um `AuditEvent` com:

- ID;
- ID da notícia;
- estado anterior e novo;
- tipo do comando;
- ator e tipo do ator;
- timestamp;
- motivo opcional;
- versão de conteúdo relacionada;
- chave de idempotência quando houver.

Os tipos de ator aceitos pelo modelo são `SYSTEM`, `HUMAN`, `N8N`, `TELEGRAM` e
`LLM`. São representações locais; nenhuma integração é executada. Aprovação,
rejeição e pedido de alterações exigem ator `HUMAN`.

## 7. Invariantes

- transições fora da tabela são rejeitadas;
- duplicata e baixa relevância nunca geram rascunho;
- verificação rejeitada nunca segue para geração;
- rascunho só nasce após `VERIFIED`;
- somente a versão atual pode ser submetida ou aprovada;
- edição preserva versões e invalida a aprovação anterior;
- nova versão exige nova solicitação e nova decisão;
- somente uma decisão humana pode aprovar ou rejeitar;
- `READY_FOR_PUBLICATION` exige decisão de aprovação da versão atual;
- `READY_FOR_PUBLICATION` não publica conteúdo;
- IDs, atores e horários são dependências explícitas;
- a entidade e seus históricos são atualizados sem mutar a entrada.

## 8. Idempotência

Comandos que carregam `idempotencyKey` são registrados com:

- chave;
- tipo;
- fingerprint dos campos relevantes.

Um replay com a mesma chave e o mesmo fingerprint retorna a entidade sem
alteração e não cria novo evento. Reuso da chave com tipo ou payload diferente
gera `DUPLICATE_COMMAND`. IDs de eventos repetidos também são rejeitados.

No adaptador PostgreSQL, essa proteção também sobrevive ao processo por meio de
constraint única e gravação transacional em `processed_commands`.

## 9. Versionamento

`CreateDraft` acrescenta uma `DraftVersion` imutável:

- IDs são fornecidos pelo chamador;
- números começam em 1 e são sequenciais;
- `basedOnVersionId` liga a revisão à versão anterior;
- corpo, ator e horário ficam preservados.

`ApprovalRequest` sempre aponta para uma versão. Depois de
`CHANGES_REQUESTED`, a solicitação antiga permanece resolvida, uma nova versão é
criada e uma nova solicitação deve entrar em `PENDING_APPROVAL`.

## 10. Erros

Os erros derivam de `DomainError` e possuem códigos estáveis:

- `INVALID_TRANSITION`;
- `ENTITY_NOT_FOUND`;
- `DRAFT_VERSION_NOT_FOUND`;
- `APPROVAL_REQUEST_NOT_FOUND`;
- `APPROVAL_ALREADY_PROCESSED`;
- `DUPLICATE_COMMAND`;
- `REQUIRED_FIELD_MISSING`;
- `STALE_APPROVAL_VERSION`;
- `INVALID_RELEVANCE_SCORE`;
- `LOW_RELEVANCE`;
- `INVALID_ACTOR`.
- `CONCURRENT_UPDATE`.

## 11. Fixtures e exemplos

As fixtures usam nomes, URLs `.invalid`, IDs e timestamps fictícios:

| Cenário | Resultado |
| --- | --- |
| A — aprovado | `READY_FOR_PUBLICATION` |
| B — duplicado | `DUPLICATE` |
| C — baixa relevância | `DISCARDED_LOW_RELEVANCE` |
| D — verificação rejeitada | `VERIFICATION_REJECTED` |
| E — rascunho rejeitado | `REJECTED` |
| F — alteração solicitada | versão 2 exige aprovação nova |
| G — transição inválida | erro controlado |
| H — idempotência | segunda aprovação é replay sem evento |

Comandos locais:

```bash
npm run typecheck
npm run test
npm run build
npm run demo
```

## 12. Limitações atuais

- o score e a verificação são entradas de fixture, não algoritmos completos;
- o adaptador em memória perde os dados ao encerrar o processo;
- o adaptador PostgreSQL fornece transação e concorrência otimista;
- não há autenticação real;
- não há API HTTP;
- não há fila, timeout ou retry de orquestração;
- não há RSS, n8n, Telegram ou LLM;
- não há publicação.

## 13. Evolução futura

1. adicionar uma camada de serviço que coordene transição e persistência;
2. mapear workflows n8n para comandos explícitos;
3. mapear callbacks autenticados do Telegram para decisões humanas;
4. ligar um adaptador de LLM somente ao comando `CreateDraft`;
5. manter a máquina independente de todas essas integrações.
