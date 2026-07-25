# Verificação factual baseada em evidências

## Objetivo e arquitetura

Relevância responde “vale atenção editorial?”; verificação responde “as claims
possuem evidência suficiente para serem tratadas como fatos?”. Uma notícia
relevante pode ser falsa, antiga ou não comprovada. Por isso a Etapa 7 fica
entre `PENDING_VERIFICATION` e qualquer geração:

```text
claims + evidências + data explícita
  → andre-studio-verification-v1
  → resultado explicável
  → transação PostgreSQL
     ├─ execução, claims, evidências e resultados
     └─ transição e evento editorial
```

O domínio calcula o resultado de forma pura. O serviço de aplicação cria o
fingerprint canônico e chama uma porta de unidade de trabalho. O adaptador
PostgreSQL bloqueia a notícia, valida sua versão e confirma tudo em uma única
transação. Ele não pode deixar resultado sem transição nem transição sem
resultado.

## Claims, evidências e hierarquia

Cada claim possui ID, texto limitado, tipo, importância `PRIMARY` ou
`SECONDARY` e, quando aplicável, sujeito/data esperados. Toda evidência pertence
obrigatoriamente a uma claim e registra fonte, URL HTTPS, autoridade, tipo,
datas, trecho opcional de até 500 caracteres e fatos estruturados limitados.

Autoridade decrescente:

1. fonte primária oficial;
2. documentação oficial;
3. changelog oficial;
4. repositório oficial;
5. blog oficial;
6. fonte secundária reputada;
7. comunidade;
8. desconhecida.

Fonte desconhecida ou somente comunidade não confirma lançamento. Confiança
não substitui evidência. Conteúdo de trechos, inclusive instruções ou prompt
injection, permanece dado inerte.

## Datas

A avaliação diferencia publicação, acontecimento, atualização, substituição,
disponibilidade e coleta. A data de avaliação é entrada obrigatória; nenhuma
função pura consulta o relógio. Um post recente sobre evento antigo não torna o
evento recente. Disponibilidade futura gera aviso; release substituído ou
evento antigo apresentado como atual resulta em `OUTDATED`. Data inválida é
rejeitada e ausência de data essencial impede confirmação.

## Política, confiança e classificações

`andre-studio-verification-v1` é versionada e validada integralmente para evitar
alteração silenciosa. A confiança fica entre 0 e 100 e apresenta breakdown de
cobertura de claims, autoridade, qualidade temporal e penalidade por
contradição. A saída inclui resultado por claim, evidências favoráveis e
contrárias, warnings e razões de bloqueio.

| Status | Decisão | Estado editorial |
| --- | --- | --- |
| `CONFIRMED` | `ALLOW_DRAFT_GENERATION` | `VERIFIED` |
| `PARTIALLY_CONFIRMED` | `REQUIRE_HUMAN_REVIEW` | permanece `PENDING_VERIFICATION` |
| `UNCONFIRMED` | `BLOCK_UNCONFIRMED` | `VERIFICATION_REJECTED` |
| `CONTRADICTED` | `BLOCK_CONTRADICTED` | `VERIFICATION_REJECTED` |
| `OUTDATED` | `BLOCK_OUTDATED` | `VERIFICATION_REJECTED` |
| `INSUFFICIENT_EVIDENCE` | `BLOCK_INSUFFICIENT_EVIDENCE` | `VERIFICATION_REJECTED` |

Uma claim primária contradita sempre bloqueia. Todas as primárias precisam estar
suportadas para confirmação. Uma secundária ausente pode produzir confirmação
parcial, que nunca avança automaticamente.

## Persistência, idempotência e concorrência

As migrations 004 e 005 mantêm `verification_runs`,
`verification_claims`, `verification_evidence`, `verification_results` e
`verification_claim_results`. A 005 complementa constraints e ordenação sem
alterar o checksum da 004 já aplicada. O runner continua rejeitando qualquer
mudança em migration aplicada.

A chave idempotente e o fingerprint SHA-256 canônico sobrevivem à reconexão. A
mesma entrada retorna replay sem novas linhas, evento ou transição; a mesma
chave com conteúdo diferente retorna
`VERIFICATION_IDEMPOTENCY_CONFLICT`. A versão esperada é validada sob
`FOR UPDATE`; divergência retorna `VERIFICATION_CONCURRENCY_CONFLICT`, sem
retry e com rollback integral.

## Operação e exemplos

```bash
npm run demo:verification
npm run demo:verification:postgres
npm run verify:official
```

A demo local usa dados fictícios. A demo PostgreSQL cria uma notícia fictícia,
leva-a a `PENDING_VERIFICATION`, persiste a confirmação, reconecta e comprova
replay sem evento adicional.

`verify:official` lê no máximo cinco itens já coletados pelo radar. Não abre
URLs, não busca conteúdo, não autentica, não usa LLM e não grava resultado.
Transforma o título em claim por regra simples. Como título não comprova a
própria claim, sem evidência adicional o resultado honesto é
`INSUFFICIENT_EVIDENCE`.

## Segurança e limitações

URLs de evidência exigem HTTPS, fonte na allow-list e bloqueio de hosts privados.
O radar preserva GET, limites, redirects revalidados, content type e proteção
contra DTD/entidades. SQL de dados usa parâmetros. Erros não incluem senha nem
connection string.

Esta etapa não prova verdade absoluta, independência entre fontes ou conteúdo
de páginas que não foi coletado como evidência estruturada. Não há geração,
Telegram, n8n, API HTTP nem publicação. Um LLM futuro poderá sugerir claims ou
resumir evidências, mas sua saída deverá ser validada como dado e nunca poderá
alterar a política, liberar conteúdo bloqueado ou decidir publicação.

## Evidência adquirida de páginas oficiais

A política factual pode agora receber candidatos produzidos
deterministicamente a partir da URL oficial persistida pelo radar. A aquisição
não muda os thresholds da verificação: conteúdo promocional, associação fraca
ou página inacessível continuam `INSUFFICIENT_EVIDENCE`. Contradição só é
marcada quando explícita. Arquitetura, limites e replay estão em
[`OFFICIAL-EVIDENCE-ACQUISITION.md`](OFFICIAL-EVIDENCE-ACQUISITION.md).

O funil anterior à política factual possui diagnóstico somente leitura.
Entidade, versão, data, tipo de página, linguagem explícita e autoridade são
explicados separadamente; score alto não substitui invariantes. Consulte
[`EVIDENCE-DIAGNOSTICS.md`](EVIDENCE-DIAGNOSTICS.md).
