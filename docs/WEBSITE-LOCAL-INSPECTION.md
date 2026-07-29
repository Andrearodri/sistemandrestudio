# Etapa 12.5 — inspeção local do website AndréStudio.dev

Data da inspeção: 2026-07-28
Website inspecionado: `/Users/andre10/Downloads/andrestudio.dev`
Sistema editorial: `/Users/andre10/Documents/sistemandrestudio`

## Escopo e garantias

Esta inspeção foi executada somente em leitura no website. Os caminhos foram
resolvidos com `realpath` e são diretórios distintos, regulares e não
redirecionados por symlink. Nenhum script do website foi executado, nenhuma
dependência foi instalada e nenhum arquivo do website foi criado, alterado,
removido ou copiado.

Não houve rede autenticada, consulta ou alteração de DNS, acesso a EC2, SSH,
SFTP, FTP, API remota, Nginx ativo, certificados ou Registro.br. Não houve
deploy, publicação, commit ou push. Arquivos `.env`, credenciais, chaves e
certificados privados não foram lidos.

## Estado do Git

### Website

`/Users/andre10/Downloads/andrestudio.dev` não é um repositório Git. Portanto,
branch, status, histórico, último commit, remoto e alterações locais anteriores
não podem ser determinados pelo Git. A ausência de Git aumenta o risco de
rollback e exige uma cópia local controlada ou a inicialização deliberada de
controle de versão antes de uma futura integração.

### Sistema editorial

O `sistemandrestudio` estava limpo antes da criação deste relatório, em `main`,
com `39fa919 feat(publication): add supervised website dry-run planning` como
último commit. `git ls-files -- .env .env.local .env.test` não retornou
arquivos. O pacote `publication-d8d1213c06e895458cb07531`, seus dois artefatos
de website e seu manifesto estão presentes com status
`READY_FOR_PUBLICATION`. A varredura dos artefatos em `output/` não encontrou
status `PUBLISHED`.

`npm run typecheck` foi aprovado. `npm run test` foi aprovado com 243 testes.
O valor de 387 não é produzido pelo script `test` atual: ele corresponde à
matriz ampliada de suítes do projeto, enquanto o comando solicitado executa
somente as suítes definidas em `test`. Nesta inspeção não foram iniciados
PostgreSQL nem suítes de integração adicionais apenas para reproduzir a matriz
ampliada.

## Stack e arquitetura detectadas

| Item | Resultado | Evidência |
| --- | --- | --- |
| Plataforma | Site estático | Páginas `index.html` por diretório, CSS e JavaScript locais |
| Framework | Nenhum detectado | Não há configuração de Next, Astro, Nuxt, Gatsby, Vite ou equivalente |
| Linguagens | HTML, CSS e JavaScript | Arquivos `.html`, `style.css`, `home.css` e `script.js` |
| Gerenciador de pacotes | `UNKNOWN` / não configurado | Não há `package.json` nem lockfile na raiz |
| Bundler | `UNKNOWN` / não configurado | Nenhuma configuração de bundler encontrada |
| Node esperado | `UNKNOWN` / não requerido pelo código inspecionado | Nenhum manifesto ou configuração Node |
| Scripts | Nenhum configurado | Não há `package.json` |
| Renderização | HTML estático, sem SSR, SSG ou SPA detectados | Rotas materializadas em arquivos |
| Backend | Não detectado | Nenhum servidor ou endpoint local encontrado |
| CMS | Não detectado | Nenhuma configuração ou cliente de CMS encontrado |
| Banco | Não detectado | Nenhuma configuração ou acesso a banco encontrado |
| Hospedagem | Nginx/EC2 documentados; arquivos auxiliares para hosts estáticos | Configurações em `deploy/nginx/`, `_headers` e `_redirects` |

Os arquivos `_headers` e `_redirects` são compatíveis com hosts estáticos, mas
não comprovam uso atual de Cloudflare Pages ou Netlify. Não há evidência de
Vercel. As configurações Nginx e os documentos de validação registram uma
arquitetura de hospedagem estática em servidor, mas nenhum ambiente remoto foi
consultado.

## Estrutura e rotas

A página inicial é `/index.html`. As rotas usam diretórios com `index.html`,
por exemplo:

