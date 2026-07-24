# Pacote de banco

Adaptador PostgreSQL local do agregado editorial. Este workspace depende do
`content-engine`; o domínio não depende deste pacote.

## Conteúdo

```text
src/client.ts                              pool e transações
src/config.ts                              POSTGRES_* validado
src/migrations.ts                          runner SQL com checksum
src/postgres-editorial-news-repository.ts  implementação do contrato
migrations/001_initial_editorial_schema.sql
test/postgres-editorial-news-repository.test.ts
```

Dependências diretas:

- `pg`: driver PostgreSQL;
- `@types/pg`: tipos TypeScript usados apenas no desenvolvimento.

Não há ORM nem ferramenta externa de migrations. O runner pequeno de SQL é
suficiente para uma migration e mantém a execução e os checksums explícitos.

Com o PostgreSQL local saudável:

```bash
npm run db:status
npm run db:migrate
npm run test:integration
npm run demo:postgres
```

O reset destrutivo existe somente para o banco cujo nome termina em `_test`:

```bash
npm run db:reset:test
```

Configuração, modelo, segurança e solução de problemas estão em
[`../../docs/POSTGRESQL.md`](../../docs/POSTGRESQL.md).
