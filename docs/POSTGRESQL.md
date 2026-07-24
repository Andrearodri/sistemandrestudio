# PostgreSQL local — sistemandrestudio

## Objetivo

Esta etapa adiciona persistência local ao agregado editorial sem levar
infraestrutura para dentro do domínio. O PostgreSQL passa a guardar o estado
atual, versões, solicitações e decisões de aprovação, comandos idempotentes e
eventos de auditoria.

O escopo termina em `READY_FOR_PUBLICATION`. Não há API HTTP, publicação,
Telegram, n8n, RSS, LLM, Hermes ou serviço externo.

## Arquitetura

```text
máquina editorial pura
        │
        │ EditorialNewsRepository (Promise)
        ▼
PostgresEditorialNewsRepository
        │
        ├── pg + queries parametrizadas
        ├── transações
        └── migrations SQL
                │
                ▼
        PostgreSQL local
```

O pacote `content-engine` conhece apenas o contrato do repositório. O pacote
`database` depende do domínio e contém `pg`, configuração, SQL e migrations. A
implementação em memória continua disponível para testes unitários e para
`npm run demo`.

O contrato ficou assíncrono porque tanto a memória quanto o PostgreSQL precisam
ser intercambiáveis sem expor tipos de infraestrutura. A API pública
`transition()` da máquina de estados não mudou.

O contrato também expõe `findProcessedCommand()`. O serviço de aplicação usa
essa consulta antes de carregar e transicionar o agregado, permitindo replay ou
conflito mesmo depois de reiniciar processo e conexão.

## Modelo implementado

| Tabela | Papel |
| --- | --- |
| `editorial_news` | estado e ponteiros atuais do agregado; inclui `lock_version` |
| `editorial_relevance_results` | resultado completo e versionado da relevância em JSONB |
| `draft_versions` | versões imutáveis, únicas por notícia e número |
| `approval_requests` | solicitação vinculada a uma versão específica |
| `approval_actions` | decisão humana e chave idempotente única |
| `audit_events` | histórico append-only das transições |
| `processed_commands` | chave, fingerprint e resultado persistido do comando |
| `schema_migrations` | nome, checksum e data de cada migration aplicada |

O JSONB `editorial_relevance_results.result` armazena o resultado determinístico
completo. A migration incremental `002_relevance_policy_result.sql` cria essa
relação um-para-um, faz backfill explícito de scores anteriores e cria índice
por política e versão. A tabela principal mantém score e resumo compatível. A
migration `001` não foi alterada.

`approval_requests` foi incluída além da lista mínima porque o agregado atual
modela explicitamente a solicitação que uma decisão resolve. O campo
`base_content` recebe o título normalizado enquanto o domínio ainda não possui
um campo separado para o conteúdo-base; ele evita antecipar uma mudança ampla
no agregado.

O banco aplica foreign keys, checks de estados/atores/decisões, unicidade de
`(news_id, version_number)` e de chaves idempotentes. Uma constraint trigger
diferida impede `READY_FOR_PUBLICATION` sem solicitação aprovada e decisão
humana para a versão atual.

## Migrations

Arquivos em `packages/database/migrations` usam o padrão
`NNN_descricao.sql`. O runner:

1. cria `schema_migrations` se necessário;
2. ordena os arquivos pelo nome;
3. calcula SHA-256 do conteúdo;
4. ignora uma migration já aplicada com o mesmo checksum;
5. rejeita alteração de uma migration já aplicada;
6. executa migration e registro na mesma transação.

Não edite uma migration aplicada. Acrescente o próximo arquivo incremental.
Falhas encerram o comando com erro e rollback.

## Transações, idempotência e concorrência

Cada `save()` bloqueia a linha atual, grava todo o agregado e atualiza seus
ponteiros dentro de uma única transação. Uma falha reverte todas as alterações.

Comandos processados usam `idempotency_key` como chave primária e armazenam tipo,
fingerprint e resultado. A mesma chave com o mesmo comando não cria novo efeito;
uma combinação conflitante produz `PERSISTENCE_IDEMPOTENCY_CONFLICT`. Decisões
humanas também possuem uma constraint idempotente e eventos usam ID único.

`editorial_news.lock_version` aplica concorrência otimista. O chamador fornece a
versão lida; o update só ocorre quando ela ainda corresponde. Atualização
obsoleta produz `CONCURRENT_UPDATE`.

## Configuração local

Copie apenas os exemplos adequados e mantenha os arquivos reais fora do Git:

