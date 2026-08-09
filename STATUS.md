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
- Orçamento WebMCP: contexto 4096; `max_tokens=num_predict=768`; schema `body` entre 1 e 12.000 caracteres; sem `stop`; margem reservada para JSON/instruções. O Radar continua isolado em 160 tokens.
- Fact packet WebMCP: entidade, anúncio confirmado, fatos apoiados, URL oficial, qualificadores permitidos e proibidos; sem status de disponibilidade confirmado, `preview`, `beta`, `versão` e `disponibilidade` são proibidos.
- Reparo: schema de saída contém somente `body`; título/subtitle válidos são preservados e o body inválido integral não é reenviado.
- Testes: suíte completa (362/362), typecheck e build passaram.
- Nova homologação: encerrada após uma chamada; o reparo não foi iniciado porque a falha ocorreu na validação final do serviço após o retorno estruturado.
- Diagnóstico sanitizado da rodada: orçamento efetivo 768 tokens; prompt aproximado 689; completion 111; término `STOP`; estágio `FINAL_VALIDATION`; tentativa 1; campo `body`; código `FINAL_VALIDATION_FAILED`.
- Limitação observada: o serviço externo preservou apenas `EDITORIAL_DRAFT_GENERATION_FAILED`; a sub-regra interna específica dessa validação downstream não foi exposta nesta execução.
- Diagnóstico detalhado da sub-regra downstream não ficou disponível nessa execução porque a camada de serviço o substituía pelo erro genérico; o patch atual preserva esse diagnóstico para futuras execuções. Não foi feita nova chamada para recuperar dados.
- Resultado externo: `EDITORIAL_DRAFT_GENERATION_FAILED`; o diagnóstico interno preservou estágio, tentativa, códigos, contagem, campo, parse/schema, duração e quantidade de chamadas, sem conteúdo do modelo.
- Confirmação PostgreSQL: `editorial_drafts=0` e `editorial_human_decision_requests=0` para o item WebMCP.
- Persistência/Telegram: zero. PostgreSQL permanece sem novo rascunho ou solicitação para WebMCP.
- Publicação: bloqueada (`PUBLICATION_ENABLED=false`); nenhuma nova chamada deve ser feita nesta etapa.
- Correção pós-homologação: `EditorialDraftWorkflowService` recalcula a validação final de drafts bloqueados e propaga diagnóstico interno sanitizado (`FINAL_VALIDATION`/`UNSUPPORTED_QUALIFIER` ou `FINAL_VALIDATION_FAILED`) mantendo a mensagem externa genérica; nenhum estado é persistido.
- Regressão adicionada: valida que bloqueio factual do `body` preserva código, estágio, contagem de palavras e zero chamadas à persistência.
- Validação após correção: typecheck, build e teste do pipeline passaram; a suíte completa anterior passou 362/362 quando executada com permissão para sockets locais. Nenhuma nova chamada ao Gemma foi feita após a homologação falhar.
- Nova homologação autorizada: executor efetivo rodou fora do sandbox; pré-condições confirmadas (`VERIFIED`/`CONFIRMED`, 2 evidências, zero drafts). Houve exatamente 1 chamada ao Gemma: prompt 695 tokens, completion 183, limite 768, término `STOP`, duração aproximada 8,8 s.
- Resultado da nova homologação: falha no estágio de validação determinística após a geração inicial, tentativa 1, campo `body`; o executor `_scratch/webmcp-full-homologation.ts` lançou referência a variável inexistente (`input`), impedindo contagem de palavras e códigos de regra. Nenhuma segunda chamada foi feita.
- Persistência/Telegram após a nova homologação: `editorial_drafts=0` e `editorial_human_decision_requests=0`; publicação `SKIPPED` e `PUBLICATION_ENABLED=false`.
- Executor rastreado: `apps/sistemandrestudio-api/src/webmcp-homologation.ts`, com item e dependências explícitos, geração/reparo via adapter existente, persistência via serviço existente e Telegram via `TelegramHumanDecisionChannel`. `_scratch/webmcp-full-homologation.ts` contém somente um lançador descartável.
- ReferenceError corrigido: a validação agora recebe explicitamente `input`; nenhum estado depende de variável implícita.
- Regressões adicionadas: resposta schema-valid entra na validação, códigos e contagem são calculados, reparo usa somente `body`, falha não persiste e sucesso persiste uma única vez.
- Verificação pré-homologação do executor rastreado: typecheck, build e suíte completa `366/366` passaram; nenhuma chamada ao Gemma foi feita durante a correção.
- Homologação pelo executor rastreado: exatamente 2 chamadas, sem repetição adicional. Tentativa 1 (`INITIAL_GENERATION`): `SCHEMA_VALID`, 111 palavras, `WORD_COUNT_BELOW_MINIMUM` e `UNSUPPORTED_QUALIFIER`, 695 tokens de prompt, 183 de completion, limite 768, `STOP`, 9,7 s. Tentativa 2 (`DIRECTED_REPAIR`): `SCHEMA_INVALID`, `REPAIR_SCHEMA_FAILED`, 424 tokens de prompt, 271 de completion, limite 768, `STOP`, 6,9 s.
- Resultado final: `EDITORIAL_DRAFT_GENERATION_FAILED`; nenhum rascunho ou solicitação de decisão foi criado (`editorial_drafts=0`, `editorial_human_decision_requests=0`), Telegram não foi enviado e publicação permaneceu `SKIPPED`.

## Provedor editorial OpenAI/Luna

- Implementação local adicionada sem alterar a política editorial: `OpenAIEditorialProvider` usa somente `OPENAI_API_KEY`, fixa o modelo `gpt-5.6-luna` e nunca faz fallback automático para Gemma.
- O Radar Diário continua explicitamente em Ollama; apenas o escopo `LONG_FORM` pode selecionar OpenAI por `EDITORIAL_PROVIDER=openai`.
- A integração usa a Responses API, `store=false`, `tools=[]`, raciocínio baixo e Structured Outputs estritos em `text.format`, com JSON Schema derivado do mesmo schema Zod editorial.
- O orçamento é limitado a duas chamadas por homologação; uso e custo são acumulados de forma sanitizada. O cálculo usa US$0,20/1M tokens de entrada e US$1,20/1M tokens de saída conforme a documentação oficial consultada.
- Testes adicionados cobrem seleção de provedor, schema estrito, resposta válida/inválida, 401/429/5xx/timeout, limite de chamadas, métricas sanitizadas e ausência de efeitos de persistência/publicação.
- `npm run typecheck`, `npm run build`, os testes específicos do provedor e a suíte completa passaram (`373/373`).
- A criação do provedor por ambiente exige `OPENAI_HARD_SPEND_LIMIT_USD=1` além de `OPENAI_API_KEY`; sem essa confirmação a chamada é bloqueada antes do SDK.
- Homologação real não executada: `OPENAI_API_KEY` está ausente no ambiente local e o hard spend limit mensal de US$1 ainda não foi confirmado. Nenhuma chamada OpenAI/Gemma, persistência, Telegram ou publicação foi realizada nesta etapa.
