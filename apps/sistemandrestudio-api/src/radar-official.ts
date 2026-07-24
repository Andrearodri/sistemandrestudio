import { EditorialWorkflowService, OfficialSourceRadarService } from "../../../packages/application/src/index.ts";
import { PostgresEditorialNewsRepository, PostgresSourceRadarRepository, checkDatabaseConnection, createDatabasePool, loadDatabaseConfig, runMigrations } from "../../../packages/database/src/index.ts";
import { OfficialFeedSourceAdapter, listEnabledOfficialSources } from "../../../packages/sources/src/index.ts";

const pool = createDatabasePool(loadDatabaseConfig());
try {
  await checkDatabaseConnection(pool); await runMigrations(pool);
  const workflow = new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool));
  const radar = new OfficialSourceRadarService(new PostgresSourceRadarRepository(pool), workflow, new OfficialFeedSourceAdapter());
  const context = { mode: "READ_ONLY_EXTERNAL" as const, collectedAt: new Date().toISOString() };
  const reports = [];
  for (const source of listEnabledOfficialSources()) reports.push(await radar.run(source, context));
  for (const report of reports) console.log(JSON.stringify(report));
  if (reports.every((report) => report.status === "FAILED")) process.exitCode = 1;
} finally { await pool.end(); }
