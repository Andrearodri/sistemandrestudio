# Etapa 12.6 — integração local do artigo no website

Status: `WEBSITE_LOCAL_INTEGRATION_READY`
Data: 2026-07-28
Website: `/Users/andre10/Downloads/andrestudio.dev`
Sistema editorial: `/Users/andre10/Documents/sistemandrestudio`

## Resultado

O artigo aprovado no pacote
`publication-d8d1213c06e895458cb07531`, draft
`draft-aee4cb163fed892025ce0b58-v2`, foi convertido de forma controlada para o
HTML estático do website. Não houve alteração no pacote editorial.

A integração existe somente na cópia local. Não houve publicação remota,
deploy, push, configuração de remoto, acesso a EC2, DNS, Registro.br, Nginx
remoto, certificado, SSH, SFTP, FTP, API, Cloudflare ou GitHub.

## Controle de versão local

O website não possuía Git. Foi inicializado um repositório exclusivamente local
em `main`, sem remoto configurado.

- commit-base: `7784a42 chore: establish website baseline`;
- commit da integração:
  `7ea0d4a feat(blog): add Grounding with Parallel article`.

Antes do baseline, o `.gitignore` existente recebeu somente as exclusões
explícitas `tmp/` e `backups/`. O baseline registrou 66 arquivos legítimos do
site. Arquivos de ambiente, chaves, certificados, dependências, builds,
temporários e backups estão ignorados. A varredura controlada por padrões
reconhecíveis não encontrou segredos.

Após o commit da integração, o Git do website estava limpo e `git remote -v`
permaneceu vazio.

## Arquivos

Criado:

- `blog/grounding-with-parallel-foi-anunciado-oficialmente/index.html`.

Alterados:

- `blog/index.html`;
- `sitemap.xml`.

O commit da integração contém exatamente esses três arquivos, com 219 linhas
adicionadas e 2 removidas. CSS, JavaScript, Nginx, artigos anteriores e demais
arquivos permaneceram inalterados.

## Template e conteúdo

O template principal foi
`blog/como-preparar-material-para-edicao-de-video/index.html`, comparado também
com `blog/google-gemini-3-6-flash/index.html`.

Foram preservados:

- estrutura HTML global;
- cabeçalho, navegação e breadcrumbs;
- classes e layout editorial;
- sumário lateral;
- bloco de autor;
- rodapé;
- tema e script local existentes;
- comportamento responsivo.

O corpo utiliza somente o fato e os blocos aprovados:

- “O Google anunciou oficialmente Grounding with Parallel.”;
- registro com evidências oficiais;
- aviso de revisão humana;
- fonte canônica do Google Developers Blog.

Não foram adicionadas alegações de disponibilidade, preço, lançamento, versão,
performance, compatibilidade, vantagem, comparação, promessa, recomendação ou
opinião atribuída ao autor.

## Metadados

- título: `Grounding with Parallel foi anunciado oficialmente.`;
- categoria: `Inteligência Artificial`;
- autor: `André Rodrigues`;
- marca editorial: `AndréStudio.dev`;
- idioma: `pt-BR`;
- publicação: `2026-07-28`;
- modificação: `2026-07-28`;
- tempo: `1 min de leitura`;
- slug: `grounding-with-parallel-foi-anunciado-oficialmente`;
- canonical:
  `https://andrestudio.dev.br/blog/grounding-with-parallel-foi-anunciado-oficialmente/`;
- descrição:
  `O Google anunciou oficialmente Grounding with Parallel. Confira o resumo factual e a fonte oficial do Google Developers Blog.`

Open Graph e Twitter Card usam o mesmo título, descrição, URL oficial e o asset
local `assets/optimized/showcase-ai.jpg`. O arquivo existe e já era usado pelo
hub do blog como grafismo abstrato genérico de inteligência artificial. Não
houve download, geração, hotlink ou uso de imagem específica de outro produto.

O JSON-LD contém um objeto `Article` com os campos exigidos e um
`BreadcrumbList` coerente com a navegação visual. A imagem declarada existe no
website.

## Mapeamento do pacote para HTML

| Campo aprovado | Elemento no website |
| --- | --- |
| `title` | `<title>`, H1, Open Graph, Twitter e `headline` |
| `subtitle` | lede visual |
| `slug` | diretório, rota, canonical e `mainEntityOfPage` |
| `author` | meta author, bloco visual e JSON-LD |
| `brand` | título, Open Graph e publisher |
| `body` | seções semânticas dentro de `.article-body` |
| `citations[0].canonicalUrl` | link HTTPS da seção “Fonte oficial” |
| `citations[0].title` | identificação textual da fonte |
| `status` | pré-condição de integração; não exposto como estado público |
| `warnings` | validado como vazio antes da conversão |

