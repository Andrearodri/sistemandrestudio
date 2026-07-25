# Diagnóstico da associação de evidências

## Objetivo

A Etapa 9 torna observável o trecho entre conteúdo oficial extraído, claim,
candidato e decisão factual. O diagnóstico é determinístico, local e somente
leitura. Ele não usa LLM, não busca páginas novas, não cria transições e não
altera resultados.

```text
claim criada
→ combinação claim × página extraída
→ compatibilidade por tipo
→ correspondência de entidade
→ compatibilidade temporal
→ invariantes por claim
→ score explicável
→ candidato aceito ou rejeitado
```

## Modos

- `DIAGNOSE_ONLY`: padrão de `npm run evidence:diagnose`; lê os cinco itens
  operacionais mais recentes e compara contagens persistentes antes/depois.
- `APPLY_VALIDATED_IMPROVEMENTS`: reservado ao fluxo normal
  `npm run evidence:official`. O comando diagnóstico recusa esse modo para
  impedir escrita acidental.

Nenhuma tabela foi adicionada. Claims, snapshots e resultados existentes são
recuperados do PostgreSQL; rejeições são recalculadas de forma pura.

## Funil e códigos

O relatório registra `claimsCreated`, `candidatesExtracted`,
`typeCompatible`, `entityCompatible`, `dateCompatible`, `accepted` e
`evidencePersistable`.

Os códigos estáveis incluem `CLAIM_ENTITY_MISSING`,
`CLAIM_TYPE_UNSUPPORTED`, `CLAIM_TOO_GENERIC`, `CLAIM_VERSION_MISSING`,
`PAGE_ENTITY_NOT_MATCHED`, `PAGE_DATE_NOT_MATCHED`,
`PAGE_TYPE_NOT_ELIGIBLE`, `EVIDENCE_TEXT_NOT_SPECIFIC`,
`EVENT_DATE_AMBIGUOUS`, `AVAILABILITY_PROOF_MISSING`,
`PERFORMANCE_PROOF_MISSING`, `CONTENT_PROMOTIONAL_ONLY`,
`ASSOCIATION_SCORE_TOO_LOW`, `NO_VERIFIABLE_CLAIM` e `ACCEPTED`.

Cada candidato contém regra, código, motivo, campos ausentes, método de
entidade, datas e breakdown do score. Trechos emitidos ficam limitados a 300
caracteres; HTML, cookies, headers sensíveis e configuração de banco não são
exibidos.

## Claims

Claims operacionais deixam de copiar todo título como `GENERAL_FACT`. A
inferência local aceita somente linguagem explícita de anúncio, versão ligada
a introdução/release ou mudança de API com identificador. Preview e beta
permanecem qualificadores e nunca viram GA.

Tutoriais, séries “Part N”, estudos de caso e textos promocionais sem fato
estruturado retornam `NO_VERIFIABLE_CLAIM`. “Part 1” não é versão.

## Entidades, aliases e versões

Os métodos são `EXACT_IDENTIFIER`, `NORMALIZED_EXACT`, `EXPLICIT_ALIAS`,
`PARTIAL_UNIQUE_MATCH` e `NO_MATCH`. A normalização cobre caixa, acentos,
hífen, underscore, espaços, pontuação e sufixos técnicos seguros.

O catálogo `evidence-entity-aliases-v1` é explícito e versionado; similaridade
ampla não é usada. `v2`, `2.0` e `Version 2` são comparáveis, mas números de
parte e números soltos não viram versões.

## Datas

Publicação, atualização, data esperada e data do evento aparecem
separadamente. A publicação só pode servir como data do evento quando a mesma
página contém linguagem explícita de anúncio, lançamento, introdução ou
disponibilidade. Caso contrário: `EVENT_DATE_AMBIGUOUS`.

Uma atualização recente não substitui a data antiga do evento. Documentação
relacionada sem data de anúncio não prova sozinha a data de lançamento.

## Páginas e conteúdo

O extrator preserva título, headings, primeiro parágrafo útil, listas de
mudanças, metadados limitados e até 6.000 caracteres de texto mínimo. Para
JSON-LD, prefere `Article`, `BlogPosting`, `NewsArticle`, `TechArticle`,
`SoftwareApplication` ou `Product` em vez do primeiro bloco, frequentemente
`BreadcrumbList`.

Uma página relacionada já tipada como documentação, changelog, release,
repositório ou advisory preserva esse tipo no fallback. Profundidade e
quantidade de páginas não foram ampliadas.

## Associação e score

O score expõe entidade, tipo de página, data, linguagem explícita, autoridade
e penalidades. Pontuação não compensa invariantes:

- entidade principal é obrigatória;
- versão precisa corresponder;
- preview não confirma disponibilidade geral;
- performance exige métrica e metodologia;
- claim temporal não usa publicação sem linguagem de evento;
- página incompatível continua bloqueada.

## Resultado real antes e depois

Linha de base em 24 de julho de 2026:

```text
5 claims
7 combinações claim × página
7 rejeições por CLAIM_TYPE_UNSUPPORTED
0 aceitas
```

Após os ajustes:

- LiteRT.js: entidade exata, data do `Article` e blog oficial; `CONFIRMED`;
- Ray 2.55: versão do resumo, entidade, versão e data compatíveis;
  `CONFIRMED`;
- Ray Part 2, AI Race Coach e o artigo de Tunix: sem claim verificável;
- documentação de LiteRT.js sem data de evento: `EVENT_DATE_AMBIGUOUS`.

Um resultado intermediário incorreto tratou “Part 1” como versão. Ele não criou
evento editorial, foi preservado no histórico e substituído por nova avaliação
versionada. A regra final bloqueia essa interpretação.

## Páginas relacionadas e limitações

Snapshots permitem recuperar páginas relacionadas consultadas. Links
rejeitados antes do fetch não eram persistidos nas Etapas 8/8.1; o diagnóstico
declara essa limitação, sem inventar motivos históricos. Não foi criada
migration apenas para esse dado.

O diagnóstico não prova verdade absoluta nem resolve semântica complexa.
Quando não há claim verificável ou data explicável, a resposta correta continua
sendo insuficiência.

## Operação

```bash
docker compose up -d
npm run db:migrate
npm run evidence:diagnose
npm run evidence:official
npm run evidence:diagnose
docker compose down
```

Nunca use `docker compose down -v` como rotina.
