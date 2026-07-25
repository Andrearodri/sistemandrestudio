# Plano do MVP — sistemandrestudio

## 1. Objetivo e critério de sucesso

Construir uma única trilha operacional confiável:

> fontes → coleta → deduplicação → relevância → verificação → rascunho → aprovação/edição/rejeição no Telegram → banco

O MVP estará validado quando uma notícia puder atravessar todas as etapas com:

- origem e evidências rastreáveis;
- prevenção de duplicidade;
- geração baseada somente em fatos armazenados;
- decisão humana explícita no Telegram;
- histórico completo no PostgreSQL;
- reprocessamento seguro, sem criar rascunhos ou aprovações duplicadas;
- nenhuma publicação automática.

## Escopo do primeiro MVP

- uma ou poucas fontes RSS/APIs previamente permitidas;
- coleta agendada;
- normalização e remoção lógica de duplicidades;
- classificação de relevância por política versionada;
- verificação com evidências, datas e nível de confiança;
- geração de um formato inicial de rascunho;
- aprovação, edição ou rejeição pelo Telegram;
- conteúdo aprovado marcado como `READY_FOR_PUBLICATION`;
- persistência e auditoria no PostgreSQL.

## Fora do escopo

- publicação automática;
- Postiz e integrações com redes sociais;
- Hermes e múltiplos agentes;
- painel React/Next.js;
- CRM e Lead Flow Studio;
- propostas, projetos, atendimento e follow-up;
- Redis sem necessidade comprovada;
- Ollama;
- hospedagem AWS, S3, domínio e endpoint público;
- arquitetura multiempresa.

## Requisitos funcionais

- **RF-01:** cadastrar e ativar somente fontes permitidas.
- **RF-02:** coletar itens preservando origem e datas.
- **RF-03:** normalizar URL e detectar duplicidade sem apagar o registro.
- **RF-04:** classificar relevância e guardar regra, pontuação e justificativa.
- **RF-05:** separar fato, interpretação, rumor e opinião.
- **RF-06:** verificar atualidade, data do acontecimento e evidências.
- **RF-07:** atribuir nível de confiança e encaminhar incerteza ao humano.
- **RF-08:** gerar rascunho somente a partir de item verificado.
- **RF-09:** manter créditos e links sem copiar integralmente terceiros.
- **RF-10:** solicitar aprovação de uma versão específica no Telegram.
- **RF-11:** permitir aprovar, editar ou rejeitar; edição gera nova versão.
- **RF-12:** registrar ator, horário, versão e resultado de cada ação.
- **RF-13:** terminar em `READY_FOR_PUBLICATION`, sem publicar.
- **RF-14:** reprocessar etapas de forma idempotente.

## Requisitos não funcionais

- execução local antes de hospedagem;
- arquitetura modular e baixo acoplamento;
- nenhuma credencial no Git ou nos logs;
- logs estruturados e `correlation_id`;
- auditoria append-only;
- transições transacionais e recuperáveis;
- retry limitado e timeout explícito;
- validação de entrada e saída;
- conteúdo externo sempre não confiável;
- adaptadores substituíveis para fonte, LLM e Telegram;
- custo mensurável e limitado;
- compatibilidade ARM64 ou alternativa documentada;
- aprovação humana obrigatória;
- retenção e minimização de dados definidas antes de dados reais.

## 2. Diagnóstico do ambiente

Diagnóstico iniciado e atualizado em 24 de julho de 2026. A primeira inspeção
foi somente leitura; nas etapas autorizadas seguintes foram criados o workspace
e o PostgreSQL local.

