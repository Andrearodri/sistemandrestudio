# Pacote de aplicação

Camada de coordenação do fluxo editorial. Ela depende do `content-engine` e de
suas portas, mas não depende do pacote `database`.

```text
src/command-envelope.ts           envelope, validação e SHA-256 canônico
src/editorial-workflow-service.ts caso de uso principal
src/errors.ts                     erros estáveis de aplicação
src/result.ts                     resultado independente de infraestrutura
src/ports.ts                      portas mínimas
src/fixtures.ts                   cenários totalmente fictícios
test/                             testes unitários e PostgreSQL
```

Comandos:

```bash
npm run test:application
npm run test:application:integration
npm run demo:application
npm run demo:application:postgres
```

Não há framework de injeção, servidor, ORM ou dependência externa nova. Consulte
[`../../docs/APPLICATION-SERVICE.md`](../../docs/APPLICATION-SERVICE.md) para os
contratos, fluxo e limitações.
