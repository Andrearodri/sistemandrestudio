# Status da homologação WebMCP

- Branch: `feat/local-llm-gemma4`.
- Item: WebMCP, estado `VERIFIED` / `CONFIRMED`.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`).
- Contrato `subtitle`: string simples obrigatória nos fluxos de rascunho/revisão; tipos complexos são rejeitados.
- Histórico: nenhuma persistência parcial da homologação anterior; nenhum Telegram enviado nesta nova rodada.
- Contrato estrutural: schema Zod único convertido para JSON Schema no campo `format` do Ollama; `subtitle` é string simples obrigatória; geração usa temperatura 0.
- Fluxo: geração estruturada, montagem determinística da fonte oficial e validação factual/quantitativa estão separados.
- Reparo: no máximo uma segunda chamada direcionada, somente para objeto estruturado válido com falhas reparáveis; JSON inválido não é repetido.
- Diagnóstico interno: envelope tipado com estágio, tentativa, códigos allow-listed, word count, campos, parse/schema, duração e chamadas; conteúdo de prompt/modelo/evidência é excluído.
- Fronteira externa: continua usando `EDITORIAL_DRAFT_GENERATION_FAILED`, com diagnóstico seguro anexado apenas no serviço interno/relatório.
- Testes: suíte completa (360/360), typecheck e build passaram.
- Nova homologação: encerrada após exatamente duas chamadas (geração + reparo direcionado), sem persistência ou Telegram.
- Diagnóstico sanitizado: tentativa 1 `SCHEMA_VALID`, 56 palavras, códigos `WORD_COUNT_BELOW_MINIMUM` e `UNSUPPORTED_QUALIFIER`; tentativa 2 `SCHEMA_VALID`, 56 palavras, mesmos códigos mais `FINAL_VALIDATION_FAILED`; campo afetado: `body`.
- Resultado externo: `EDITORIAL_DRAFT_GENERATION_FAILED`; o diagnóstico interno preservou estágio, tentativa, códigos, contagem, campo, parse/schema, duração e quantidade de chamadas, sem conteúdo do modelo.
- Confirmação PostgreSQL: `editorial_drafts=0` e `editorial_human_decision_requests=0` para o item WebMCP.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`); nenhuma mensagem foi enviada e nenhuma nova chamada deve ser feita nesta etapa.