| Item | Encontrado |
| --- | --- |
| Pasta | Workspace npm/TypeScript com documentação e código local |
| Git | `2.50.1 (Apple Git-155)` |
| Branch | `main`, com commit-base do núcleo |
| Node.js | `24.14.0` |
| npm | `11.9.0` |
| pnpm | `11.9.0`, fornecido pelo runtime local |
| Yarn | Não encontrado |
| Python | `3.9.6`; não necessário para o MVP |
| Docker | `29.5.3` |
| Docker Compose | `v5.1.4` |
| Sistema | macOS `26.5.2`, ARM64 |
| Instruções locais | Nenhum `AGENTS.md` encontrado |
| PostgreSQL | imagem oficial `postgres:17-alpine`, ARM64 |
| Porta do projeto | `127.0.0.1:55432`; 5432 pertence a outro container |
| Docker daemon | disponível; Compose e healthcheck validados |
| Credenciais/configuração | somente valores fictícios locais, ignorados pelo Git |

Conclusão: o ambiente já possui as ferramentas básicas para desenvolver e
executar o MVP localmente. O daemon, a imagem ARM64, o healthcheck e o bind local
foram confirmados. Node.js 24 continua exigindo validar cada dependência nova. O
n8n ainda não foi instalado nem iniciado.

Possíveis conflitos a validar depois:

- cada biblioteca deve declarar compatibilidade com Node.js 24;
- a porta configurável precisa continuar sem conflito com outros projetos;
- o tag do PostgreSQL fixa a versão principal 17, mas recebe patches da série;
- migrations aplicadas não podem ser editadas;
- o volume local precisa de uma política real de backup antes de dados reais.

## 3. Decisões técnicas

### Estado da Etapa 7

A verificação factual foi implementada como política determinística anterior à
geração. Resultado factual e transição editorial compartilham uma transação;
replay, conflito idempotente e concorrência usam dados persistidos. Geração,
LLM e aprovação remota permanecem etapas futuras.

### 3.1 Um monólito modular antes de agentes ou microserviços

Uma aplicação Node.js/TypeScript deve concentrar API, worker e gateway do
Telegram em módulos separados. Isso reduz operação e custo, mas preserva
fronteiras que permitem extrair serviços depois.

Hermes Agent fica fora do MVP. Um supervisor inteligente só deve entrar quando o
fluxo determinístico tiver métricas, falhas conhecidas e pontos claros de
decisão.

### 3.2 n8n como orquestrador, não como banco

O n8n agenda e coordena o fluxo. Estados de negócio, evidências e decisões ficam
no PostgreSQL. Workflows exportados devem ser versionados no Git e não conter
credenciais.

Regras complexas e validações devem permanecer em TypeScript, onde podem ser
testadas. O n8n chama operações idempotentes da aplicação.

### 3.3 PostgreSQL como fonte de verdade

O banco registra o item desde a ingestão, não apenas no final. Cada transição
gera um evento auditável. Constraints e chaves idempotentes devem impedir
duplicidade mesmo quando houver retry do n8n.

### 3.4 Verificação em camadas

“Verificado” no MVP significa “atendeu a critérios operacionais registrados”,
não uma garantia absoluta de verdade.

Ordem sugerida:

1. validar formato, URL, autor/data e atualidade;
2. normalizar URL e calcular fingerprint do item;
3. recusar duplicatas e fontes não permitidas;
4. armazenar o texto original como conteúdo não confiável;
5. buscar corroboração em fontes permitidas independentes quando a regra exigir;
6. registrar evidências e divergências;
7. classificar como `VERIFIED`, `REJECTED` ou `MANUAL_REVIEW`;
8. permitir geração automática somente para `VERIFIED`;
9. encaminhar incertezas para revisão humana, nunca “preencher” fatos com LLM.

Uma política inicial conservadora pode exigir duas fontes independentes para
afirmações factuais sensíveis. A lista de fontes, critérios de independência,
recência e temas sensíveis precisa ser aprovada pelo proprietário.

### 3.5 LLM limitado à geração

O modelo recebe fatos estruturados, evidências e um template de saída. URLs,
textos RSS e páginas externas devem ser delimitados como dados não confiáveis
para reduzir prompt injection.

Cada rascunho registra:

- provedor e identificador do modelo;
- versão do prompt;
- IDs das evidências usadas;
- parâmetros de geração;
- hash da entrada e da saída;
- data, custo estimado e duração.