- `/blog/`;
- `/blog/google-gemini-3-6-flash/`;
- `/blog/como-preparar-material-para-edicao-de-video/`;
- `/sobre/`, `/contato/`, `/portfolio/`, `/privacidade/`;
- páginas de serviços e cases em seus respectivos diretórios.

Não há rota dinâmica. O Nginx versionado usa resolução de arquivo ou diretório,
coerente com esse modelo. O blog é uma listagem HTML manual em
`blog/index.html`; cada artigo é uma página HTML independente. A folha
`style.css` já contém os estilos `article-layout`, `article-body` e
`article-aside`. O documento `docs/IMPLEMENTACAO.md` determina que
`blog/como-preparar-material-para-edicao-de-video/index.html` seja usado como
base do template editorial.

Não foram encontrados Markdown, MDX ou JSON usados como fonte de artigos, nem
componentes React, Vue, Svelte ou Astro. Não há descoberta automática de
conteúdo.

## Estratégia de conteúdo

Classificação: `HARDCODED_COMPONENT`.

Neste contexto, “componente” significa um bloco HTML codificado diretamente,
não um componente de framework. O slug é o nome do diretório abaixo de
`blog/`. A página individual é renderizada pelo `index.html` desse diretório.
Para aparecer no hub, o artigo precisa ser incluído manualmente em
`blog/index.html`. A URL também precisa ser acrescentada manualmente a
`sitemap.xml`.

Localização recomendada:

`blog/grounding-with-parallel-foi-anunciado-oficialmente/index.html`

Rota pública prevista:

`/blog/grounding-with-parallel-foi-anunciado-oficialmente/`

## Domínio, identidade e SEO

| Item | Classificação | Resultado |
| --- | --- | --- |
| URL base/canonical | `USES_OFFICIAL_DOMAIN` | `https://andrestudio.dev.br` em páginas e configuração oficial |
| Open Graph | `USES_OFFICIAL_DOMAIN` | URLs e imagens absolutas no domínio oficial |
| Twitter Cards | `USES_OFFICIAL_DOMAIN` | Cards configurados; imagens usam URL oficial |
| Sitemap | `USES_OFFICIAL_DOMAIN` | Todas as URLs inspecionadas usam o domínio oficial |
| Robots | `USES_OFFICIAL_DOMAIN` | Aponta para o sitemap oficial |
| JSON-LD | `USES_OFFICIAL_DOMAIN` | Article/Organization usam URLs oficiais |
| Links internos | `USES_RELATIVE_URL` | Navegação interna usa caminhos iniciados em `/` |
| Formulários | `NOT_CONFIGURED` | Não foi encontrado formulário HTML de submissão |
| Contato | `USES_RELATIVE_URL` e links externos | Página local e links externos manuais |

A identidade `AndreStudio.dev` está presente no conteúdo e nos metadados.
Não foram encontradas as marcas “André Digital Arts” ou “Andre Digital Arts”.

As referências a `andrestudiodev.duckdns.org` estão restritas às configurações
legadas de Nginx. Outros domínios técnicos legados também aparecem somente em
configurações históricas específicas. Eles devem permanecer preservados nesta
etapa, conforme a exigência operacional. O domínio oficial já está configurado
no código, mas sua atividade pública não foi validada:

- `DOMAIN_DNS_CONFIGURATION_PENDING`;
- `DOMAIN_PROPAGATION_PENDING`;
- `HTTPS_NOT_YET_VERIFIED`;
- `CANONICAL_DOMAIN_NOT_YET_ACTIVE`.

O código de artigo existente inclui `title`, description, canonical, autor,
Open Graph de artigo, Twitter Card, datas, imagem, `Article` em JSON-LD,
breadcrumbs, H1, corpo semântico, fontes oficiais, sumário lateral, links
internos e bloco de autor. O sitemap e o robots também estão configurados.

## Compatibilidade do pacote aprovado

O pacote aprovado contém Markdown e JSON, mas o website não possui consumidor
para nenhum desses formatos. Portanto, nenhum dos dois pode ser simplesmente
copiado para produzir uma página pública.

### Markdown

Compatibilidade estrutural: parcial. O conteúdo e o front matter servem como
fonte controlada, mas precisam de conversão determinística para o template
HTML. O front matter do pacote não é lido pelo site e seus nomes de campos não
correspondem a um schema local, pois tal schema não existe.

### JSON

