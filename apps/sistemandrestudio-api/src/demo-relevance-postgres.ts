import {
  ANDRE_STUDIO_RELEVANCE_POLICY_V1,
  COMMERCIALLY_USEFUL_UPDATE_FIXTURE,
} from "../../../packages/content-engine/src/index.ts";
import {
  EditorialWorkflowService,
  executeRelevanceWorkflow,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import { removePreviousEditorialDemo } from "./demo-postgres-support.ts";

const newsId = "news-relevance-postgres-demo";
const input = COMMERCIALLY_USEFUL_UPDATE_FIXTURE.input;
const config = loadDatabaseConfig();
const firstPool = createDatabasePool(config);

try {
  await checkDatabaseConnection(firstPool);
  await runMigrations(firstPool);
  await removePreviousEditorialDemo(firstPool, newsId);
  const service = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(firstPool),
  );

  await service.execute({
    commandId: "command-relevance-postgres-demo-receive",
    idempotencyKey: "idempotency-relevance-postgres-demo-receive",
    newsId,
    command: {
      type: "ReceiveNews",
      source: {
        id: "source-relevance-demo",
        name: "Documentação Fictícia de Relevância",
        url: "https://relevance-source.invalid/documentation",
        isOfficial: true,
      },
      title: input.title,
      originalUrl: "https://relevance-source.invalid/items/demo",
      publishedAt: input.publishedAt,
      eventAt: input.eventAt ?? input.publishedAt,
      receivedAt: "2026-07-24T11:00:00.000Z",
    },
    actor: { id: "actor-relevance-demo", type: "SYSTEM" },
    occurredAt: "2026-07-24T11:00:00.000Z",
    expectedVersion: 0,
  });
  await service.execute({
    commandId: "command-relevance-postgres-demo-normalize",
    idempotencyKey: "idempotency-relevance-postgres-demo-normalize",
    newsId,
    command: {
      type: "NormalizeNews",
      normalizedTitle: input.title,
      canonicalUrl: "https://relevance-source.invalid/canonical/demo",
    },
    actor: { id: "actor-relevance-demo", type: "SYSTEM" },
    occurredAt: "2026-07-24T11:01:00.000Z",
    expectedVersion: 0,
  });
  const executed = await executeRelevanceWorkflow(service, {
    newsId,
    input,
    policy: ANDRE_STUDIO_RELEVANCE_POLICY_V1,
    scoring: {
      commandId: "command-relevance-postgres-demo-score",
      idempotencyKey: "idempotency-relevance-postgres-demo-score",
      actor: { id: "actor-relevance-demo", type: "SYSTEM" },
      occurredAt: input.evaluatedAt,
      expectedVersion: 1,
    },
    routing: {
      commandId: "command-relevance-postgres-demo-route",
      idempotencyKey: "idempotency-relevance-postgres-demo-route",
      actor: { id: "actor-relevance-demo", type: "SYSTEM" },
      occurredAt: "2026-07-24T12:01:00.000Z",
    },
  });

  console.log("sistemandrestudio — relevância com PostgreSQL");
  console.log(`Pontuação calculada: ${executed.relevance.value}/100`);
  console.log(`Prioridade: ${executed.relevance.priority}`);
  console.log(`Decisão: ${executed.relevance.decision}`);
  console.log(`Estado após roteamento: ${executed.routing.newState}`);
} finally {
  await firstPool.end();
}

const secondPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(secondPool);
  const recovered = await new PostgresEditorialNewsRepository(
    secondPool,
  ).getById(newsId);
  if (recovered.relevance === null) {
    throw new Error("Persisted relevance result was not recovered.");
  }

  console.log("\nRecuperação após nova conexão:");
  console.log(`Política: ${recovered.relevance.policyVersion}`);
  console.log(`Breakdown recuperado: ${recovered.relevance.criteria.length}`);
  console.log(`Penalidades recuperadas: ${recovered.relevance.penalties.length}`);
  console.log(`Decisão preservada: ${recovered.relevance.decision}`);
  console.log(`Estado preservado: ${recovered.state}`);
} finally {
  await secondPool.end();
}
