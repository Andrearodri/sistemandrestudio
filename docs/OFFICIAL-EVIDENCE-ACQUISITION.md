# Aquisição segura de evidências oficiais

## Objetivo e fronteira

A Etapa 8 enriquece um item já persistido pelo radar usando somente sua URL
canônica oficial. O modo operacional é `READ_ONLY_EXTERNAL`: HTTPS e `GET`, sem
cookies persistentes, autenticação, JavaScript, formulários, escrita externa,
LLM, busca aberta, geração ou publicação.

O comando não recebe URL. `OfficialEvidenceAcquisitionService` carrega o item
pelo `radarItemId`, encontra a fonte no catálogo versionado e só então permite a
aquisição.

```text
item persistido → política da fonte → HTTP fora da transação
→ parsing estático → associação determinística
→ transação PostgreSQL → verificação factual → transição editorial
```

## Arquitetura

- `packages/sources` mantém a allow-list versionada por fonte;
- `packages/evidence` contém política, cliente HTTP, parser estático, builder e
  serviço de aquisição, sem SQL;
- `packages/content-engine` continua responsável pela decisão factual pura;
- `packages/application` prepara a operação de verificação;
- `packages/database` persiste aquisição e verificação na mesma transação;
- `apps/sistemandrestudio-api` oferece demos e o comando oficial controlado.

O domínio factual não importa HTTP, HTML, Cheerio ou PostgreSQL.

## Allow-list e navegação

Cada fonte declara hosts de entrada, redirects, hosts oficiais adicionais,
caminhos permitidos/bloqueados, páginas máximas e profundidade. A política v1
permite:

| Organização | Entrada | Destinos oficiais adicionais |
| --- | --- | --- |
| Cloudflare | `blog.cloudflare.com` | `developers.cloudflare.com` |
| GitHub | `github.blog` | `docs.github.com`, `github.com` |
| Node.js | `nodejs.org` | `github.com` |
| Google Developers | `developers.googleblog.com` | `developers.google.com`, `cloud.google.com` |
| React | `react.dev` | `github.com` |

Semelhança de nome não concede acesso. São permitidas no máximo três páginas
por item, duas relacionadas e profundidade um. Links relacionados precisam ter
tipo reconhecido: documentação, changelog, release, repositório ou advisory.
Não existe busca no site nem crawling recursivo.

## Cliente HTTP e SSRF

O cliente aceita somente HTTPS sem credenciais e porta padrão/443. Cada URL e
redirect passa por allow-list, política de caminho, DNS e validação de todos os
IPs resolvidos. São bloqueados localhost, loopback, redes privadas, link-local,
CGNAT, multicast, documentação/reservados, IPv4 mapeado em IPv6 e formas
numéricas normalizadas pela classe `URL`.

As respostas aceitas são `text/html`, `application/xhtml+xml`,
`application/json` e `application/ld+json`. PDF, mídia, executáveis e conteúdo
binário são recusados. O cliente usa redirects manuais, leitura em streaming
com limite, cancelamento, compressão da plataforma, user-agent identificável e
uma repetição apenas para falhas transitórias.

A resolução é validada antes da conexão, mas o `fetch` da plataforma pode
resolver o host novamente. Portanto ainda existe risco residual de DNS
rebinding entre validação e conexão. A mitigação futura é fixar o endereço no
dispatcher HTTP e restringir egress na rede. A allow-list curta e estática reduz
a exposição atual, mas não substitui esse controle futuro.

## Parsing, metadados e conteúdo mínimo

Cheerio `1.1.2` faz parsing estático; nenhum script é executado. O extrator
remove scripts, estilos, formulários, iframes, navegação, rodapé e elementos
ocultos. Páginas exclusivamente JavaScript retornam
`OFFICIAL_PAGE_JAVASCRIPT_REQUIRED`.

São considerados título, descrição, canonical como metadado não confiável, Open
Graph, Twitter Cards, datas, autor/organização, JSON-LD limitado, heading,
versão, produto, release e sinais de disponibilidade/changelog. JSON-LD
inválido é ignorado sem impedir o restante do parsing. A URL efetivamente
consultada, e não o canonical declarado pela página, define a origem confiável.

Não se persiste HTML. O snapshot contém título, resumo curto, headings
limitados, texto mínimo normalizado, metadados selecionados, datas e hash.
Trechos de evidência têm no máximo 500 caracteres.

## Associação com claims e contradições

O builder associa evidência somente por regras explícitas:

- lançamento/recurso exige linguagem clara, assunto e data compatíveis;
- versão exige versão coincidente em anúncio, changelog ou release;
- mudança de API exige identificadores técnicos compartilhados;
- depreciação exige aviso explícito de remoção, fim de suporte ou depreciação;
- disponibilidade exige declaração, data e qualificadores compatíveis;
- performance exige métrica e metodologia, nunca adjetivo promocional isolado.

Cada candidato registra ID determinístico, claim, fonte, URL, autoridade, tipo,
datas, trecho, fatos estruturados, suporte/contradição, regra, método e hash.
Contradições só são emitidas quando explícitas: indisponibilidade, remoção,
versão/data incompatível ou preview em vez de disponibilidade geral. Ambiguidade
permanece `INSUFFICIENT_EVIDENCE`.