O LLM não aprova, não publica e não altera a evidência original.

### 3.6 Telegram como controle humano

O bot envia resumo, fontes e rascunho com três ações:

- **Aprovar:** marca a versão como `READY_FOR_PUBLICATION`;
- **Rejeitar:** exige ou permite um motivo;
- **Editar/pedir revisão:** cria uma nova versão do rascunho e exige nova
  aprovação, mantendo o histórico.

Cada callback deve ser autenticado pelo usuário/chat permitido, ter token lógico
de uso único e ser idempotente. No desenvolvimento local, long polling evita a
necessidade de expor uma URL pública. Webhooks ficam para a infraestrutura
hospedada.

### 3.7 Sem publicação no MVP

Uma aprovação não equivale a publicar. Postiz e APIs oficiais devem ser
integrados em uma fase separada, com novas permissões, limites e auditoria.

## 4. Componentes e fluxo

```text
[Scheduler n8n]
      |
      v
[Ingestão RSS/API] --> [Normalização e deduplicação]
      |
      v
[Classificação de relevância]
      |
      v
[Verificação por regras] -----------> [verifications + audit_logs]
      |
      +---- rejeitado/revisão manual --> [encerra ou aguarda humano]
      |
      v verificado
[Geração via LLM] ------------------> [content_drafts]
      |
      v
[Telegram: aprovar/editar/rejeitar]
      |
      v
[approval_action + audit_log no PostgreSQL]
```

O `correlation_id` acompanha a notícia por todo o caminho. Cada etapa começa
consultando o estado atual, grava seu resultado em transação e só então libera a
próxima etapa.

## 5. Modelo de dados inicial

| Tabela | Responsabilidade | Restrições importantes |
| --- | --- | --- |
| `sources` | Catálogo e política das fontes | URL/feed único; status ativo |
| `news_items` | Item normalizado e seu estado | fingerprint único |
| `news_duplicates` | Relação com item canônico | par de itens único |
| `verifications` | Evidências, divergências e confiança | política e hashes |
| `content_drafts` | Contêiner do conteúdo gerado | pertence à notícia |
| `content_versions` | Versões imutáveis | número único por rascunho |
| `approval_requests` | Versão submetida ao Telegram | nonce e expiração |
| `approval_actions` | Decisão humana | chave idempotente única |
| `audit_logs` | Histórico imutável | ator, horário e payload seguro |
| `users` | Identidades autorizadas | Telegram ID único |
| `system_settings` | Configuração não secreta | chave e versão |
| `publications` | Publicação futura | adiada |
| `agent_runs` | Agentes futuros | adiada |

Finalidade, campos, relacionamentos, sensibilidade e retenção de cada entidade
estão em [`DATA-MODEL.md`](DATA-MODEL.md). O modelo permanece somente proposto.

Estados propostos:

```text
COLLECTED
  → DUPLICATE | CLASSIFIED
  → IRRELEVANT | VERIFYING
  → VERIFIED | REJECTED | MANUAL_REVIEW
  → DRAFTED
  → PENDING_APPROVAL
  → READY_FOR_PUBLICATION | REJECTED_BY_OWNER | REVISION_REQUESTED
```

`REVISION_REQUESTED` volta para uma nova versão de `DRAFTED`, nunca sobrescreve
a versão anterior.

## 6. Contratos de idempotência e falha

- ingestão: fingerprint da fonte + identificador original + URL normalizada;
- verificação: versão da política + hash do item e das evidências;
- geração: notícia + versão do prompt + modelo + hash das evidências;
- Telegram: ID da mensagem + ID do callback + usuário autorizado;
- retry: backoff limitado, dead-letter lógico e alerta depois do limite;
- timeout: etapa permanece recuperável e não avança silenciosamente;
- logs: IDs técnicos e estados, sem tokens, conteúdo sensível ou headers.

## 7. Estrutura de pastas proposta

