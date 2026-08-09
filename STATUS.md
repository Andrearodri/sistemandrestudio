# Status da homologação WebMCP

- Branch: `feat/local-llm-gemma4`.
- Item: WebMCP, estado `VERIFIED` / `CONFIRMED`.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`).
- Contrato `subtitle`: string simples obrigatória nos fluxos de rascunho/revisão; tipos complexos são rejeitados.
- Histórico: nenhuma persistência parcial da homologação anterior; nenhum Telegram enviado nesta nova rodada.
- Contrato estrutural: schema Zod único convertido para JSON Schema no campo `format` do Ollama; `subtitle` é string simples obrigatória; geração usa temperatura 0.
- Fluxo: geração estruturada, montagem determinística da fonte oficial e validação factual/quantitativa estão separados.
- Reparo: no máximo uma segunda chamada direcionada, somente para objeto estruturado válido com falhas reparáveis; JSON inválido não é repetido.
- Testes: suíte completa (357/357), typecheck e build passaram.
- Nova homologação: duas chamadas ao Gemma foram consumidas (geração inicial + reparo direcionado); o fluxo terminou em `EDITORIAL_DRAFT_GENERATION_FAILED` após a validação determinística final.
- Causa sanitizada: a saída estruturada foi recebida, mas não passou integralmente as regras editoriais do wrapper dentro do limite de duas chamadas. O serviço não expôs conteúdo do modelo nem códigos internos adicionais.
- Persistência/Telegram: zero. Confirmação de leitura no PostgreSQL: `editorial_drafts=0` e `editorial_human_decision_requests=0` para o item WebMCP.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`); nenhuma mensagem foi enviada e nenhum estado parcial foi criado.
