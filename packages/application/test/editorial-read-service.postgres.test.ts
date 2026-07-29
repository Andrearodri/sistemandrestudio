import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";

import { createOrchestrationHttpServer } from "../../../apps/sistemandrestudio-api/src/orchestration-server.ts";
import {
  createApprovedWorkflowFixture,
  EditorialDraftWorkflowService,
  EditorialReadService,
  EditorialReadError,
  EditorialWorkflowService,
  VerificationWorkflowService,
} from "../src/index.ts";
import {
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  PostgresEditorialDraftRepository,
  PostgresEditorialNewsRepository,
  PostgresEditorialReadRepository,
  PostgresVerificationRepository,
  resetTestDatabase,
} from "../../database/src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
let pool: Pool;
let seeded: Awaited<ReturnType<typeof seed>>;

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
  seeded = await seed();
});

after(async () => pool.end());

describe("editorial read service with PostgreSQL", () => {
  test("reads health, status, item, evidence and draft without side effects", async () => {
    const service = new EditorialReadService(
      new PostgresEditorialReadRepository(pool),
    );
    const before = await persistentCounts();

    assert.deepEqual(await service.health(), { database: "available" });
    const status = await service.systemStatus();
    assert.equal(status.database, "available");
    assert.equal(status.itemsByState.PENDING_APPROVAL, 1);

    const listed = await service.listItems({
      state: "PENDING_APPROVAL",
      limit: 1,
    });
    assert.equal(listed.items[0]?.newsId, seeded.newsId);
    assert.equal(listed.page.limit, 1);

    const item = await service.getItem(seeded.newsId);
    assert.equal(item.state, "PENDING_APPROVAL");
    assert.equal(item.currentDraftVersionId, seeded.draftId);

    const evidence = await service.getEvidence({
      newsId: seeded.newsId,
      limit: 10,
    });
    assert.equal(evidence.evidence[0]?.evidenceId, seeded.evidenceId);
    assert.equal(evidence.evidence[0]?.supportsClaim, true);

    const draft = await service.getDraft(seeded.draftId, 1);
    assert.equal(draft.draftId, seeded.draftId);
    assert.equal(draft.version, 1);
    assert.equal(draft.citations[0]?.evidenceId, seeded.evidenceId);

    await assert.rejects(
      service.getItem("missing-read-item"),
      (error: EditorialReadError) =>
        error.code === "EDITORIAL_READ_ITEM_NOT_FOUND",
    );
    await assert.rejects(
      service.getDraft("missing-read-draft"),
      (error: EditorialReadError) =>
        error.code === "EDITORIAL_READ_DRAFT_NOT_FOUND",
    );

    assert.deepEqual(await persistentCounts(), before);
  });

  test("serves all six HTTP endpoints from PostgreSQL without writes or leaks", async () => {
    const before = await persistentCounts();
    const secret = "postgres-read-test-secret-32-characters";
    const audit: unknown[] = [];
    const server = createOrchestrationHttpServer({
      runtime: {
        readService: new EditorialReadService(
          new PostgresEditorialReadRepository(pool),
        ),
        service: {
          startScheduledRun: async () => null as never,
          getRun: async () => null as never,
          resumeRun: async () => null as never,
          getPendingHumanDecisions: async () => [],
          registerExternalDecision: async () => null as never,
        },
      },
      credentials: [{
        id: "postgres-read-test",
        secret,
        scopes: ["editorial:read"],
      }],
      dryRun: true,
      audit: (event) => audit.push(event),
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
      );
      const address = server.address() as AddressInfo;
      const root = `http://127.0.0.1:${address.port}`;
      const paths = [
        "/internal/health",
        "/internal/system/status",
        "/internal/editorial/items?state=PENDING_APPROVAL&limit=10",
        `/internal/editorial/items/${seeded.newsId}`,
        `/internal/editorial/items/${seeded.newsId}/evidence`,
        `/internal/editorial/drafts/${seeded.draftId}?version=1`,
      ];
      for (const path of paths) {
        const response = await fetch(`${root}${path}`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("cache-control"), "no-store");
      }
      for (const path of [
        "/internal/editorial/items/missing-read-item",
        "/internal/editorial/drafts/missing-read-draft",
      ]) {
        const response = await fetch(`${root}${path}`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        assert.equal(response.status, 404, path);
      }
      assert.doesNotMatch(JSON.stringify(audit), /Bearer|postgres-read-test-secret/);
      assert.deepEqual(await persistentCounts(), before);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function seed() {
  const scenario = "read-postgres";
  const fixture = createApprovedWorkflowFixture(scenario);
  const newsService = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(pool),
  );
  await newsService.execute(fixture.receive);
  for (const command of fixture.commands.slice(0, 3)) {
    await newsService.execute(command);
  }

  const at = "2026-07-29T12:00:00.000Z";
  const verificationId = `verification-${scenario}`;
  const claimId = `claim-${scenario}`;
  const evidenceId = `evidence-${scenario}`;
  await new VerificationWorkflowService(
    new PostgresVerificationRepository(pool),
  ).evaluate({
    newsId: fixture.receive.newsId,
    verificationId,
    commandId: `verification-command-${scenario}`,
    idempotencyKey: `verification-key-${scenario}`,
    expectedVersion: 3,
    actor: { type: "SYSTEM", id: "read-test" },
    occurredAt: at,
    allowedSourceIds: ["official-test"],
    claims: [{
      id: claimId,
      text: "Orbit 2.0 was officially announced.",
      type: "PRODUCT_LAUNCH",
      importance: "PRIMARY",
      expectedSubject: "Orbit",
    }],
    evidence: [{
      id: evidenceId,
      claimId,
      sourceId: "official-test",
      canonicalUrl: "https://example.com/orbit",
      sourceAuthority: "PRIMARY_OFFICIAL",
      evidenceType: "RELEASE_NOTE",
      retrievedAt: at,
      eventDate: at,
      excerpt: "Orbit 2.0 was officially announced.",
      structuredFacts: { announced: true },
      supportsClaim: true,
      contradictsClaim: false,
    }],
  });
  const result = await new EditorialDraftWorkflowService(
    new PostgresEditorialDraftRepository(pool),
  ).createDraft({
    newsId: fixture.receive.newsId,
    verificationId,
    format: "WEBSITE_NEWS_BRIEF",
    idempotencyKey: `draft-key-${scenario}`,
    commandId: `draft-command-${scenario}`,
    approvalRequestId: `approval-${scenario}`,
    expectedVersion: 4,
    actor: { type: "SYSTEM", id: "read-test" },
    occurredAt: at,
  });
  return {
    newsId: fixture.receive.newsId,
    draftId: result.draft.draftId,
    evidenceId,
  };
}

async function persistentCounts() {
  const tableRows = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'
     ORDER BY table_name`,
  );
  const tables = tableRows.rows.map((row) => row.table_name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    assert.match(table, /^[a-z][a-z0-9_]*$/);
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) FROM ${table}`,
    );
    counts[table] = Number(result.rows[0]?.count ?? 0);
  }
  return counts;
}
