import type { Pool } from "pg";

import {
  EditorialOrchestrationService,
  FixtureEditorialOrchestrationPipeline,
  InMemoryHumanDecisionChannel,
  InMemoryHumanEditorialDecisionExecutor,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialOrchestrationRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";

const at = "2026-07-29T11:00:00.000Z";
const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
let pool: Pool = createDatabasePool(config);
await runMigrations(pool);
await pool.query(`TRUNCATE
  editorial_orchestration_events,
  editorial_orchestration_attempts,
  editorial_human_decisions,
  editorial_human_decision_requests,
  editorial_orchestration_steps,
  editorial_orchestration_runs CASCADE`);

const pipeline = new FixtureEditorialOrchestrationPipeline();
const channel = new InMemoryHumanDecisionChannel(() => at);
const executor = new InMemoryHumanEditorialDecisionExecutor();
let repository = new PostgresEditorialOrchestrationRepository(pool);
let service = new EditorialOrchestrationService({
  repository,
  pipeline,
  channel,
  decisionExecutor: executor,
  clock: () => at,
});
const trigger = {
  triggerType: "MANUAL" as const,
  triggerKey: "editorial-run:2026-07-29:postgres-demo",
  triggeredBy: "demo-postgres",
};
const started = await service.startScheduledRun(trigger);
const request = (await service.getPendingHumanDecisions())[0];
if (request === undefined) throw new Error("PostgreSQL demo request missing.");

await pool.end();
pool = createDatabasePool(config);
repository = new PostgresEditorialOrchestrationRepository(pool);
service = new EditorialOrchestrationService({
  repository,
  pipeline,
  channel,
  decisionExecutor: executor,
  clock: () => at,
});
const recovered = await service.getRun(started.run.id);
await service.registerHumanDecision({
  requestId: request.id,
  reviewerId: "andre-local",
  decision: "APPROVE",
  receivedAt: at,
  idempotencyKey: "demo-postgres-human-approval",
});
const completed = await service.resumeRun(started.run.id);
const eventsBeforeReplay = (await repository.listEvents(started.run.id)).length;
const replay = await service.startScheduledRun(trigger);
const eventsAfterReplay = (await repository.listEvents(started.run.id)).length;

process.stdout.write(`${JSON.stringify({
  demo: "editorial-orchestration-postgres",
  recoveredStatus: recovered.status,
  finalStatus: completed.status,
  replayed: replay.replayed,
  additionalEventsOnReplay: eventsAfterReplay - eventsBeforeReplay,
  automaticPublication: false,
  database: "protected-test-database",
}, null, 2)}\n`);
await pool.end();