```text
sistemandrestudio/
├── apps/
│   └── sistemandrestudio-api/
│       └── src/
│           ├── modules/
│           │   ├── ingestion/
│           │   ├── verification/
│           │   ├── generation/
│           │   ├── approval/
│           │   └── audit/
│           ├── workers/
│           ├── http/
│           └── telegram/
├── packages/
│   ├── database/
│   ├── shared/
│   └── content-engine/
├── automations/n8n/
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
├── docs/decisions/
├── infrastructure/
│   ├── docker/
│   └── aws/
└── scripts/
```

Essa estrutura não precisa ser criada integralmente no primeiro commit de
código. Pastas devem surgir junto com funcionalidades reais, evitando
scaffolding vazio.

## 8. Dependências previstas

### Necessárias para a fatia local atual

- Node.js e npm;
- TypeScript;
- tipos do Node.js;
- runner e executor nativos do Node.js 24;
- PostgreSQL 17 em container;
- `pg` para conexão e transações;
- `@types/pg` para tipagem no desenvolvimento;
- Docker Compose para o único serviço local.

### Necessárias para a próxima fatia autorizada

- uma política determinística de relevância baseada em fixtures;
- nenhum pacote adicional é necessário até existir uma integração autorizada;
- n8n permanece futuro, quando a orquestração do fluxo for conectada.

### Necessárias para integração externa

- uma ou mais fontes RSS/APIs aprovadas;
- bot do Telegram e identificação do usuário/chat autorizado;
- provedor de LLM, modelo e limite de gasto;
- acesso de saída à internet;
- política de retenção e backup.

### Adiadas

- Hermes Agent;
- Postiz ou APIs de publicação;
- Lead Flow Studio;
- AWS EC2, domínio, TLS e observabilidade hospedada.

Além de `typescript` e `@types/node`, foram adicionados somente `pg` em produção
e `@types/pg` no desenvolvimento. Não há ORM, framework HTTP ou biblioteca de
integração.

## 9. Riscos e mitigação

| Risco | Impacto | Mitigação inicial |
| --- | --- | --- |
| Notícia falsa ou incompleta | Conteúdo incorreto | Allowlist, corroboração, evidências e revisão humana |
| Alucinação do LLM | Fatos inventados | Entrada estruturada, citações, validação e aprovação |
| Prompt injection em fonte externa | Desvio de instruções | Tratar conteúdo como dado, limitar ferramentas e saída |
| Duplicidade por retry | Spam e custo | Chaves idempotentes e constraints no banco |
| Bot ou callback forjado | Aprovação indevida | Allowlist de usuário/chat, token único e auditoria |
| Vazamento de segredo | Comprometimento de contas | Secret store/env local, redaction e nunca versionar `.env` |
| Falha parcial entre serviços | Estado inconsistente | Transações, estados explícitos e retry controlado |
| Dependência de fornecedor | Migração cara | Adaptadores para LLM, Telegram e fontes |
| Custo imprevisível de API | Sobrecusto | Limites por execução/dia e métricas de tokens |
| Termos de uso/direitos autorais | Bloqueio ou risco legal | Preferir RSS/APIs permitidas, guardar trechos mínimos |
| Operação em EC2 único | Indisponibilidade/perda | Backup, health checks e plano de restauração futuro |
| Automação excessiva cedo | Complexidade difícil de depurar | Uma trilha, sem Hermes e sem publicação no MVP |

## 10. Etapas de implementação

### Etapa 0 — documentação e decisões

- revisar este plano;
- aprovar escopo, fontes, política de verificação e orçamento;
- criar ADRs para escolhas que forem confirmadas.

**Saída:** plano aceito, sem integração externa.

### Etapa 1 — base local e domínio

**Status:** núcleo local concluído em 24 de julho de 2026, na rodada autorizada
como “Etapa 2 — Workspace TypeScript e máquina de estados”.

- criar workspace Node.js/TypeScript;
- definir estados, entidades e contratos;
- validar a configuração segura já documentada em `.env.example`;
- preparar testes unitários.

