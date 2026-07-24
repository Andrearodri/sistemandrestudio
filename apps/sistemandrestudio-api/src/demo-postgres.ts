import {
  APPROVED_SCENARIO,
  transition,
} from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import { removePreviousEditorialDemo } from "./demo-postgres-support.ts";

const config = loadDatabaseConfig();
const firstPool = createDatabasePool(config);

try {
  await checkDatabaseConnection(firstPool);
  await runMigrations(firstPool);
  await removePreviousEditorialDemo(
    firstPool,
    APPROVED_SCENARIO.initialNews.id,
  );

  const repository = new PostgresEditorialNewsRepository(firstPool);
  await repository.save(APPROVED_SCENARIO.initialNews, 0);

  console.log("sistemandrestudio — demonstração PostgreSQL local");
  console.log(`Notícia fictícia: ${APPROVED_SCENARIO.initialNews.id}`);

  for (const step of APPROVED_SCENARIO.steps) {
    const current = await repository.getById(
      APPROVED_SCENARIO.initialNews.id,
    );
    const result = transition(current, step.command, step.context);
    await repository.save(result.entity, current.auditEvents.length);
    console.log(
      `${current.state} -> ${result.entity.state} | ${step.command.type}`,
    );
  }
} finally {
  await firstPool.end();
}

const secondPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(secondPool);
  const restartedRepository = new PostgresEditorialNewsRepository(secondPool);
  const recovered = await restartedRepository.getById(
    APPROVED_SCENARIO.initialNews.id,
  );
  const history = await restartedRepository.listAuditEvents(recovered.id);
  const approvedVersion = recovered.draftVersions.find(
    (version) => version.id === recovered.currentDraftVersionId,
  );

  console.log("\nRecuperação após nova conexão:");
  console.log(`Estado final: ${recovered.state}`);
  console.log(`Eventos recuperados: ${history.length}`);
  console.log(
    `Versão aprovada: ${approvedVersion?.id ?? "não encontrada"} ` +
      `(v${approvedVersion?.version ?? "?"})`,
  );
} finally {
  await secondPool.end();
}
