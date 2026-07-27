# Revisão editorial humana local

A Etapa 11 mantém a aprovação como ação humana explícita. Rascunhos persistidos em `PENDING_APPROVAL` podem ser listados e inspecionados; aprovação, rejeição e solicitação de revisão exigem `reviewerId`, versão esperada, justificativa e chave de idempotência. A revisão manual cria uma nova versão, preserva a anterior e revalida o texto contra o brief original. Fatos, evidências e citações não são alterados, e HTML, scripts, links arbitrários, sensacionalismo e fatos sem evidência são bloqueados.

Os comandos `review:list` e `review:official` são somente leitura. Nenhuma publicação, chamada externa, LLM, Telegram ou autenticação é usada nesta etapa. A migration `010_human_editorial_review.sql` registra decisões e solicitações com limites, chaves estrangeiras e unicidade de idempotência.

## Arquitetura e estados

O serviço de aplicação não conhece SQL. O adaptador PostgreSQL carrega o pacote, usa locks de linha e executa decisão, estado e auditoria na mesma transação. `CHANGES_REQUESTED` continua sendo o valor físico legado; `REVISION_REQUESTED` é o nome semântico exposto pelo fluxo novo. A revisão segue `REVISION_REQUESTED → DRAFT_CREATED → PENDING_APPROVAL`.

## Pacote, comandos e segurança

`review:show -- --draft ID` recupera notícia, versão, draft, brief, claims, fatos, evidências, citações, warnings e históricos sem acesso à internet. `review:approve`, `review:reject`, `review:request-changes` e `review:revise` exigem revisor explícito. A revisão aceita JSON local limitado e bloqueia HTML, handlers, esquemas perigosos, URLs não citadas, números/datas/versões sem suporte, sensacionalismo, certeza elevada e afirmações comerciais ou de desempenho não confirmadas.

As migrations 010 e 011 são incrementais: a primeira cria o registro de revisão; a segunda acrescenta fingerprint funcional, metadados auditáveis e versionamento de drafts. Replay usa chave e fingerprint persistentes; conteúdo incompatível gera conflito. Concorrência é protegida por versão esperada e `FOR UPDATE`; qualquer falha provoca rollback. A etapa não publica conteúdo e o draft real permanece pendente até uma decisão humana explícita.

Uma decisão `APPROVE` é pré-requisito para a Etapa 12.1, que apenas prepara arquivos locais e nunca substitui a decisão humana.