**Saída obtida:** máquina estrita com 14 estados, comandos explícitos, eventos,
versionamento, idempotência, repositório em memória, fixtures, testes e demo,
sem rede. Consulte [`STATE-MACHINE.md`](STATE-MACHINE.md).

### Etapa 2 — PostgreSQL local

**Status:** persistência local concluída em 24 de julho de 2026, na rodada
autorizada como “Etapa 3 — Persistência local com PostgreSQL”.

- criar Compose apenas para PostgreSQL;
- criar migrations das tabelas iniciais;
- implementar transações, repositórios e idempotência;
- testar retry e duplicidade.

**Saída obtida:** adaptador `PostgresEditorialNewsRepository`, migration SQL
versionada, concorrência otimista, idempotência apoiada por constraints, banco
de teste isolado, testes de integração e demo que fecha e reabre a conexão.
Consulte [`POSTGRESQL.md`](POSTGRESQL.md).

### Etapa 3 — serviço de aplicação local

**Status:** concluída em 24 de julho de 2026, na rodada autorizada como
“Etapa 4 — Serviço de aplicação editorial”.

- validar envelopes explícitos;
- coordenar criação, transição e persistência;
- aplicar fingerprint canônico e idempotência persistente;
- propagar concorrência sem retry automático;
- testar com memória e PostgreSQL.

**Saída obtida:** `EditorialWorkflowService`, comando `ReceiveNews`, resultado
estruturado, erros estáveis, 15 testes unitários, 10 testes PostgreSQL e demos
com replay após reconexão. Consulte
[`APPLICATION-SERVICE.md`](APPLICATION-SERVICE.md).

### Etapa 4 — política determinística de relevância

**Status:** concluída localmente em 24 de julho de 2026, na rodada autorizada
como “Etapa 5 — Política determinística de relevância”.

- centralizar tópicos, aliases, pesos, thresholds e penalidades;
- calcular breakdown explicável sem rede, relógio ou IA;
- integrar `ScoreNews` e os caminhos de verificação ou descarte;
- persistir o resultado versionado em JSONB;
- testar memória, PostgreSQL, reconexão e idempotência.

**Saída obtida:** `andre-studio-relevance-v1`, 25 testes unitários, 10 testes
PostgreSQL, oito fixtures e duas demos. Consulte
[`RELEVANCE-POLICY.md`](RELEVANCE-POLICY.md).

### Etapa 5 — verificação determinística com fixtures

- simular evidências convergentes e conflitantes;
- separar fato, interpretação, rumor e opinião;
- provar os caminhos `VERIFIED`, `REJECTED` e revisão humana.

**Saída:** verificação testável, ainda sem fontes reais.

### Etapa 6 — n8n local

- criar um workflow mínimo versionado;
- orquestrar as operações idempotentes;
- testar timeout, retry limitado e retomada.

**Saída:** fluxo determinístico local com dados simulados.

### Etapa 7 — integrações, uma por vez

1. uma fonte RSS/API aprovada;
2. um provedor de LLM com orçamento;
3. bot do Telegram com usuário/chat permitido.

Cada integração deve passar por teste isolado e revisão antes da seguinte.

**Saída:** trilha real de ponta a ponta, sem publicação.

### Etapa 8 — endurecimento e operação

- métricas de sucesso, erro, latência e custo;
- backup e restauração;
- runbook de incidentes;
- revisão de segurança e retenção;
- decisão informada sobre hospedagem.

**Saída:** base para avaliar AWS, Hermes, CRM e publicação.

## 11. Métricas e critérios de conclusão

Critérios de conclusão:

- uma fixture percorre o fluxo completo até `READY_FOR_PUBLICATION`;
- duplicata conhecida não gera novo rascunho;
- item irrelevante fica registrado e não segue para geração;
- baixa confiança nunca gera aprovação implícita;
- edição cria uma nova versão e invalida a aprovação anterior;
- retry não duplica notícia, versão ou ação;
- toda transição aparece na auditoria;
- testes cobrem sucesso, rejeição, revisão, timeout e falha recuperável;
- nenhum fluxo publica conteúdo;
- nenhum segredo aparece em Git, logs ou fixtures.

