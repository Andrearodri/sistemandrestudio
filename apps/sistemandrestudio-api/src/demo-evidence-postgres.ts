import {
  EditorialWorkflowService,
  createApprovedWorkflowFixture,
} from "../../../packages/application/src/index.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  OfficialEvidenceAcquisitionService,
  OfficialPageClient,
} from "../../../packages/evidence/src/index.ts";
import {
  FIXTURE_TIME,
  SIMPLE_OFFICIAL_ARTICLE,
} from "../../../packages/evidence/test/fixtures.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresEvidenceAcquisitionRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
  withTransaction,
} from "../../../packages/database/src/index.ts";
import { getOfficialSource } from "../../../packages/sources/src/index.ts";

const scenarioId = "evidence-postgres-demo";
const fixture = createApprovedWorkflowFixture(scenarioId);
const itemId = `source-item-${scenarioId}`;
const input = {
  acquisitionId: `acquisition-${scenarioId}`,
  radarItemId: itemId,
  verificationId: `verification-${scenarioId}`,
  commandId: `command-evidence-${scenarioId}`,
  idempotencyKey: `evidence-key-${scenarioId}`,
  expectedVersion: 3,
  actor: { type: "SYSTEM" as const, id: "official-evidence-demo" },
  occurredAt: FIXTURE_TIME,
  claims: [{
    id: `${fixture.receive.newsId}-claim-launch`,
    text: "Acme launched Orbit 2.0.",
    type: "PRODUCT_LAUNCH" as const,
    importance: "PRIMARY" as const,
    expectedSubject: "Orbit",
  }],
};
const config = loadDatabaseConfig();

const firstPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(firstPool);
  await runMigrations(firstPool);
  await cleanupDemo(firstPool);
  const source = getOfficialSource("github-blog");
  if (source === undefined) throw new Error("Demo source is missing.");
  const editorial = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(firstPool),
  );
  await editorial.execute(fixture.receive);
  for (const envelope of fixture.commands.slice(0, 3)) {
    await editorial.execute(envelope);
  }
  await firstPool.query(
    `INSERT INTO source_definitions (
       id, name, organization, feed_url, definition, enabled
     ) VALUES ($1, $2, $3, $4, $5::jsonb, true)
     ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
    [
      source.id,
      source.name,
      source.organization,
      source.feedUrl,
      JSON.stringify(source),
    ],
  );
  await firstPool.query(
    `INSERT INTO collected_source_items (
       id, source_id, canonical_url, title, summary,
       published_at, collected_at, content_hash, editorial_news_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      itemId,
      source.id,
      "https://github.blog/releases/orbit-2",
      "Acme launches Orbit 2.0",
      "Bounded fictitious evidence demo.",
      "2026-07-24T10:00:00.000Z",
      FIXTURE_TIME,
      "demo-evidence-content-hash",
      fixture.receive.newsId,
    ],
  );
  const result = await service(firstPool).acquire(input);
  console.log("sistemandrestudio — aquisição de evidência PostgreSQL");
  console.log(`Páginas: ${result.pagesConsulted}`);
  console.log(`Evidências: ${result.evidence}`);
  console.log(`Status factual: ${result.verificationStatus}`);
  console.log(`Estado editorial: ${result.currentState}`);
} finally {
  await firstPool.end();
}

const secondPool = createDatabasePool(config);
try {
  await checkDatabaseConnection(secondPool);
  const editorial = new PostgresEditorialNewsRepository(secondPool);
  const before = await editorial.listAuditEvents(fixture.receive.newsId);
  const replay = await service(secondPool).acquire(input);
  const after = await editorial.listAuditEvents(fixture.receive.newsId);
  console.log("\nRecuperação após reconexão:");
  console.log(`Replay: ${String(replay.replayed)}`);
  console.log(`Eventos adicionais: ${after.length - before.length}`);
  console.log(`Estado final: ${replay.currentState}`);
} finally {
  await secondPool.end();
}

function service(
  pool: ReturnType<typeof createDatabasePool>,
): OfficialEvidenceAcquisitionService {
  return new OfficialEvidenceAcquisitionService(
    new PostgresEvidenceAcquisitionRepository(pool),
    new OfficialPageClient(
      (async () => new Response(SIMPLE_OFFICIAL_ARTICLE, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch,
      async () => [{ address: "140.82.112.4" }],
    ),
    { ...DEFAULT_EVIDENCE_LIMITS, maxRetries: 0 },
  );
}

async function cleanupDemo(
  pool: ReturnType<typeof createDatabasePool>,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `DELETE FROM evidence_candidates WHERE source_item_id = $1`,
      [itemId],
    );
    await client.query(
      `DELETE FROM official_page_metadata WHERE snapshot_id IN (
         SELECT id FROM official_page_snapshots WHERE source_item_id = $1
       )`,
      [itemId],
    );
    await client.query(
      `DELETE FROM official_page_snapshots WHERE source_item_id = $1`,
      [itemId],
    );
    await client.query(
      `DELETE FROM official_page_fetch_runs WHERE source_item_id = $1`,
      [itemId],
    );
    await client.query(
      `DELETE FROM evidence_acquisition_runs WHERE source_item_id = $1`,
      [itemId],
    );
    await client.query(
      `DELETE FROM collected_source_items WHERE id = $1`,
      [itemId],
    );
    await client.query(
      `DELETE FROM verification_claim_results
       WHERE result_id IN (
         SELECT id FROM verification_results WHERE news_id = $1
       )`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM verification_results WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM verification_evidence WHERE claim_id IN (
         SELECT id FROM verification_claims WHERE news_id = $1
       )`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM verification_claims WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM verification_runs WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM processed_commands WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM audit_events WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM editorial_relevance_results WHERE news_id = $1`,
      [fixture.receive.newsId],
    );
    await client.query(
      `DELETE FROM editorial_news WHERE id = $1`,
      [fixture.receive.newsId],
    );
  });
}