Compatibilidade estrutural: parcial. O JSON é útil como fonte e trilha de
auditoria, porém o site não carrega JSON e não possui código para renderizá-lo.
Copiá-lo para o diretório servido aumentaria a superfície pública sem benefício
funcional. Ele deve permanecer no sistema editorial, salvo decisão futura por
uma arquitetura orientada a dados.

### Mapeamento necessário

| Campo do pacote | Destino no website | Estado |
| --- | --- | --- |
| `slug` | nome do diretório, canonical, Open Graph e JSON-LD | `CONFIRMED` |
| `title` | `<title>`, H1, Open Graph e headline do JSON-LD | `CONFIRMED` |
| `subtitle` | lede; possível base da meta description | `PROVISIONAL` |
| `author` | meta author, bloco visual e JSON-LD | `CONFIRMED` |
| `body` | HTML semântico dentro de `.article-body` | `CONFIRMED` |
| `citations` | seção “Fontes oficiais”, preservando URLs | `CONFIRMED` |
| `warnings` | bloqueio ou aviso explícito antes da conversão | `CONFIRMED` |
| `status` | pré-condição `READY_FOR_PUBLICATION`; não vai para a página | `CONFIRMED` |
| `createdAt`/`approvedAt` | não equivalem automaticamente à data pública | `PROVISIONAL` |
| categoria | label, `article:section` e JSON-LD | `BLOCKED` — não fornecida de forma compatível |
| tempo de leitura | label do artigo e card | `BLOCKED` — precisa ser calculado/confirmado |
| imagem e texto alternativo | Open Graph, JSON-LD, card do índice | `BLOCKED` — decisão editorial pendente |
| descrição SEO final | meta description e Open Graph description | `PROVISIONAL` |

A conversão futura não deve reescrever fatos, inserir alegações, remover
citações ou alterar o pacote aprovado. Ela deve escapar HTML, preservar links
de fontes e seguir o template já existente.

## Build, preview e validações

Não existe comando de build, test, typecheck, lint, preview ou check no
website. Não há `package.json`, lockfile, bundler ou diretório de saída
configurado.

Resultado: `BUILD_NOT_EXECUTED`.

Motivo: o projeto já contém os artefatos estáticos finais e não oferece um
pipeline de build comprovado. Nenhum comando foi inventado e nenhum servidor de
preview foi iniciado. Em uma integração futura, as validações seguras devem
abranger HTML, links internos, canonical/metadata/JSON-LD, entrada do índice,
sitemap e comparação do inventário de arquivos. A ferramenta exata de
validação permanece `UNKNOWN`.

Diretório de saída: a própria raiz do website estático. Não há diretório
gerado separado.

## Resultado do inspetor automatizado

Comando:

```text
npm run website:inspect-local -- --path /Users/andre10/Downloads/andrestudio.dev
```

Resultado:

- raiz resolvida corretamente;
- 66 arquivos contados pelo limite/profundidade do inspetor;
- `hasPackageJson: false`;
- `detectedPlatform: UNKNOWN`;
- avisos `READ_ONLY_INSPECTION` e `NO_COMMAND_EXECUTED`.

O resultado é coerente quanto à raiz, ausência de manifesto e garantias de
leitura. A divergência é de capacidade: o inspetor atual classifica a
plataforma sempre como `UNKNOWN`, enquanto a análise manual comprovou um site
estático de HTML/CSS/JavaScript e estratégia `HARDCODED_COMPONENT`. Isso não é
um defeito de segurança e não foi corrigido nesta etapa.

## Plano de integração local

| Operação | Estado | Plano |
| --- | --- | --- |
| `COPY_APPROVED_MARKDOWN` | `NOT_REQUIRED` | O site não consome Markdown |
| `COPY_APPROVED_JSON` | `NOT_REQUIRED` | O site não consome JSON |
| `CONVERT_FRONT_MATTER` | `CONFIRMED` | Mapear metadados para `<head>`, header e JSON-LD |
| `CREATE_ARTICLE_COMPONENT` | `CONFIRMED` | Criar `blog/<slug>/index.html` a partir do template existente |
| `CREATE_DYNAMIC_ROUTE` | `NOT_REQUIRED` | A rota é materializada pelo diretório |
| `UPDATE_NEWS_INDEX` | `CONFIRMED` | Adicionar card em `blog/index.html` |
| `UPDATE_SITEMAP` | `CONFIRMED` | Adicionar a URL oficial do artigo |
| `UPDATE_METADATA` | `CONFIRMED` | Criar metadata própria da nova página |
| `UPDATE_CANONICAL_DOMAIN` | `NOT_REQUIRED` | O domínio oficial já está no código |
| `UPDATE_LEGACY_DOMAIN_REFERENCES` | `NOT_REQUIRED` | Configurações legadas devem ser preservadas |
| `RUN_TYPECHECK` | `NOT_REQUIRED` | Website não usa TypeScript |
| `RUN_TESTS` | `BLOCKED` | Nenhum script de teste configurado |
| `RUN_BUILD` | `NOT_REQUIRED` | Não há etapa de build |
| `PREVIEW_LOCAL` | `PROVISIONAL` | Servidor estático local, somente após autorização |

