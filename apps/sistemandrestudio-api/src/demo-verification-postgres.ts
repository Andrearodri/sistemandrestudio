import {
  EditorialWorkflowService,
  VerificationWorkflowService,
  createApprovedWorkflowFixture,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresVerificationRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import { removePreviousEditorialDemo } from "./demo-postgres-support.ts";

const fixture = createApprovedWorkflowFixture("verification-postgres-demo");
const verificationInput = {
  newsId: fixture.receive.newsId,
  verificationId: "verification-postgres-demo",
  commandId: "verification-command-postgres-demo",
  idempotencyKey: "verification-idempotency-postgres-demo",
  expectedVersion: 3,
  actor: { type: "SYSTEM" as const, id: "factual-verification-demo" },
  occurredAt: "2026-07-24T12:00:00.000Z",
  claims: [{
    id: "verification-postgres-demo-claim",
    text: "The fictitious product is available.",
    type: "PRODUCT_LAUNCH" as const,
    importance: "PRIMARY" as const,
  }],
  evidence: [{
    id: "verification-postgres-demo-evidence",
    claimId: "verification-postgres-demo-claim",
    sourceId: "fictional-primary",
    canonicalUrl: "https://example.invalid/factual-demo",
    sourceAuthority: "PRIMARY_OFFICIAL" as const,
    evidenceType: "RELEASE_NOTE" as const,
    publishedAt: "2026-07-24T10:00:00.000Z",
    eventDate: "2026-07-24T10:00:00.000Z",
    retrievedAt: "2026-07-24T12:00:00.000Z",
    excerpt: "Bounded fictitious evidence for the local demonstration.",
    structuredFacts: { availability: "declared" },
    supportsClaim: true,
    contradictsClaim: false,
  }],
  allowedSourceIds: ["fictional-primary"],
  allowedSources: [{
    id: "fictional-primary",
    allowedHosts: ["example.invalid"],
  }],
};

const config = loadDatabaseConfig();
const firstPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(firstPool);
  await runMigrations(firstPool);
  await removePreviousEditorialDemo(firstPool, fixture.receive.newsId);
  const editorial = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(firstPool),
  );
  await editorial.execute(fixture.receive);
  for (const envelope of fixture.commands.slice(0, 3)) {
    await editorial.execute(envelope);
  }
  const result = await new VerificationWorkflowService(
    new PostgresVerificationRepository(firstPool),
  ).evaluate(verificationInput);
  console.log("sistemandrestudio — verificação factual PostgreSQL");
  console.log(`Status: ${result.verificationStatus}`);
  console.log(`Decisão: ${result.editorialDecision}`);
  console.log(`Estado editorial: ${result.currentState}`);
  console.log(`Replay inicial: ${String(result.replayed)}`);
} finally {
  await firstPool.end();
}

const secondPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(secondPool);
  const verificationRepository = new PostgresVerificationRepository(secondPool);
  const editorialRepository = new PostgresEditorialNewsRepository(secondPool);
  const before = await editorialRepository.listAuditEvents(
    verificationInput.newsId,
  );
  const recovered = await verificationRepository.findComplete(
    verificationInput.verificationId,
  );
  const replay = await new VerificationWorkflowService(
    verificationRepository,
  ).evaluate(verificationInput);
  const after = await editorialRepository.listAuditEvents(
    verificationInput.newsId,
  );
  const news = await editorialRepository.getById(verificationInput.newsId);

  console.log("\nRecuperação após reconexão:");
  console.log(`Claims recuperadas: ${recovered?.claims.length ?? 0}`);
  console.log(`Evidências recuperadas: ${recovered?.evidence.length ?? 0}`);
  console.log(`Replay idempotente: ${String(replay.replayed)}`);
  console.log(`Eventos adicionais: ${after.length - before.length}`);
  console.log(`Estado editorial final: ${news.state}`);
} finally {
  await secondPool.end();
}