```bash
cp .env.local.example .env.local
cp .env.test.example .env.test
```

Os exemplos contêm somente valores fictícios locais. O Compose publica o banco
em `127.0.0.1:55432`, pois a porta padrão 5432 pode estar ocupada por outro
PostgreSQL no host. A porta pode ser sobrescrita por `POSTGRES_PORT`.

O container usa um papel administrativo apenas no bootstrap. A aplicação
conecta como `sistemandrestudio_app`, sem `SUPERUSER`, `CREATEDB` ou
`CREATEROLE`, e com acesso aos bancos de desenvolvimento e teste do projeto.

## Comandos

```bash
docker compose config
docker compose up -d
docker compose ps
docker compose logs postgres

npm run db:status
npm run db:migrate
npm run db:migrate:test
npm run db:reset:test

npm run test:integration
npm run test:application:integration
npm run demo:postgres
npm run demo:application:postgres

docker compose down
```

`db:reset:test` recusa qualquer banco cujo nome não termine em `_test`. Ele
remove e recria apenas o schema `public` desse banco e reaplica as migrations.

Para desligar sem apagar dados, use `docker compose down`. Não use
`docker compose down -v` em rotinas normais: `-v` remove o volume
`sistemandrestudio_postgres_data`.

## Testes

Os testes de integração usam `sistemandrestudio_test`, executam migrations no
início e truncam somente as tabelas desse banco antes de cada caso. Eles cobrem
recuperação, estados, versões, constraints, auditoria, decisão humana,
idempotência persistente, conflito idempotente, concorrência otimista, commit,
rollback, aprovação obrigatória e nova conexão.

Os testes são independentes da internet e não substituem os 29 testes unitários
da máquina de estados.

Os 10 testes de integração da aplicação exercitam o fluxo pelo
`EditorialWorkflowService`, reconexão, replay persistente, conflito de chave,
disputa de versão, rollback e histórico final.

Outros 10 testes PostgreSQL exercitam relevância completa, breakdown,
penalidades, política, reconexão, execução pelo serviço, os dois caminhos de
roteamento, rollback e idempotência.

## Segurança

- bind exclusivo em `127.0.0.1`;
- bancos separados para desenvolvimento e teste;
- papel da aplicação sem privilégios administrativos;
- queries de dados parametrizadas;
- migrations versionadas e verificadas por checksum;
- arquivos `.env.local` e `.env.test` ignorados;
- nenhuma senha ou connection string completa em logs;
- payload técnico de auditoria controlado pelo código;
- nenhuma porta, conta ou serviço externo.

Backups ainda não foram automatizados porque os dados são locais e fictícios.
Antes de dados reais, definir RPO/RTO, retenção, criptografia e teste de
restauração. O volume nomeado não é um backup.

## Solução de problemas

- **`EPERM` ao conectar:** o ambiente de execução pode bloquear TCP local;
  libere somente a conexão ao `127.0.0.1`.
- **porta ocupada:** altere `POSTGRES_PORT` nos dois arquivos locais e no
  ambiente do Compose; confirme com `docker compose port postgres 5432`.
- **banco de teste inexistente em volume antigo:** execute o bootstrap
  idempotente documentado em `infrastructure/docker/init`; volumes novos fazem
  isso automaticamente.
- **migration com checksum diferente:** não edite o arquivo aplicado; restaure-o
  e crie uma migration incremental.
- **reset recusado:** confirme que `POSTGRES_DB` termina exatamente em `_test`.
- **container não saudável:** consulte `docker compose logs postgres` sem
  publicar credenciais.

## Limitações e evolução

- o schema cobre somente o agregado editorial atual;
- `base_content` ainda não é um campo independente no domínio;
- não há pool separado por operação, métricas, backup ou observabilidade;
- o runner não implementa downgrade automático;
- o papel administrativo de bootstrap permanece interno ao container;
- não há processamento distribuído ou fila;
- não há API nem integrações.

O serviço de aplicação local já coordena transições e `save()` com versão
esperada, incluindo a relevância determinística. A próxima fatia recomendada é
somente uma política determinística de verificação com evidências fictícias.
Integrações externas devem continuar adiadas.
# PostgreSQL

A migração 003 é aditiva: não altera migrações nem tabelas editoriais existentes. O adaptador do radar grava somente no banco configurado localmente; o volume do Compose deve ser preservado com `docker compose down`, nunca `down -v`.
