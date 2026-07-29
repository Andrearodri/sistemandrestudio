# Reconciliação de publicação externa

A Etapa 12.7 fecha a lacuna entre um pacote local pronto e uma publicação feita
manualmente fora do sistema. Exportar cria e valida arquivos locais;
publicar torna conteúdo acessível em um destino público. O
`sistemandrestudio` não fez deploy, upload, SSH, alteração de DNS, Nginx,
certificado ou restart. Ele verificou o resultado público de uma execução
manual supervisionada e reconciliou esse fato com o histórico editorial.

## Origem e transição

A reconciliação desta etapa aceita somente
`MANUAL_SUPERVISED_DEPLOY`. `SYSTEM_EXECUTED` e `EXTERNAL_CONFIRMED` existem no
vocabulário auditável, mas não são aceitos pelo fluxo atual. Operador, pacote,
draft e versão, URL, canonical, política, commit opcional e rótulo descritivo
do destino são persistidos sem caminho remoto, credencial ou connection string.

Uma transição é permitida somente quando:

```text
pacote WEBSITE_EXPORT READY_FOR_PUBLICATION
→ arquivos locais e hashes íntegros
→ draft atual e decisão humana APPROVE
→ verificação pública VERIFIED ou VERIFIED_WITH_WARNINGS
→ reconciliação COMPLETED
→ pacote e notícia PUBLISHED
```

`PUBLISHED` é um estado terminal. Constraints e triggers diferidos impedem
pacote ou notícia nesse estado sem reconciliação e verificação correspondentes.
Todas as linhas, os cinco eventos e as duas mudanças de estado são gravados na
mesma transação PostgreSQL. Falha produz rollback integral.

## Verificação pública

A política `andre-studio-publication-reconciliation-v1` usa somente APIs
nativas do Node.js. O cliente aceita `GET` e `HEAD` HTTPS nos hosts
`andrestudio.dev.br` e `www.andrestudio.dev.br`, revalida redirects e DNS,
bloqueia endereços privados, credenciais em URL, portas alternativas e o
domínio DuckDNS legado. Há timeout de 20 segundos, até cinco redirects e
limites de 1 MB para HTML e 2 MB para XML/texto.

As verificações críticas cobrem:

- home, índice `/blog/`, artigo, `sitemap.xml`, `robots.txt` e `www`;
- status HTTP, HTTPS, host permitido, slug e canonical;
- título, idioma `pt-BR`, descrição, autor, marca, data e categoria;
- link da fonte oficial;
- JSON-LD `Article`/`NewsArticle` e `BreadcrumbList`;
- presença do artigo no blog e sitemap e preservação dos artigos anteriores;
- ausência de URL absoluta ou canonical DuckDNS;
- imagem Open Graph por `HEAD`, quando declarada.

HTML público é tratado como entrada não confiável, analisado sem executar
scripts e descartado após a verificação. O banco guarda somente fingerprint,
checks limitados e resumos técnicos; não guarda a página bruta nem headers
sensíveis.

Texto de rascunho ainda visível e home desatualizada geram, respectivamente,
`PUBLIC_ARTICLE_CONTAINS_DRAFT_LANGUAGE` e
`HOMEPAGE_LATEST_ARTICLE_OUTDATED`. São warnings explícitos e não ocultam a
publicação. Data observada em HTTP é evidência da consulta, não prova do
horário original de deploy. Quando esse horário não foi fornecido, a
reconciliação registra `CONFIRMATION_TIME_NOT_ORIGINAL_DEPLOY_TIME`.

## Persistência, replay e auditoria

A migration 014 cria:

- `publication_reconciliations`;
- `publication_public_verifications`;
- `publication_verification_checks`.

Fingerprint e chave idempotente protegem a identidade funcional. Repetir o
mesmo comando retorna `replayed: true` sem nova verificação, linha, check,
evento ou transição. Reutilizar a mesma chave com URL, commit, origem ou
operador incompatível gera
`PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT`. Concorrência é serializada
por locks do pacote e da notícia.

Os eventos persistidos são:

1. `PUBLICATION_RECONCILIATION_REQUESTED`;
2. `PUBLICATION_PUBLIC_VERIFICATION_STARTED`;
3. `PUBLICATION_PUBLIC_VERIFICATION_COMPLETED`;
4. `PUBLICATION_EXTERNALLY_CONFIRMED`;
5. `PUBLICATION_MARKED_AS_PUBLISHED`.

Todos registram ator humano e origem manual. Nenhum evento afirma que o sistema
executou o deploy.

## Comandos

```bash
npm run publication:reconcile:list-ready
npm run publication:verify-public -- --publication <id> --url <https-url>
npm run publication:reconcile -- \
  --publication <id> \
  --draft <id> \
  --operator <id> \
  --origin MANUAL_SUPERVISED_DEPLOY \
  --url <https-url> \
  --canonical <https-url> \
  --website-commit <git-hash> \
  --deployment-target "<rotulo>"
npm run publication:reconcile:show -- --reconciliation <id>
npm run publication:reconcile:list
npm run demo:publication-reconciliation
npm run demo:publication-reconciliation:postgres
```

`publication:verify-public` é somente leitura e não muda estado.
`publication:reconcile` verifica novamente antes da primeira gravação. Não
existe comando de deploy.

## Caso real e limitações

O pacote `publication-d8d1213c06e895458cb07531`, ligado ao draft
`draft-aee4cb163fed892025ce0b58-v2`, foi associado ao artigo público em
`andrestudio.dev.br` e ao commit de website `7ea0d4a`. A origem registrada é
`MANUAL_SUPERVISED_DEPLOY`: o sistema reconciliou e verificou uma publicação
manual externa; não publicou o artigo.

A verificação prova o estado público observado no momento da consulta. Ela não
prova quem executou o deploy, o instante original, a configuração interna do
servidor ou a permanência futura da página. Warnings editoriais devem ser
tratados em uma etapa autorizada separadamente. Não há publicação automática,
Telegram, LLM ou correção remota.
