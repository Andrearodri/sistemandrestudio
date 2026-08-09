# Homologação WebMCP

- [x] Confirmar branch e item WebMCP `VERIFIED` / `CONFIRMED`.
- [x] Blindar contrato editorial com schema Zod/JSON Schema e `subtitle` como texto simples.
- [x] Separar geração estruturada, montagem determinística e validação factual/quantitativa.
- [x] Implementar reparo direcionado limitado a uma segunda chamada.
- [x] Executar testes, typecheck e build antes da homologação.
- [x] Executar no máximo duas chamadas ao Gemma, sem persistir saída inválida.
- [x] Preservar diagnósticos internos tipados entre wrapper e serviço, sem conteúdo sensível.
- [x] Validar diagnósticos, sanitização, contagem e propagação externa.
- [x] Executar a nova homologação controlada e bloquear saídas inválidas.
- [ ] Persistir exatamente um rascunho válido e enviar uma mensagem ao Telegram.
- [ ] Parar aguardando decisão humana; manter publicação `SKIPPED`.

Resultado: a nova rodada consumiu duas chamadas e falhou na validação; não houve persistência nem Telegram. Não realizar novas chamadas nesta etapa.