A política `official-evidence-acquisition-v3` adiciona diagnóstico do funil,
normalização explicável de entidades e claims operacionais verificáveis.
`GENERAL_FACT` derivado apenas de título não cria evidência, e número de parte
de uma série não é versão. Veja
[`EVIDENCE-DIAGNOSTICS.md`](EVIDENCE-DIAGNOSTICS.md).

Texto externo, inclusive “ignore instruções”, “execute” ou “envie credenciais”,
é dado inerte. Ele não cria URLs, muda política, executa comandos nem altera a
decisão editorial.

## Persistência, idempotência e concorrência

A migration `006_official_evidence_acquisition.sql` adiciona:

- `evidence_acquisition_runs`;
- `official_page_fetch_runs`;
- `official_page_snapshots`;
- `official_page_metadata`;
- `evidence_candidates`.

Foreign keys, checks, limites, índices, hashes e versões de política protegem os
registros. A migration `007_evidence_acquisition_identity.sql` separa a chave
externa auditável da identidade interna de conteúdo. Como a 007 foi aplicada
durante a estabilização e permaneceu imutável, a migration incremental
`008_evidence_policy_versioning.sql` substitui os checks fixos da migration 006
por checks de formato, permitindo que uma nova versão de política gere nova
identidade sem alterar migrations já aplicadas.

A identidade interna v1 usa representação canônica de:

- ID do item e URL oficial sem fragmento;
- URL, relacionamento e hash mínimo de cada página, em ordem estável;
- ID/versão da política de aquisição;
- versão da política da fonte.

O hash mínimo da página já contém título, resumo, headings, texto normalizado,
metadados selecionados e tipo. Horários de recuperação, headers, duração,
whitespace irrelevante, valores de ambiente e IDs aleatórios não entram.

No modo operacional, esse SHA-256 deriva `acquisitionId`, `verificationId`,
`commandId`, IDs versionados de claims e a chave interna. Página inalterada
retorna `REPLAY`; página alterada produz `NEW_ACQUISITION_VERSION`. O modo
explícito continua associando diretamente a chave do chamador ao fingerprint e
recusa sua reutilização incompatível com
`EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT`.

HTTP e parsing ocorrem fora da transação. Na transação final, o adaptador confere
a versão esperada, persiste aquisição/candidatos e executa a verificação e a
transição editorial atomicamente. Conflito de concorrência ou falha de
persistência provoca rollback completo. Nenhuma transação fica aberta durante
rede externa.

Aquisições concorrentes são serializadas primeiro por item e depois pela
identidade. Mesmo hash cria uma aquisição e um replay; hashes distintos recebem
ordem determinística e preservam versões separadas. Uma reavaliação de item que
já saiu de `PENDING_VERIFICATION` registra novo resultado factual histórico,
sem forçar uma transição inexistente na máquina editorial.

## Limites

| Limite | Valor |
| --- | ---: |
| Itens por execução | 5 |
| Páginas por item | 3 |
| Páginas relacionadas | 2 |
| Profundidade | 1 |
| Resposta | 1.000.000 bytes |
| Requisição | 20 segundos |
| Item completo | 60 segundos |
| Redirects | 2 |
| Repetições transitórias | 1 |
| Título / resumo / trecho | 300 / 1.500 / 500 caracteres |
| Candidatos / headings | 20 / 20 |
| Texto mínimo normalizado | 6.000 caracteres |

Um `AbortSignal` compartilhado encerra DNS/requisições ao atingir o limite do
item, e a persistência é recusada após cancelamento.

## Comandos

```bash
npm run demo:evidence
npm run demo:evidence:postgres
npm run evidence:official
npm run evidence:diagnose
```

As demos usam fixtures locais. `evidence:official` processa no máximo cinco
itens reais já existentes, continua após erros controlados e nunca autentica,
gera conteúdo ou publica. A seleção exige fonte habilitada e URL HTTPS no host
de entrada da política; IDs, títulos, resumos, external IDs ou hashes com
marcadores explícitos de fixture, dado fictício, sintético, demo ou teste são
excluídos. A ordenação é por publicação/coleta mais recente, depois fonte e ID,
e elimina IDs repetidos antes de aplicar o limite.

Na estabilização de 24 de julho de 2026, a primeira execução criou cinco versões
de aquisição para itens reais do Google Developers. A segunda execução imediata
retornou cinco `REPLAY`, zero snapshots, evidências, resultados factuais e
eventos adicionais. Os cinco permaneceram `INSUFFICIENT_EVIDENCE`; nenhuma
regra foi relaxada para fabricar confirmação. A fixture legada que anteriormente
apontava para uma página inexistente deixou de ser elegível.

## Limitações e evolução

- páginas dependentes de JavaScript não são renderizadas;
- não há PDF, navegador headless, busca, crawling geral ou interpretação
  semântica complexa;
- o DNS não é fixado ao socket depois da validação;
- conteúdo oficial pode continuar insuficiente ou promocional;
- regras cobrem somente tipos iniciais de claim;
- o comando opera sobre o banco local e requer PostgreSQL.
- a seleção identifica fixtures/legados pelos metadados já disponíveis; ainda
  não existe uma flag de proveniência dedicada;
- reavaliação histórica não reabre estado editorial terminal.

Uma etapa futura poderá usar LLM apenas para sugerir associações ou revisão,
sempre como auxiliar, com evidências persistidas, schema estrito e decisão
determinística/humana. Isso não faz parte da Etapa 8.
