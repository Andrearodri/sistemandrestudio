# Status da homologação WebMCP

- Branch: `feat/local-llm-gemma4`.
- Item: WebMCP, estado `VERIFIED` / `CONFIRMED`.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`).
- Contrato `subtitle`: string simples obrigatória nos fluxos de rascunho/revisão; tipos complexos são rejeitados.
- Histórico: nenhuma persistência parcial da homologação anterior; nenhum Telegram enviado nesta rodada.
- Tentativas controladas: 1 falhou em JSON inválido; 2 passou o parser mas falhou na validação de conteúdo; 3 falhou no limite de palavras.
- Persistência/Telegram: zero; nenhuma saída inválida foi gravada ou enviada.
- Estado: bloqueado após esgotar 3/3 tentativas autorizadas. Não iniciar nova tentativa sem autorização.
