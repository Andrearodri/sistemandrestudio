# Pacotes locais de publicação

A Etapa 12.1 transforma somente uma versão explicitamente aprovada em arquivos locais supervisionados. `READY_FOR_PUBLICATION` significa que Markdown, JSON e manifesto foram validados; não significa publicação.

## Elegibilidade e política

A política `andre-studio-publication-package-v1` exige estado aprovado, decisão humana, reviewer ID, mesma versão, validação não bloqueada e citações HTTPS. Os destinos suportados são `LINKEDIN_EXPORT` e `WEBSITE_EXPORT`.

## Arquivos e manifesto

As saídas ficam sob `output/linkedin`, `output/website` e `output/manifests`, diretório ignorado pelo Git. LinkedIn recebe Markdown e JSON; website recebe Markdown com front matter seguro e JSON estruturado. O manifesto registra identidade, aprovação, hashes, caminhos relativos, tamanhos, citações e warnings sem duplicar o corpo.

Identidade, slug e hashes são determinísticos. A escrita usa arquivo temporário na própria raiz, sincronização e rename. Arquivo idêntico produz replay; conteúdo divergente gera conflito sem sobrescrita. Paths absolutos, traversal, HTML, scripts, URLs não HTTPS e raízes inseguras são bloqueados.

## Persistência e comandos

A migration 012 cria pacotes, arquivos e citações. Persistência, transição para `READY_FOR_PUBLICATION` e auditoria ocorrem em transação PostgreSQL. Use `publication:list-eligible`, `publication:preview`, `publication:export`, `publication:list` e `publication:show`. Preview não produz efeitos; exportação exige ação explícita e o mesmo revisor que aprovou.

As demos `demo:publication` e `demo:publication:postgres` usam fixtures e limpam apenas seus diretórios temporários. Não há rede, credenciais, API remota, LLM ou postagem automática.

Um pacote `WEBSITE_EXPORT` pronto pode alimentar o planejamento descrito em
[`WEBSITE-PUBLICATION-PLANNING.md`](WEBSITE-PUBLICATION-PLANNING.md). Criar o
plano não altera o pacote nem autoriza publicação.

O pacote não fixa domínio, framework, diretório, rota ou build do site. O perfil
v2 planeja para `andrestudio.dev.br`; DuckDNS é apenas histórico técnico.

Depois de uma publicação manual supervisionada, um pacote `WEBSITE_EXPORT`
pode ser reconciliado pelo fluxo descrito em
[`PUBLICATION-RECONCILIATION.md`](PUBLICATION-RECONCILIATION.md). Somente
verificação pública bem-sucedida permite `PUBLISHED`; arquivos, hashes,
manifesto, draft e aprovação permanecem imutáveis. A reconciliação registra o
fato externo e nunca afirma que o sistema fez deploy.
