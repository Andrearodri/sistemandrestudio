# Rascunhos editoriais controlados

## Objetivo

A Etapa 10 transforma somente um resultado factual `CONFIRMED` em um rascunho
local, rastreável e sujeito a aprovação humana. Não há LLM, Telegram,
publicação, rede adicional ou envio automático.

## Política e elegibilidade

A política `andre-studio-editorial-draft-v1` concede `ALLOW_DRAFT` somente a
`CONFIRMED`. `PARTIALLY_CONFIRMED` recebe `ALLOW_RESTRICTED_DRAFT`, mas fica
bloqueado no fluxo normal porque o agregado não está em `VERIFIED`. Todos os
outros status recebem `BLOCK_DRAFT`; relevância nunca substitui verificação.

## Pacote e geração

`EditorialBrief` liga cada fato permitido à claim, evidências oficiais,
confiança, restrições, citações e política. O gerador determinístico suporta
`LINKEDIN_SHORT_POST` e `WEBSITE_NEWS_BRIEF` em `pt-BR`; a interface
`EditorialTextGenerator` é uma porta futura, sem provedor conectado.

O validador bloqueia ausência de fatos/citações, HTML/scripts, títulos
sensacionalistas, claims proibidas e excesso de tamanho. Conteúdo externo é
tratado como dado e não é entregue como instrução ao gerador.

## Persistência e operação

A migration `009_editorial_drafting.sql` cria briefs, claims/fatos, drafts,
citações e validações. A gravação cria a versão existente, aplica
`CreateDraft` e `SubmitForApproval` na mesma transação, preservando replay por
chave idempotente e rollback em conflito de versão.

```bash
npm run demo:draft
npm run demo:draft:postgres
npm run draft:official
```

`draft:official` não busca URLs: seleciona até dois itens já confirmados e
verificados, gera localmente e só persiste se a validação passar. Todo
rascunho permanece em `PENDING_APPROVAL`; revisão humana continua obrigatória.

## Limitações

Não há rascunho restrito persistido, LLM real, edição humana por Telegram,
publicação, imagens ou integração externa nesta etapa.

## Validação oficial do ciclo atual

`npm run pipeline:official:draft` diagnostica até dez itens oficiais recentes,
sem escrita durante o diagnóstico. A identidade lógica versionada combina
fonte, external ID, URL canônica, hash do item e data/versão do acontecimento.
Se não houver candidato atual, o comando pode executar uma coleta limitada das
cinco fontes já allow-listed.

Confirmações históricas de LiteRT.js e Ray 2.55 não são reabertas: seus estados
e eventos permanecem imutáveis e o relatório usa
`VERIFICATION_HISTORICAL_ONLY`. Na validação de 25 de julho de 2026, o item
oficial “Expanding Choice in Gemini Enterprise Agent Platform” percorreu a
verificação atual, obteve uma claim e uma evidência confirmadas, gerou os dois
formatos determinísticos e persistiu a versão para site até
`PENDING_APPROVAL`. A repetição produziu replay com zero agregados,
verificações, drafts, aprovações e eventos adicionais.

O formato LinkedIn é validado como variante determinística local; a versão
editorial persistida e submetida à aprovação é o `WEBSITE_NEWS_BRIEF`. A
revisão humana continua obrigatória e nenhum texto é publicado.
## Revisões

Uma correção humana preserva brief, evidências, citações e warnings, cria nova versão e executa novamente a validação determinística antes de retornar a `PENDING_APPROVAL`.
