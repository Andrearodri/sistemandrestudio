# sistemandrestudio

Sistema operacional com IA para apoiar a operação solo da AndreStudio.dev. O
projeto pretende reunir automações, inteligência artificial, aprovação humana e
memória operacional em uma base controlável e auditável.

O problema inicial é reduzir o trabalho manual de acompanhar notícias, validar
informações e preparar conteúdo, sem perder controle editorial. A primeira
trilha é:

> notícia → coleta → deduplicação → relevância → verificação → geração → aprovação no Telegram → banco

O objetivo desta fase não é criar uma equipe inteira de agentes. É validar um
único fluxo de ponta a ponta, com controle humano antes de qualquer uso do
conteúdo.

> [!IMPORTANT]
> O projeto está em fase inicial. O núcleo local da máquina de estados está
> implementado e o adaptador PostgreSQL local está disponível. Ainda não há API
> HTTP, integração externa ou publicação.

## Estado atual

O núcleo TypeScript e a primeira persistência local foram implementados:

- o workspace usa npm workspaces e TypeScript estrito;
- a máquina editorial possui 29 testes unitários, fixtures e demonstração local;
- o PostgreSQL possui migrations SQL, constraints, transações, idempotência
  persistente, concorrência otimista e testes de integração;
- as demonstrações em memória e persistente são comandos separados;
- Git `2.50.1`, Node.js `24.14.0` e npm `11.9.0` estão disponíveis;
- Docker `29.5.3` e Docker Compose `v5.1.4` estão disponíveis;
- o ambiente é macOS `26.5.2` em arquitetura ARM64.

Somente o container PostgreSQL oficial local é necessário nesta etapa. Nenhuma
conta externa foi acessada e nenhum deploy foi realizado. n8n, Telegram, LLM,
RSS, Hermes e publicação continuam fora do código.

## Escopo do MVP

O MVP deve:

1. coletar uma notícia de uma fonte RSS ou API permitida;
2. normalizar e deduplicar o item;
3. classificar relevância com regras versionadas;
4. aplicar critérios objetivos de verificação e guardar as evidências;
5. gerar um rascunho somente quando o item estiver apto;
6. enviar o rascunho ao Telegram para aprovar, editar ou rejeitar;
7. manter versões após edição e exigir nova aprovação;
8. registrar dados, transições de estado e decisão humana no PostgreSQL;
9. marcar conteúdo aprovado como `READY_FOR_PUBLICATION`, sem publicá-lo.

Não fazem parte do MVP:

- publicação automática em redes sociais;
- Postiz ou integrações oficiais de publicação;
- Hermes Agent como supervisor;
- Lead Flow Studio/CRM;
- infraestrutura AWS EC2;
- múltiplos agentes autônomos;
- scraping genérico de sites;
- execução de ações externas sem aprovação humana.

## Arquitetura proposta

```text
RSS/API permitida
       │
       ▼
n8n (agenda e orquestração previsível)
       │
       ▼
Aplicação Node.js/TypeScript
  ├─ normalização e deduplicação
  ├─ regras de verificação
  ├─ geração assistida por LLM
  └─ gateway do Telegram
       │
       ▼
PostgreSQL local (fonte de verdade e auditoria)
```

Responsabilidades:

- **n8n:** agenda, encadeia etapas, aplica tentativas controladas e observa
  timeouts. Não guarda o estado de negócio definitivo.
- **Aplicação Node.js/TypeScript:** concentra regras, contratos, idempotência,
  integrações e testes. A proposta inicial é um monólito modular, não
  microserviços.
- **PostgreSQL:** guarda notícias, evidências, rascunhos, aprovações, execuções e
  eventos de auditoria.
- **Telegram:** interface humana de aprovação. No desenvolvimento local, o bot
  pode consumir atualizações por long polling; webhook público fica para uma
  fase hospedada.
- **LLM:** produz rascunhos a partir de fatos e evidências armazenados. Não decide
  sozinho se uma notícia é verdadeira e não publica conteúdo.

