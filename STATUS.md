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
- Nova homologação: pronta para uma única rodada, máximo de duas chamadas (geração + reparo direcionado).
- Histórico: a rodada anterior consumiu duas chamadas, terminou em `EDITORIAL_DRAFT_GENERATION_FAILED`, sem persistência; os códigos agora serão preservados se houver nova falha.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`); Telegram só será acionado após validação completa e persistência única.
