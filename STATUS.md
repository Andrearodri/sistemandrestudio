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
- Nova homologação: ainda não iniciada; chamadas ao Gemma nesta etapa = 0; persistência/Telegram = 0.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`); próximo gate é validar a saída e, somente se válida, persistir uma versão e enviar uma mensagem ao Telegram autorizado.
