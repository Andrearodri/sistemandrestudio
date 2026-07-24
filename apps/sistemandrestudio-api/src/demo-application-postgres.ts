import {
  EditorialWorkflowService,
  createApprovedWorkflowFixture,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import { removePreviousEditorialDemo } from "./demo-postgres-support.ts";

const fixture = createApprovedWorkflowFixture("application-postgres-demo");
const config = loadDatabaseConfig();
const firstPool = createDatabasePool(config);

try {
  await checkDatabaseConnection(firstPool);
  await runMigrations(firstPool);
  await removePreviousEditorialDemo(firstPool, fixture.receive.newsId);
  const service = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(firstPool),
  );

  console.log("sistemandrestudio — serviço de aplicação com PostgreSQL");
  await service.execute(fixture.receive);
  for (const envelope of fixture.commands) {
    const result = await service.execute(envelope);
    console.log(
      `${result.previousState ?? "NEW"} -> ${result.newState} | ` +
        `${envelope.command.type} | replay=${String(result.replayed)}`,
    );
  }
} finally {
  await firstPool.end();
}

const secondPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(secondPool);
  const repository = new PostgresEditorialNewsRepository(secondPool);
  const restartedService = new EditorialWorkflowService(repository);
  const lastEnvelope = fixture.commands.at(-1);
  if (lastEnvelope === undefined) {
    throw new Error("The application demo has no final command.");
  }

  const replay = await restartedService.execute(lastEnvelope);
  const recovered = await repository.getById(fixture.receive.newsId);
  const history = await repository.listAuditEvents(fixture.receive.newsId);

  console.log("\nRecuperação após nova conexão:");
  console.log(`Replay idempotente: ${String(replay.replayed)}`);
  console.log(`Novos eventos no replay: ${replay.events.length}`);
  console.log(`Estado final: ${recovered.state}`);
  console.log(`Eventos persistidos: ${history.length}`);
} finally {
  await secondPool.end();
}
