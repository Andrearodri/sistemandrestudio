# Fontes oficiais do radar — sistemandrestudio

## Escopo

Esta etapa usa somente GETs sem autenticação para feeds públicos e oficiais. O
catálogo inicial tem cinco fontes, todas relacionadas ao posicionamento técnico
da AndreStudio.dev. Nenhuma página é raspada: cada adaptador lê apenas o feed
RSS ou Atom informado abaixo.

## Catálogo validado

Diagnóstico realizado em 24 de julho de 2026, limitado a três itens por fonte:

| sourceId | Organização | URL configurada | Esperado / recebido | Redirects e domínio final | HTTP / content type | Itens | Parser | Estado |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| `cloudflare-blog` | Cloudflare | `https://blog.cloudflare.com/rss/` | RSS / RSS | 0 / `blog.cloudflare.com` | 200 / `application/rss+xml` | 3 | sucesso | `ENABLED_VALIDATED` |
| `github-blog` | GitHub | `https://github.blog/feed/` | RSS / RSS | 0 / `github.blog` | 200 / `application/rss+xml` | 3 | sucesso após regressão CDATA | `ENABLED_VALIDATED` |
| `nodejs-blog` | Node.js | `https://nodejs.org/en/feed/blog.xml` | AUTO / RSS | 0 / `nodejs.org` | 200 / `application/xml` | 3 | sucesso | `ENABLED_VALIDATED` |
| `google-developers-blog` | Google Developers | `https://developers.googleblog.com/feeds/posts/default?alt=rss` | RSS / RSS | 1 / `developers.googleblog.com` | 200 / `application/rss+xml` | 3 | sucesso | `ENABLED_VALIDATED` |
| `react-blog` | React | `https://react.dev/rss.xml` | RSS / RSS | 0 / `react.dev` | 200 / `application/xml` | 3 | sucesso | `ENABLED_VALIDATED` |

Os tamanhos observados ficaram abaixo do limite de 1 MB: aproximadamente
376 KB (Cloudflare), 148 KB (GitHub), 319 KB (Node.js), 17 KB (Google
Developers) e 18 KB (React). Esses valores são diagnósticos variáveis, não
contratos.

## GitHub

O feed oficial é RSS válido. O erro anterior era causado por um `DOCTYPE HTML`
dentro do `CDATA` de `content:encoded`; a verificação antiga procurava o token
em qualquer posição e o confundia com uma DTD XML ativa. O parser agora ignora
tokens encapsulados em `CDATA` ao procurar declarações XML ativas. DTD e
entidades externas fora de `CDATA` continuam rejeitadas. Uma fixture mínima,
sanitizada e sem conteúdo editorial extenso protege essa regressão.

## React

A fonte permanece habilitada. A página oficial `https://react.dev/blog`
declara diretamente:

```html
<link rel="alternate" type="application/rss+xml"
  title="React Blog RSS Feed" href="/rss.xml">
```

Assim, `/rss.xml` é oferecido pelo próprio site oficial, não por terceiro ou
conversor externo. A validação confirmou RSS, HTTP 200 e domínio final
`react.dev`.

Os IDs, URLs, tópicos, status e limites vivem no catálogo versionado do pacote
`sources`. O catálogo é a única origem de URLs de rede; nenhuma URL recebida de
usuário, feed ou item é usada como destino de coleta.

## Fontes adiadas

OpenAI aparece como tema prioritário, mas a página oficial de notícias não foi
incluída nesta etapa porque não foi identificado um feed RSS ou Atom oficial e
estável adequado. A página não será raspada. Anthropic e AWS também ficam
adiados até haver endpoints de feed oficiais adequados e revisados.

## Operação segura

- modo padrão: `READ_ONLY_EXTERNAL`;
- somente HTTPS e hosts explicitamente permitidos no catálogo;
- sem cookies, autenticação, envio de dados ou publicação;
- no máximo cinco fontes e itens limitados por fonte;
- timeout, tamanho máximo, redirects limitados e retry controlado;
- conteúdo XML/HTML é dado não confiável, nunca instrução.

Para adicionar uma fonte, registre o feed oficial, organização, justificativa,
hosts permitidos, tópicos e limites no catálogo; acrescente fixture local e
testes antes de habilitá-la. Para interromper uma fonte, altere `enabled` para
`false`; o radar a ignora sem remover o histórico persistido.