Detalhes, riscos, custos e etapas estão em
[`docs/MVP-PLAN.md`](docs/MVP-PLAN.md). A arquitetura completa, o modelo de
dados e as regras de segurança estão em:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md);
- [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md);
- [`docs/SECURITY.md`](docs/SECURITY.md);
- [`docs/STATE-MACHINE.md`](docs/STATE-MACHINE.md);
- [`docs/POSTGRESQL.md`](docs/POSTGRESQL.md).

## Tecnologias em avaliação

| Tecnologia | Direção atual |
| --- | --- |
| TypeScript e Node.js | base recomendada da aplicação |
| PostgreSQL 17 | persistência local implementada |
| n8n | orquestração previsível e limitada |
| Telegram Bot | aprovação remota após autorização |
| Docker Compose | um único serviço PostgreSQL local |
| APIs de IA | adaptador substituível com limite de gasto |
| Redis | dispensado até existir necessidade comprovada |
| Hermes Agent | adiado para a fase 2 |
| React/Next.js | painel futuro |
| Ollama | opção futura, após avaliar hardware e manutenção |
| Postiz | publicação futura e separada |
| AWS EC2/S3 | hospedagem futura |
| Lead Flow Studio | integração futura com CRM |

## Estrutura atual

```text
sistemandrestudio/
├── apps/
│   └── sistemandrestudio-api/
│       └── src/
│           ├── demo.ts
│           └── demo-postgres.ts
├── packages/
│   ├── database/              # adapter, migrations e testes PostgreSQL
│   ├── shared/src/            # ator, timestamp e idempotência
│   └── content-engine/src/    # máquina, fixtures e repositório em memória
├── automations/
│   └── n8n/                   # somente documentação
├── tests/editorial-state-machine.test.ts
├── docs/                      # planejamento e especificações
├── infrastructure/
│   └── docker/init/           # bootstrap dos bancos e papel local
├── compose.yaml
├── package.json
├── package-lock.json
├── tsconfig.base.json
├── tsconfig.json
├── tsconfig.build.json
├── .env.example
└── README.md
```

`dashboard`, `agents/hermes` e `LICENSE` continuam
adiados. Não são necessários para validar o núcleo local.

## Princípios iniciais

- aprovação humana é obrigatória;
- PostgreSQL é a fonte de verdade;
- cada evento precisa de `correlation_id` e histórico auditável;
- todo processamento deve ser idempotente;
- credenciais ficam fora do Git e nunca aparecem em logs;
- conteúdo externo é dado não confiável, inclusive para o LLM;
- integrações começam com adaptadores simples e substituíveis;
- publicação é uma capacidade posterior e separada da aprovação.

## Execução local

Scripts disponíveis:

```bash
npm run typecheck
npm run test
npm run build
npm run test:watch
npm run demo

docker compose up -d
npm run db:migrate
npm run test:integration
npm run demo:postgres
docker compose down
```

O comando `demo` executa uma notícia totalmente fictícia, imprime as transições,
o histórico de auditoria e termina em `READY_FOR_PUBLICATION`. `demo:postgres`
persiste cada etapa, fecha a conexão, abre outra e recupera o mesmo agregado.
Nenhum dos dois inicia servidor HTTP ou integração externa.

Use `.env.local.example` e `.env.test.example` como referência. Os arquivos
locais reais ficam ignorados. O banco usa por padrão `127.0.0.1:55432`; detalhes
e solução de problemas estão em [`docs/POSTGRESQL.md`](docs/POSTGRESQL.md).

## Próximo marco

Após nova autorização, o próximo marco recomendado é criar uma camada de serviço
de aplicação pequena que coordene uma transição e sua gravação, ainda sem HTTP
ou integração externa. O MVP completo não está concluído.

## Execução futura

Quando as etapas correspondentes forem autorizadas, o ambiente local deverá
usar:

- npm workspaces e lockfile para a aplicação TypeScript;
- Docker Compose para serviços locais autorizados, sem instalação global;
- fixtures para testes sem rede;
- `.env` local não versionado;
- adaptadores habilitados individualmente para fonte, LLM e Telegram.

O núcleo atual usa o executor e o runner de testes nativos do Node.js 24; não há
framework web ou aplicação HTTP.
