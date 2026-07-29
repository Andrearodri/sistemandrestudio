# Orquestração editorial supervisionada

## Escopo

A política `andre-studio-editorial-orchestration-v1` coordena o fluxo
editorial existente sem copiar regras de radar, relevância, evidência,
verificação, drafting ou revisão. O PostgreSQL continua sendo a fonte de
verdade. n8n agenda, dispara e consulta; o sistema valida, executa transições,
persiste, controla concorrência e audita.

Não há publicação automática, decisão por IA, integração social, CRM ou
alteração do website nesta etapa.

## Fluxo e estados

Os passos persistidos são:

1. `RADAR_INGESTION`;
2. `RELEVANCE_EVALUATION`;
3. `EVIDENCE_ACQUISITION`;
4. `FACTUAL_VERIFICATION`;
5. `DRAFT_GENERATION`;
6. `HUMAN_REVIEW_NOTIFICATION`;
7. `HUMAN_DECISION`;
8. `PUBLICATION_PACKAGE_PREPARATION`.

O oitavo passo é explicitamente `SKIPPED` nesta versão. Uma execução passa por
`CREATED`, `RUNNING` e `WAITING_HUMAN_DECISION`. Após decisão explícita, termina
em `COMPLETED` para aprovação ou `COMPLETED_WITH_WARNINGS` para rejeição,
solicitação de alterações ou ausência de draft elegível. Falhas técnicas usam
`FAILED`; cancelamento humano usa `CANCELLED`.

Requests vencidos ficam `EXPIRED`. Expiração nunca aprova, rejeita ou decide.

## Política conservadora

- fontes: as cinco fontes oficiais do catálogo v1;
- máximo ingerido: 15 referências;
- máximo enviado a evidências: 5;
- máximo de drafts: 3;
- máximo de decisões pendentes: 3;
- relevância mínima: 60;
- verificação elegível: `CONFIRMED` ou `PARTIALLY_CONFIRMED`, ainda sujeita às
  regras existentes do gerador;
- timeout humano: 24 horas;
- retries técnicos: no máximo 3 tentativas, com backoff previsto de 5 e 30
  segundos pelo chamador;
- aprovação humana: obrigatória;
- publicação automática: desabilitada;
- decisão automática por IA: desabilitada.

## Persistência e retomada

A migration `015_editorial_orchestration.sql` cria runs, steps, requests,
decisions, attempts e eventos. Somente referências e metadados limitados são
persistidos; tokens, cookies, HTML integral e payload bruto do Telegram não são
armazenados.

O trigger key, a política e a configuração funcional geram um fingerprint.
Repetir a mesma identidade retorna replay. Reutilização incompatível retorna
`EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT`.

Locks transacionais e índices únicos garantem:

- uma run por trigger key;
- um step por posição e tipo;
- um request por draft e versão;
- uma decisão final por request;
- tentativas numeradas e limitadas;
- eventos sem duplicação pelo identificador.

`resumeRun()` lê o PostgreSQL e continua a partir do estado persistido. n8n não
precisa memorizar o passo atual.

Replay retorna o sinal operacional `EDITORIAL_ORCHESTRATION_REPLAYED` na
resposta, mas não insere um novo evento persistido. Assim, repetir um trigger
mantém zero alterações em runs, steps, decisões e histórico.

## CLI JSON

O contrato CLI produz uma linha JSON estável:

```bash
DRY_RUN_ORCHESTRATION=true npm run orchestration:start -- \
  --trigger N8N_SCHEDULED \
  --trigger-key editorial-run:2026-07-29:morning

npm run orchestration:show -- --run <runId>
npm run orchestration:list
npm run orchestration:pending-decisions
npm run orchestration:resume -- --run <runId>
npm run orchestration:cancel -- \
  --run <runId> \
  --operator andre-local \
  --reason "motivo controlado"
```

Existe também `orchestration:decision` para integrações locais controladas.
Nenhum comando de publicação foi criado.

## API interna

`npm run orchestration:serve` inicia, somente quando configurado, uma API nativa
Node em `127.0.0.1:4317`. Ela exige `ORCHESTRATION_API_SECRET`, limita payload a
16 KB, aplica rate limit conservador, não habilita CORS e não segue redirects.

Endpoints:

```text
POST /internal/orchestration/runs
GET  /internal/orchestration/runs/:id
GET  /internal/orchestration/pending-decisions
POST /internal/orchestration/runs/:id/resume
POST /internal/human-decisions
```

Nesta etapa o servidor recusa bind não local e exige
`DRY_RUN_ORCHESTRATION=true` para iniciar runs.

## Execução real controlada

O adaptador PostgreSQL operacional apenas projeta até três itens oficiais já
persistidos. Ele não consulta a internet e não reexecuta regras. Gera no máximo
um request para draft já validado e em `PENDING_APPROVAL`. Telegram só conecta
quando `HUMAN_DECISION_CHANNEL=TELEGRAM` e todas as variáveis obrigatórias
existem; o padrão é `CONSOLE`.

Essa limitação é deliberada. A ligação completa dos executores de radar,
aquisição e drafting à agenda deverá ser revisada em subetapa futura antes de
qualquer execução operacional ampliada.