Categoria, data pública, tempo de leitura e descrição SEO vieram da autorização
expressa da Etapa 12.6. Nenhuma ferramenta externa de conversão foi usada.

## Blog e sitemap

O novo artigo ocupa a posição de “Artigo mais recente” em `blog/index.html`.
Os dois artigos anteriores permanecem presentes, na mesma ordem cronológica
relativa e com seus links e conteúdos preservados.

O sitemap recebeu somente:

`https://andrestudio.dev.br/blog/grounding-with-parallel-foi-anunciado-oficialmente/`

com `lastmod` em `2026-07-28`, `changefreq` anual e prioridade `0.8`, seguindo o
padrão editorial existente. Nenhuma URL anterior foi alterada.

Todos os URLs absolutos novos usam `https://andrestudio.dev.br`. Nenhuma
referência DuckDNS foi adicionada ou removida.

## Validações

### Sistema editorial

- `npm run typecheck`: aprovado;
- `npm run test`: 243 aprovados, 0 falhos;
- manifesto: dois arquivos presentes e hashes correspondentes;
- pacote: `READY_FOR_PUBLICATION`;
- draft: versão 2;
- artefatos com status `PUBLISHED`: nenhum encontrado.

O script `npm run test` atual executa 243 testes. O total histórico de 387
pertence à matriz ampliada de suítes, que não foi iniciada nesta integração
local.

### HTML, links e assets

- tags principais balanceadas nos dois HTML alterados;
- `lang="pt-BR"`, title, description e canonical presentes;
- dois blocos JSON-LD parseáveis;
- todos os campos obrigatórios do `Article` presentes;
- XML do sitemap parseável;
- todos os links e assets locais referenciados resolvidos;
- fonte oficial canônica presente;
- links externos em nova aba com `rel="noopener noreferrer"`;
- nenhum `javascript:`, `data:` ou `file:` em `href` ou `src`;
- nenhuma referência DuckDNS nos arquivos integrados;
- nenhuma imagem quebrada;
- nenhum termo factual bloqueado no corpo do artigo;
- nenhum script inesperado: apenas inicialização de tema, JSON-LD e
  `/script.js`;
- `git diff --check`: aprovado para a integração.

O `tidy` disponível no sistema usa uma gramática anterior ao HTML5 e reporta
elementos semânticos válidos, como `header`, `nav`, `main` e `article`, como
desconhecidos. Por isso, a validação conclusiva foi feita com parser HTML,
parsing dos JSON-LD, inspeção do DOM real e navegador local.

## Servidor e inspeção visual

Foi iniciado temporariamente:

`python3 -m http.server 4173 --bind 127.0.0.1`

As rotas `/`, `/blog/` e
`/blog/grounding-with-parallel-foi-anunciado-oficialmente/` responderam HTTP
200. CSS, JavaScript e assets solicitados também responderam normalmente. O
servidor foi encerrado ao final.

A inspeção visual local confirmou:

- título, breadcrumbs e metadados visuais;
- autor, data e tempo de leitura;
- corpo factual e fonte oficial;
- sumário no desktop;
- card na primeira posição do blog;
- três artigos na ordem esperada;
- rodapé;
- nenhuma imagem quebrada;
- nenhum overflow horizontal;
- layout mobile com navegação e aside adaptados;
- zero erros ou warnings de console.

Capturas diagnósticas foram geradas somente em `/private/tmp`, fora dos dois
repositórios:

- `/private/tmp/andrestudio-article-desktop.png`;
- `/private/tmp/andrestudio-article-mobile.png`;
- `/private/tmp/andrestudio-blog-desktop.png`.

## Rollback validado

Os arquivos alterados foram preservados também em `tmp/`, ignorado pelo Git.
O rollback por Git foi testado com stash recuperável:

1. a página nova desapareceu;
2. as referências foram removidas do índice e do sitemap;
3. a árvore voltou ao baseline;
4. o stash foi reaplicado;
5. os hashes dos três arquivos restaurados corresponderam exatamente aos
   hashes anteriores ao teste;
6. o stash temporário foi removido automaticamente após aplicação bem-sucedida.

A integração permaneceu presente e foi commitada após o teste.

## Limitações e próximo passo

Não existe build, CMS, backend ou suíte própria de testes no website. As
validações são estáticas e locais. DNS, propagação, HTTPS, domínio público,
configuração ativa do servidor e comportamento remoto continuam não
verificados.

Próximo passo recomendado: revisar visual e editorialmente o commit local
`7ea0d4a`. Qualquer preparação de servidor, DNS, HTTPS ou publicação remota
exige uma autorização nova e explícita.
