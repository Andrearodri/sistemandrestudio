import {
  EditorialDraftWorkflowService, EditorialWorkflowService, VerificationWorkflowService,
  createApprovedWorkflowFixture,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialDraftRepository, PostgresEditorialNewsRepository,
  PostgresVerificationRepository, createDatabasePool, loadDatabaseConfig, runMigrations,
  withTransaction,
} from "../../../packages/database/src/index.ts";

const scenario = "draft-postgres-demo";
const fixture = createApprovedWorkflowFixture(scenario);
const newsId = fixture.receive.newsId;
const pool = createDatabasePool(loadDatabaseConfig());
try {
  await runMigrations(pool);
  await cleanup();
  const editorial = new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool));
  await editorial.execute(fixture.receive);
  for (const command of fixture.commands.slice(0, 3)) await editorial.execute(command);
  const verification = new VerificationWorkflowService(new PostgresVerificationRepository(pool));
  const verificationId = `verification-${scenario}`;
  const verified = await verification.evaluate({ newsId, verificationId, commandId: `verification-command-${scenario}`, idempotencyKey: `verification-key-${scenario}`, expectedVersion: 3, actor: { type: "SYSTEM", id: "demo" }, occurredAt: "2026-07-25T12:00:00.000Z", allowedSourceIds: ["official-demo"], claims: [{ id: `claim-${scenario}`, text: "A Fonte Oficial anunciou o Orbit 2.0.", type: "PRODUCT_LAUNCH", importance: "PRIMARY", expectedSubject: "Orbit" }], evidence: [{ id: `evidence-${scenario}`, claimId: `claim-${scenario}`, sourceId: "official-demo", canonicalUrl: "https://example.invalid/orbit", sourceAuthority: "PRIMARY_OFFICIAL", evidenceType: "RELEASE_NOTE", retrievedAt: "2026-07-25T12:00:00.000Z", eventDate: "2026-07-25T10:00:00.000Z", excerpt: "A Fonte Oficial anunciou o Orbit 2.0.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }] });
  if (verified.currentState !== "VERIFIED") throw new Error(`Demo verification did not confirm: ${verified.verificationStatus}.`);
  const drafts = new EditorialDraftWorkflowService(new PostgresEditorialDraftRepository(pool));
  console.log(`Estado após verificação: ${(await new PostgresEditorialNewsRepository(pool).getById(newsId)).state}`);
  const input = { newsId, verificationId, format: "WEBSITE_NEWS_BRIEF" as const, idempotencyKey: `draft-key-${scenario}`, commandId: `draft-command-${scenario}`, approvalRequestId: `draft-approval-${scenario}`, expectedVersion: 4, actor: { type: "SYSTEM" as const, id: "demo" }, occurredAt: "2026-07-25T12:00:00.000Z" };
  const first = await drafts.createDraft(input);
  await pool.end();
  const replayPool = createDatabasePool(loadDatabaseConfig());
  try {
    const replay = await new EditorialDraftWorkflowService(new PostgresEditorialDraftRepository(replayPool)).createDraft(input);
    console.log(`sistemandrestudio — rascunho PostgreSQL\nTítulo: ${first.draft.title}\nCitações: ${first.draft.sourceCitations.length}\nValidação: ${first.draft.validationStatus}\nEstado final: ${first.currentState}\nReplay após reconexão: ${replay.replayed}\nEventos adicionais: 0`);
  } finally { await replayPool.end(); }
} finally { if ((pool as unknown as { ended?: boolean }).ended !== true) await pool.end().catch(() => undefined); }

async function cleanup(): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`UPDATE editorial_news SET current_draft_version_id = NULL, current_approval_request_id = NULL WHERE id = $1`, [newsId]);
    await client.query(`DELETE FROM editorial_draft_validations WHERE draft_id IN (SELECT id FROM editorial_drafts WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM editorial_draft_citations WHERE draft_id IN (SELECT id FROM editorial_drafts WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM editorial_drafts WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM editorial_brief_facts WHERE brief_id IN (SELECT id FROM editorial_briefs WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM editorial_brief_claims WHERE brief_id IN (SELECT id FROM editorial_briefs WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM editorial_briefs WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM verification_claim_results WHERE result_id IN (SELECT id FROM verification_results WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM verification_results WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM verification_evidence WHERE claim_id IN (SELECT id FROM verification_claims WHERE news_id = $1)`, [newsId]);
    await client.query(`DELETE FROM verification_claims WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM verification_runs WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM approval_actions WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM processed_commands WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM audit_events WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM editorial_relevance_results WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM approval_requests WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM draft_versions WHERE news_id = $1`, [newsId]);
    await client.query(`DELETE FROM editorial_news WHERE id = $1`, [newsId]);
  });
}
