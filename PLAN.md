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
- [x] Separar orçamento de artigo WebMCP do resumo curto e auditar payload efetivo.
- [x] Construir fact packet determinístico e reparar somente `body`.
- [x] Testar orçamento, tokens, qualificadores proibidos e reparo sem invenção.
- [x] Executar a única nova homologação autorizada, limitada a duas chamadas.
- [ ] Persistir exatamente um rascunho válido e enviar uma mensagem ao Telegram.
- [ ] Parar aguardando decisão humana; manter publicação `SKIPPED`.

Resultado: a rodada consumiu uma chamada e falhou na validação final antes do reparo; não houve persistência nem Telegram. Não realizar novas chamadas nesta etapa.
