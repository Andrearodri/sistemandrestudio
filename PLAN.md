# Homologação WebMCP

- [x] Confirmar branch e item WebMCP `VERIFIED` / `CONFIRMED`.
- [x] Blindar contrato editorial com schema Zod/JSON Schema e `subtitle` como texto simples.
- [x] Separar geração estruturada, montagem determinística e validação factual/quantitativa.
- [x] Implementar reparo direcionado limitado a uma segunda chamada.
- [x] Executar testes, typecheck e build antes da homologação.
- [x] Executar no máximo duas chamadas ao Gemma, sem persistir saída inválida.
- [ ] Persistir exatamente um rascunho válido e enviar uma mensagem ao Telegram.
- [ ] Parar aguardando decisão humana; manter publicação `SKIPPED`.

Resultado: as duas chamadas desta rodada foram consumidas; a validação determinística final falhou e nenhuma saída inválida foi persistida. Não repetir sem nova autorização e diagnóstico do wrapper.
