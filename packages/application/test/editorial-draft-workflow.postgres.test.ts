import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";
import { createEditorialBrief, generateEditorialDraft } from "../../content-engine/src/index.ts";
import {
  PostgresEditorialDraftRepository, PostgresEditorialNewsRepository,
  PostgresVerificationRepository, assertSafeTestDatabase, createDatabasePool,
  loadDatabaseConfig, resetTestDatabase,
} from "../../database/src/index.ts";
import {
  EditorialDraftWorkflowError, EditorialDraftWorkflowService,
  EditorialWorkflowService, VerificationWorkflowService,
  createApprovedWorkflowFixture,
} from "../src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
let pool: Pool;
before(async () => { pool = createDatabasePool(config); await resetTestDatabase(pool, config); });
beforeEach(async () => { await pool.query(`TRUNCATE TABLE editorial_draft_validations,editorial_draft_citations,editorial_drafts,editorial_brief_facts,editorial_brief_claims,editorial_briefs,verification_claim_results,verification_results,verification_evidence,verification_claims,verification_runs,approval_actions,processed_commands,audit_events,editorial_relevance_results,approval_requests,draft_versions,editorial_news CASCADE`); });
after(async () => { await pool.end(); });

describe("controlled editorial draft transaction with PostgreSQL", () => {
  test("persists a valid draft and reaches PENDING_APPROVAL", async () => {
    const input = await seedConfirmed("persist");
    const result = await service().createDraft(input);
    const news = await new PostgresEditorialNewsRepository(pool).getById(input.newsId);
    assert.equal(result.currentState, "PENDING_APPROVAL");
    assert.equal(result.draft.validationStatus, "VALID");
    assert.equal(news.approvalRequests.length, 1);
    assert.equal(await scalar("SELECT count(*) FROM editorial_drafts"), 1);
  });
  test("replays after persistence without duplicate draft, approval or event", async () => {
    const input = await seedConfirmed("replay");
    await service().createDraft(input);
    const beforeEvents = await scalar("SELECT count(*) FROM audit_events");
    const replay = await service().createDraft(input);
    assert.equal(replay.replayed, true);
    assert.equal(await scalar("SELECT count(*) FROM editorial_drafts"), 1);
    assert.equal(await scalar("SELECT count(*) FROM approval_requests"), 1);
    assert.equal(await scalar("SELECT count(*) FROM audit_events"), beforeEvents);
  });
  test("two concurrent executions produce one draft and a controlled replay or conflict", async () => {
    const input = await seedConfirmed("concurrent");
    const attempts = await Promise.allSettled([service().createDraft(input), service().createDraft(input)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    if (rejected !== undefined && rejected.status === "rejected") {
      assert.equal((rejected.reason as EditorialDraftWorkflowError).code, "EDITORIAL_DRAFT_CONCURRENCY_CONFLICT");
    }
    assert.equal(await scalar("SELECT count(*) FROM editorial_drafts"), 1);
    assert.equal(await scalar("SELECT count(*) FROM approval_requests"), 1);
  });
  test("stale expected version rolls back all editorial draft rows", async () => {
    const input = await seedConfirmed("stale");
    await assert.rejects(service().createDraft({ ...input, expectedVersion: 3 }), (error) => error instanceof EditorialDraftWorkflowError && error.code === "EDITORIAL_DRAFT_CONCURRENCY_CONFLICT");
    assert.equal(await scalar("SELECT count(*) FROM editorial_briefs"), 0);
    assert.equal(await scalar("SELECT count(*) FROM editorial_drafts"), 0);
    assert.equal((await new PostgresEditorialNewsRepository(pool).getById(input.newsId)).state, "VERIFIED");
  });
  test("a persistence failure after transitions rolls back aggregate, brief and approval", async () => {
    const input = await seedConfirmed("rollback");
    const repository = new PostgresEditorialDraftRepository(pool);
    const context = (await repository.loadContext(input.newsId, input.verificationId))!;
    const brief = createEditorialBrief({ ...context, createdAt: input.occurredAt });
    const valid = await generateEditorialDraft({ brief, format: input.format, language: "pt-BR", tone: "informativo", maxCharacters: 3000, editorialIdentityVersion: "v1" });
    const draft = { ...valid, sourceCitations: valid.sourceCitations.map((citation) => ({ ...citation, evidenceId: "missing-evidence" })) };
    await assert.rejects(repository.executeAtomic({ input, brief, draft, fingerprint: "forced-persistence-failure" }));
    assert.equal(await scalar("SELECT count(*) FROM editorial_briefs"), 0);
    assert.equal(await scalar("SELECT count(*) FROM approval_requests"), 0);
    assert.equal((await new PostgresEditorialNewsRepository(pool).getById(input.newsId)).state, "VERIFIED");
  });
});

function service() { return new EditorialDraftWorkflowService(new PostgresEditorialDraftRepository(pool)); }
async function seedConfirmed(scenario: string) {
  const fixture = createApprovedWorkflowFixture(`draft-integration-${scenario}`);
  const editorial = new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool));
  await editorial.execute(fixture.receive);
  for (const command of fixture.commands.slice(0, 3)) await editorial.execute(command);
  const verificationId = `verification-draft-integration-${scenario}`;
  const claimId = `claim-draft-integration-${scenario}`;
  await new VerificationWorkflowService(new PostgresVerificationRepository(pool)).evaluate({ newsId: fixture.receive.newsId, verificationId, commandId: `verification-command-${scenario}`, idempotencyKey: `verification-key-${scenario}`, expectedVersion: 3, actor: { type: "SYSTEM", id: "test" }, occurredAt: "2026-07-25T12:00:00.000Z", allowedSourceIds: ["official-test"], claims: [{ id: claimId, text: "Orbit 2.0 was officially announced.", type: "PRODUCT_LAUNCH", importance: "PRIMARY", expectedSubject: "Orbit" }], evidence: [{ id: `evidence-${scenario}`, claimId, sourceId: "official-test", canonicalUrl: "https://example.com/orbit", sourceAuthority: "PRIMARY_OFFICIAL", evidenceType: "RELEASE_NOTE", retrievedAt: "2026-07-25T12:00:00.000Z", eventDate: "2026-07-25T10:00:00.000Z", excerpt: "Orbit 2.0 was officially announced.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }] });
  return { newsId: fixture.receive.newsId, verificationId, format: "WEBSITE_NEWS_BRIEF" as const, idempotencyKey: `draft-key-${scenario}`, commandId: `draft-command-${scenario}`, approvalRequestId: `approval-${scenario}`, expectedVersion: 4, actor: { type: "SYSTEM" as const, id: "test" }, occurredAt: "2026-07-25T12:00:00.000Z" };
}
async function scalar(sql: string): Promise<number> { const result = await pool.query<{ count: string }>(sql); return Number(result.rows[0]?.count ?? 0); }