Métricas operacionais:

- percentual de itens deduplicados corretamente;
- percentual de itens classificados como relevantes;
- percentual por resultado de verificação;
- número de divergências encaminhadas para revisão;
- taxa de aprovação/rejeição/revisão;
- tempo da ingestão até decisão;
- custo de LLM por rascunho aprovado;
- número de retries, falhas definitivas e duplicatas;
- zero publicações sem autorização e zero segredos em logs/Git.

## 12. Custos possíveis

As faixas abaixo são estimativas de planejamento em USD, não cotações atuais.
Preços, impostos, câmbio e franquias precisam ser confirmados antes de qualquer
contratação.

| Item | MVP local | Futuro hospedado |
| --- | ---: | ---: |
| Git, Node.js, PostgreSQL e Docker | US$ 0 em licenças usuais | depende da operação |
| n8n self-hosted/community | US$ 0 de licença, sujeito aos termos | compute e manutenção |
| Telegram Bot API | normalmente sem cobrança direta | tráfego/infra do bot |
| LLM | US$ 5–50/mês em testes controlados | cresce com volume/modelo |
| RSS | frequentemente gratuito | APIs premium podem cobrar |
| VM/EC2 pequena | não necessária | cerca de US$ 10–50/mês |
| PostgreSQL gerenciado | não necessário | cerca de US$ 20–100+/mês |
| Domínio, backup e logs | não necessários agora | cerca de US$ 5–40+/mês |
| Postiz/publicação | fora do MVP | licença, compute ou API variável |

O maior custo oculto tende a ser operação: atualizações, backup, diagnóstico,
segurança e tempo de manutenção. Um limite mensal e alertas devem existir antes
de ligar LLM ou infraestrutura paga.

## 13. Ações que exigem autorização

Nenhuma das ações abaixo deve ocorrer implicitamente:

- instalar pacotes npm, imagens Docker ou ferramentas;
- iniciar containers ou serviços;
- criar, ler ou alterar arquivos de credenciais;
- criar bot/token no Telegram ou acessar a conta;
- chamar APIs externas, feeds reais ou um provedor de LLM;
- aceitar termos, planos pagos ou gerar custos;
- abrir portas, túnel, webhook ou endpoint público;
- criar infraestrutura AWS, domínio, certificado ou deploy;
- criar banco com dados reais ou definir retenção/backup;
- integrar Lead Flow Studio, Postiz ou redes sociais;
- publicar qualquer conteúdo;
- adicionar Hermes ou novos agentes;
- criar commit, branch remoto, push ou pull request.

## 14. Decisões pendentes do proprietário

Antes das integrações reais, será necessário decidir:

1. temas e idiomas cobertos;
2. primeira fonte RSS/API e fontes permitidas;
3. regra mínima de corroboração e assuntos sensíveis;
4. formato do conteúdo gerado;
5. provedor/modelo de LLM e teto mensal;
6. usuário/chat do Telegram autorizado;
7. tempo de retenção dos textos, evidências e logs;
8. se o n8n será self-hosted ou gerenciado no futuro;
9. critérios de aceite para avançar a publicação e o Hermes.

## 15. Recomendação imediata

O núcleo, a persistência PostgreSQL, o serviço de aplicação e a política
determinística de relevância com dados fictícios foram concluídos. Após nova
autorização, a próxima fatia pequena deve implementar somente uma política
determinística de verificação com evidências fictícias, sem fonte real ou LLM.
Integrações externas continuam fora do escopo e o MVP não está concluído.

### Atualização após a Etapa 8

A verificação determinística e a aquisição controlada em páginas oficiais foram
implementadas. A aquisição parte de itens do radar, usa allow-list e persiste
somente conteúdo mínimo. O próximo incremento depende de nova autorização; LLM,
geração, Telegram, n8n, publicação e deploy continuam fora do escopo. O MVP
permanece incompleto.