Arquivos a criar futuramente:

- `blog/grounding-with-parallel-foi-anunciado-oficialmente/index.html`.

Arquivos a alterar futuramente:

- `blog/index.html`;
- `sitemap.xml`.

Nenhuma alteração global de CSS ou JavaScript é necessária com a evidência
atual. Uma imagem nova não deve ser criada ou reutilizada sem decisão
editorial explícita.

### Sequência futura proposta

1. Obter autorização e resolver categoria, tempo de leitura, data pública,
   descrição SEO e imagem.
2. Criar uma cópia de trabalho recuperável do website, porque ele não possui
   Git.
3. Converter o pacote aprovado para HTML usando o template existente, sem
   alteração factual.
4. Criar somente a nova página e atualizar índice e sitemap.
5. Validar estrutura, links, fontes, canonical, Open Graph, Twitter Card,
   JSON-LD, acessibilidade básica e ausência de referências indevidas.
6. Fazer preview exclusivamente local.
7. Apresentar o diff/inventário para revisão humana.
8. Manter deploy, DNS, Nginx e publicação bloqueados.

## Plano DRY_RUN

Não foi criada uma nova versão do plano DRY_RUN. Embora a inspeção manual
tenha obtido informações suficientes para o plano de integração acima, o
modelo atual do `sistemandrestudio` restringe `detectedPlatform` a `UNKNOWN` e
não representa `HARDCODED_COMPONENT`. Gerar outro plano com o perfil v2
repetiria dados provisórios incorretos; alterar o modelo seria nova
funcionalidade fora do escopo de inspeção.

O plano anterior `website-plan-8d0319056762d8e7404f1293` permanece preservado.
Uma versão posterior deverá ter nova identidade e novo perfil que representem:
site estático, conteúdo HTML codificado, diretório `blog/<slug>/`, rota
`/blog/<slug>/`, ausência de build e ausência de restart local.

## Rollback local

Como o website não possui Git, o rollback futuro deve ser preparado antes de
qualquer escrita:

1. produzir um inventário com hash, tamanho e data dos arquivos existentes;
2. guardar cópias locais somente de `blog/index.html` e `sitemap.xml` em área
   de trabalho controlada, sem secrets;
3. registrar que o novo diretório do artigo não existia;
4. após eventual integração, reverter removendo exclusivamente o novo
   diretório e restaurando as duas cópias verificadas;
5. repetir as validações locais e comparar o inventário.

Inicializar Git no website seria uma alternativa mais robusta, mas exige
autorização separada e não foi feito nesta etapa.

## Riscos e pendências

- ausência de Git no website e, portanto, rollback menos robusto;
- processo editorial manual sujeito a divergência entre artigo, índice e
  sitemap;
- ausência de parser Markdown/JSON e risco de conversão incorreta;
- ausência de testes, linter, validador HTML e pipeline de build configurados;
- escolha pendente de categoria, tempo de leitura, data pública, imagem,
  texto alternativo e descrição SEO;
- domínio oficial presente no código, mas DNS, propagação e HTTPS não
  verificados;
- configurações legadas de Nginx coexistem intencionalmente com a oficial;
- comportamento real do host/EC2 e caminho ativo de deploy permanecem
  `UNKNOWN`;
- nenhuma validação pública ou remota foi realizada.

## Ações bloqueadas nesta etapa

Alteração do website, conversão do artigo, preview, criação de plano v3,
publicação, deploy, conexão remota, modificação de DNS/Nginx/certificado,
remoção de domínio legado, commit e push permanecem bloqueados até revisão e
autorização explícita.
