import assert from "node:assert/strict";
import {
  after,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";

import type { Pool } from "pg";

import {
  EditorialWorkflowService,
  createApprovedWorkflowFixture,
} from "../src/index.ts";
import type {
  VerificationClaim,
} from "../../content-engine/src/index.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  EvidenceAcquisitionError,
  OfficialEvidenceAcquisitionService,
  OfficialPageClient,
} from "../../evidence/src/index.ts";
import {
  CHANGELOG_PAGE,
  CONTRADICTORY_PAGE,
  FIXTURE_TIME,
  OLD_UPDATED_PAGE,
  PROMOTIONAL_PAGE,
  SIMPLE_OFFICIAL_ARTICLE,
} from "../../evidence/test/fixtures.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresEvidenceAcquisitionRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  listOperationalEvidenceItems,
  resetTestDatabase,
} from "../../database/src/index.ts";
import {
  getOfficialSource,
} from "../../sources/src/index.ts";
import type {
  EvidenceAcquisitionInput,
} from "../../evidence/src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);

let pool: Pool;

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
});

beforeEach(async () => {
  await pool.query(`
    TRUNCATE TABLE
      evidence_candidates,
      official_page_metadata,
      official_page_snapshots,
      official_page_fetch_runs,
      evidence_acquisition_runs,
      verification_claim_results,
      verification_results,
      verification_evidence,
      verification_claims,
      verification_runs,
      source_item_duplicates,
      collected_source_items,
      source_fetch_runs,
      source_definitions,
      approval_actions,
      processed_commands,
      audit_events,
      editorial_relevance_results,
      approval_requests,
      draft_versions,
      editorial_news
    CASCADE
  `);
});

after(async () => {
  await pool.end();
});

describe("official evidence acquisition with PostgreSQL", () => {
  test("persists fetch, bounded snapshot, metadata and candidate", async () => {
    const context = await pendingItem("complete");
    const result = await context.service.acquire(context.input);
    const counts = await acquisitionCounts(context.input.radarItemId);

    assert.equal(result.verificationStatus, "CONFIRMED");
    assert.deepEqual(counts, {
      acquisitions: 1,
      fetches: 1,
      snapshots: 1,
      metadata: 1,
      candidates: 1,
      verifications: 1,
    });
  });

  test("never stores the complete HTML response", async () => {
    const context = await pendingItem("no-html");
    await context.service.acquire(context.input);
    const snapshot = await pool.query<{
      readonly minimal_text: string;
      readonly selected_metadata: unknown;
    }>(
      `SELECT minimal_text, selected_metadata
       FROM official_page_snapshots
       WHERE source_item_id = $1`,
      [context.input.radarItemId],
    );
    const serialized = JSON.stringify(snapshot.rows[0]);
    assert.equal(serialized.includes("<html"), false);
    assert.equal(serialized.includes("<script"), false);
    assert.ok((snapshot.rows[0]?.minimal_text.length ?? 0) <= 6_000);
  });

  test("persists policy versions and closes acquisition", async () => {
    const context = await pendingItem("policy");
    await context.service.acquire(context.input);
    const run = await pool.query<{
      readonly policy_version: string;
      readonly source_policy_version: string;
      readonly status: string;
      readonly finished_at: Date | null;
    }>("SELECT * FROM evidence_acquisition_runs");
    assert.deepEqual(
      {
        acquisition: run.rows[0]?.policy_version,
        source: run.rows[0]?.source_policy_version,
        status: run.rows[0]?.status,
        finished: run.rows[0]?.finished_at instanceof Date,
      },
      {
        acquisition: "official-evidence-acquisition-v1",
        source: "official-page-policy-v1",
        status: "SUCCEEDED",
        finished: true,
      },
    );
  });

  test("associates candidate with persisted claim and evidence", async () => {
    const context = await pendingItem("association");
    await context.service.acquire(context.input);
    const candidate = await pool.query<{
      readonly claim_exists: boolean;
      readonly evidence_exists: boolean;
    }>(`
      SELECT
        EXISTS(
          SELECT 1 FROM verification_claims claim
          WHERE claim.id = candidate.claim_id
        ) AS claim_exists,
        EXISTS(
          SELECT 1 FROM verification_evidence evidence
          WHERE evidence.id = candidate.evidence_id
        ) AS evidence_exists
      FROM evidence_candidates candidate
    `);
    assert.deepEqual(candidate.rows[0], {
      claim_exists: true,
      evidence_exists: true,
    });
  });

  const cases = [
    {
      name: "confirmed",
      body: SIMPLE_OFFICIAL_ARTICLE,
      claims: (id: string) => [launchClaim(id, "primary")],
      status: "CONFIRMED",
      state: "VERIFIED",
    },
    {
      name: "partially-confirmed",
      body: SIMPLE_OFFICIAL_ARTICLE,
      claims: (id: string) => [
        launchClaim(id, "primary"),
        performanceClaim(id, "secondary", "SECONDARY"),
      ],
      status: "PARTIALLY_CONFIRMED",
      state: "PENDING_VERIFICATION",
    },
    {
      name: "insufficient",
      body: PROMOTIONAL_PAGE,
      claims: (id: string) => [
        performanceClaim(id, "primary", "PRIMARY"),
      ],
      status: "INSUFFICIENT_EVIDENCE",
      state: "VERIFICATION_REJECTED",
    },
    {
      name: "outdated",
      body: OLD_UPDATED_PAGE,
      claims: (id: string) => [launchClaim(id, "primary")],
      status: "OUTDATED",
      state: "VERIFICATION_REJECTED",
    },
    {
      name: "contradicted",
      body: CONTRADICTORY_PAGE,
      claims: (id: string) => [launchClaim(id, "primary")],
      status: "CONTRADICTED",
      state: "VERIFICATION_REJECTED",
    },
  ] as const;

  for (const scenario of cases) {
    test(`persists ${scenario.name} and editorial state ${scenario.state}`, async () => {
      const context = await pendingItem(
        `status-${scenario.name}`,
        scenario.body,
        scenario.claims,
      );
      const result = await context.service.acquire(context.input);
      const news = await new PostgresEditorialNewsRepository(pool)
        .getById(result.newsId);
      assert.equal(result.verificationStatus, scenario.status);
      assert.equal(result.currentState, scenario.state);
      assert.equal(news.state, scenario.state);
    });
  }

  test("replays without duplicate rows or editorial events", async () => {
    const context = await pendingItem("replay");
    const first = await context.service.acquire(context.input);
    const eventsBefore = await eventCount(first.newsId);
    const replay = await context.service.acquire(context.input);
    const eventsAfter = await eventCount(first.newsId);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(eventsAfter, eventsBefore);
    assert.equal((await acquisitionCounts(context.input.radarItemId)).fetches, 1);
  });

  test("replays after closing and reopening a connection", async () => {
    const context = await pendingItem("reconnect");
    const firstPool = createDatabasePool(config);
    await serviceFor(firstPool, SIMPLE_OFFICIAL_ARTICLE).acquire(context.input);
    await firstPool.end();

    const secondPool = createDatabasePool(config);
    try {
      const replay = await serviceFor(secondPool, SIMPLE_OFFICIAL_ARTICLE)
        .acquire(context.input);
      assert.equal(replay.replayed, true);
      assert.equal(replay.currentState, "VERIFIED");
    } finally {
      await secondPool.end();
    }
  });

  test("rejects same key when bounded page content changes", async () => {
    const context = await pendingItem(
      "idempotency-conflict",
      SIMPLE_OFFICIAL_ARTICLE,
      (id) => [
        launchClaim(id, "primary"),
        performanceClaim(id, "secondary", "SECONDARY"),
      ],
    );
    await context.service.acquire(context.input);
    const changed = serviceFor(
      pool,
      SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally"),
    );
    await assert.rejects(
      changed.acquire(context.input),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
    );
    assert.equal((await acquisitionCounts(context.input.radarItemId)).acquisitions, 1);
  });

  test("preserves a new snapshot when page content changes under a new run", async () => {
    const context = await pendingItem(
      "changed-page",
      SIMPLE_OFFICIAL_ARTICLE,
      (id) => [
        launchClaim(id, "primary-a"),
        performanceClaim(id, "secondary-a", "SECONDARY"),
      ],
    );
    await context.service.acquire(context.input);
    const second = changedAttempt(context.input, "b");
    await serviceFor(
      pool,
      SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally"),
    ).acquire(second);
    const counts = await acquisitionCounts(context.input.radarItemId);
    assert.equal(counts.acquisitions, 2);
    assert.equal(counts.snapshots, 2);
    assert.equal(counts.verifications, 2);
  });

  test("rolls back all acquisition rows on concurrency conflict", async () => {
    const context = await pendingItem("concurrency");
    await assert.rejects(
      context.service.acquire({ ...context.input, expectedVersion: 2 }),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "EVIDENCE_ACQUISITION_CONCURRENCY_CONFLICT",
    );
    assert.deepEqual(await acquisitionCounts(context.input.radarItemId), {
      acquisitions: 0,
      fetches: 0,
      snapshots: 0,
      metadata: 0,
      candidates: 0,
      verifications: 0,
    });
  });

  test("rolls back after page persistence when editorial transition fails", async () => {
    const context = await pendingItem("rollback-transition");
    await assert.rejects(
      context.service.acquire({
        ...context.input,
        commandId: "command-rollback-transition-03",
      }),
    );
    assert.deepEqual(await acquisitionCounts(context.input.radarItemId), {
      acquisitions: 0,
      fetches: 0,
      snapshots: 0,
      metadata: 0,
      candidates: 0,
      verifications: 0,
    });
    assert.equal(await eventCount(context.input.newsId), 3);
  });

  test("keeps promotional performance page without candidates", async () => {
    const context = await pendingItem(
      "promotional",
      PROMOTIONAL_PAGE,
      (id) => [performanceClaim(id, "primary", "PRIMARY")],
    );
    const result = await context.service.acquire(context.input);
    assert.equal(result.evidence, 0);
    assert.equal((await acquisitionCounts(context.input.radarItemId)).candidates, 0);
  });

  test("stores only the explicit contradiction candidate", async () => {
    const context = await pendingItem("contradiction", CONTRADICTORY_PAGE);
    const result = await context.service.acquire(context.input);
    const candidate = await pool.query<{
      readonly supports_claim: boolean;
      readonly contradicts_claim: boolean;
    }>("SELECT supports_claim, contradicts_claim FROM evidence_candidates");
    assert.equal(result.verificationStatus, "CONTRADICTED");
    assert.deepEqual(candidate.rows, [{
      supports_claim: false,
      contradicts_claim: true,
    }]);
  });

  test("persists changelog authority and matching version", async () => {
    const context = await pendingItem(
      "changelog",
      CHANGELOG_PAGE,
      (id) => [{
        id: `${id}-claim-version`,
        text: "Orbit version 2.0 was released.",
        type: "VERSION_RELEASE",
        importance: "PRIMARY",
        expectedSubject: "Orbit",
      }],
      "https://github.blog/changelog/orbit-2",
    );
    const result = await context.service.acquire(context.input);
    const candidate = await pool.query<{ readonly authority: string }>(
      "SELECT authority FROM evidence_candidates",
    );
    assert.equal(result.verificationStatus, "CONFIRMED");
    assert.equal(candidate.rows[0]?.authority, "OFFICIAL_CHANGELOG");
  });

  test("preserves prior editorial events when acquisition succeeds", async () => {
    const context = await pendingItem("history");
    const before = await new PostgresEditorialNewsRepository(pool)
      .listAuditEvents(context.input.newsId ?? "");
    const result = await context.service.acquire(context.input);
    const after = await new PostgresEditorialNewsRepository(pool)
      .listAuditEvents(result.newsId);
    assert.deepEqual(after.slice(0, 3), before);
    assert.equal(after[3]?.action, "ApproveVerification");
  });

  test("persists A, replays A, versions B and replays B", async () => {
    const context = await pendingItem(
      "content-lifecycle",
      SIMPLE_OFFICIAL_ARTICLE,
      (id) => [
        launchClaim(id, "primary"),
        performanceClaim(id, "secondary", "SECONDARY"),
      ],
    );
    const input = contentVersioned(context.input);
    const first = await context.service.acquire(input);
    const replayA = await context.service.acquire({
      ...input,
      retrievedAt: "2026-07-24T12:01:00.000Z",
    });
    const changed = serviceFor(
      pool,
      SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally"),
    );
    const second = await changed.acquire({
      ...input,
      retrievedAt: "2026-07-24T12:02:00.000Z",
    });
    const replayB = await changed.acquire({
      ...input,
      retrievedAt: "2026-07-24T12:03:00.000Z",
    });
    const counts = await acquisitionCounts(input.radarItemId);

    assert.equal(first.acquisitionOutcome, "NEW_ACQUISITION_VERSION");
    assert.equal(replayA.acquisitionOutcome, "REPLAY");
    assert.equal(second.acquisitionOutcome, "NEW_ACQUISITION_VERSION");
    assert.equal(replayB.acquisitionOutcome, "REPLAY");
    assert.equal(second.previousContentHash, first.currentContentHash);
    assert.notEqual(second.currentContentHash, first.currentContentHash);
    assert.equal(replayB.eventsAdditional, 0);
    assert.deepEqual(counts, {
      acquisitions: 2,
      fetches: 2,
      snapshots: 2,
      metadata: 2,
      candidates: 2,
      verifications: 2,
    });
  });

  test("changed content creates historical verification without overwriting terminal state", async () => {
    const context = await pendingItem(
      "historical-reevaluation",
      PROMOTIONAL_PAGE,
      (id) => [performanceClaim(id, "primary", "PRIMARY")],
    );
    const input = contentVersioned(context.input);
    const first = await context.service.acquire(input);
    const eventsBefore = await eventCount(input.newsId);
    const changed = await serviceFor(
      pool,
      PROMOTIONAL_PAGE.replace(
        "unmatched performance",
        "measured 2x performance using a documented benchmark methodology",
      ),
    ).acquire({
      ...input,
      retrievedAt: "2026-07-24T12:05:00.000Z",
    });
    const eventsAfter = await eventCount(input.newsId);

    assert.equal(first.currentState, "VERIFICATION_REJECTED");
    assert.equal(changed.acquisitionOutcome, "NEW_ACQUISITION_VERSION");
    assert.equal(changed.previousState, "VERIFICATION_REJECTED");
    assert.equal(changed.currentState, "VERIFICATION_REJECTED");
    assert.equal(changed.eventsAdditional, 0);
    assert.equal(eventsAfter, eventsBefore);
    assert.equal((await acquisitionCounts(input.radarItemId)).verifications, 2);
  });

  test("concurrent acquisition of the same content persists once and replays once", async () => {
    const context = await pendingItem(
      "same-hash-concurrent",
      SIMPLE_OFFICIAL_ARTICLE,
      (id) => [
        launchClaim(id, "primary"),
        performanceClaim(id, "secondary", "SECONDARY"),
      ],
    );
    const input = contentVersioned(context.input);
    const [left, right] = await Promise.all([
      context.service.acquire(input),
      context.service.acquire(input),
    ]);
    assert.deepEqual(
      [left.acquisitionOutcome, right.acquisitionOutcome].sort(),
      ["NEW_ACQUISITION_VERSION", "REPLAY"],
    );
    assert.equal((await acquisitionCounts(input.radarItemId)).acquisitions, 1);
    assert.equal((await acquisitionCounts(input.radarItemId)).snapshots, 1);
  });

  test("concurrent different hashes preserve two independent versions", async () => {
    const context = await pendingItem(
      "different-hash-concurrent",
      SIMPLE_OFFICIAL_ARTICLE,
      (id) => [
        launchClaim(id, "primary"),
        performanceClaim(id, "secondary", "SECONDARY"),
      ],
    );
    const input = contentVersioned(context.input);
    const changed = serviceFor(
      pool,
      SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally"),
    );
    const results = await Promise.all([
      context.service.acquire(input),
      changed.acquire(input),
    ]);
    assert.equal(
      results.every((result) =>
        result.acquisitionOutcome === "NEW_ACQUISITION_VERSION"
      ),
      true,
    );
    assert.equal((await acquisitionCounts(input.radarItemId)).acquisitions, 2);
    assert.equal((await acquisitionCounts(input.radarItemId)).snapshots, 2);
    assert.equal((await acquisitionCounts(input.radarItemId)).verifications, 2);
  });

  test("persists external trace key separately from derived identity", async () => {
    const context = await pendingItem("identity-trace");
    const input = contentVersioned(context.input);
    const result = await context.service.acquire(input);
    const persisted = await pool.query<{
      readonly external_idempotency_key: string;
      readonly idempotency_key: string;
      readonly identity_mode: string;
      readonly identity_version: string;
      readonly content_identity_hash: string;
    }>("SELECT * FROM evidence_acquisition_runs");
    assert.equal(
      persisted.rows[0]?.external_idempotency_key,
      context.input.idempotencyKey,
    );
    assert.equal(
      persisted.rows[0]?.idempotency_key,
      `evidence-content:${result.currentContentHash}`,
    );
    assert.equal(persisted.rows[0]?.identity_mode, "CONTENT_VERSIONED");
    assert.equal(
      persisted.rows[0]?.identity_version,
      "evidence-content-identity-v1",
    );
    assert.equal(
      persisted.rows[0]?.content_identity_hash,
      result.currentContentHash,
    );
  });

  test("PostgreSQL selection excludes fixtures and invalid rows, orders and limits real items", async () => {
    const context = await pendingItem("selection");
    await pool.query(
      `DELETE FROM collected_source_items WHERE id = $1`,
      [context.input.radarItemId],
    );
    for (let index = 0; index < 7; index += 1) {
      const synthetic = index === 5;
      const invalid = index === 6;
      await pool.query(
        `INSERT INTO collected_source_items (
           id, source_id, canonical_url, title, summary,
           published_at, collected_at, content_hash, editorial_news_id
         )
         VALUES ($1, 'github-blog', $2, $3, $4, $5, $5, $6, $7)`,
        [
          `selection-${index}`,
          invalid
            ? "not-a-url"
            : `https://github.blog/engineering/selection-${index}`,
          synthetic ? "Fixture selection item" : `Real item ${index}`,
          synthetic ? "Fictitious test data." : "Official engineering update.",
          `2026-07-${String(20 - index).padStart(2, "0")}T10:00:00.000Z`,
          synthetic ? `content-hash-fixture-${index}` : `${index}`.repeat(64),
          context.input.newsId,
        ],
      );
    }
    const selected = await listOperationalEvidenceItems(pool, 5);
    assert.deepEqual(
      selected.map((item) => item.id),
      ["selection-0", "selection-1", "selection-2", "selection-3", "selection-4"],
    );
  });

  test("uses only the test database", () => {
    assert.equal(config.database.endsWith("_test"), true);
  });
});

async function pendingItem(
  id: string,
  body = SIMPLE_OFFICIAL_ARTICLE,
  claims: (newsId: string) => readonly VerificationClaim[] =
    (newsId) => [launchClaim(newsId, "primary")],
  canonicalUrl = "https://github.blog/releases/orbit-2",
) {
  const fixture = createApprovedWorkflowFixture(id);
  const editorial = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(pool),
  );
  await editorial.execute(fixture.receive);
  for (const envelope of fixture.commands.slice(0, 3)) {
    await editorial.execute(envelope);
  }
  const source = getOfficialSource("github-blog");
  assert.ok(source);
  await pool.query(
    `INSERT INTO source_definitions (
       id, name, organization, feed_url, definition, enabled
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, true)`,
    [
      source.id,
      source.name,
      source.organization,
      source.feedUrl,
      JSON.stringify(source),
    ],
  );
  const itemId = `source-item-${id}`;
  await pool.query(
    `INSERT INTO collected_source_items (
       id, source_id, canonical_url, title, summary,
       published_at, collected_at, content_hash, editorial_news_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      itemId,
      source.id,
      canonicalUrl,
      `Orbit fixture ${id}`,
      "Bounded fictitious radar item.",
      "2026-07-24T10:00:00.000Z",
      FIXTURE_TIME,
      `content-hash-${id}`,
      fixture.receive.newsId,
    ],
  );
  const input: EvidenceAcquisitionInput & { readonly newsId: string } = {
    acquisitionId: `acquisition-${id}`,
    radarItemId: itemId,
    verificationId: `verification-evidence-${id}`,
    commandId: `command-evidence-${id}`,
    idempotencyKey: `evidence-key-${id}`,
    expectedVersion: 3,
    actor: { type: "SYSTEM", id: "official-evidence" },
    occurredAt: FIXTURE_TIME,
    claims: claims(fixture.receive.newsId),
    newsId: fixture.receive.newsId,
  };
  return { input, service: serviceFor(pool, body) };
}

function contentVersioned(
  input: EvidenceAcquisitionInput & { readonly newsId?: string },
): EvidenceAcquisitionInput & { readonly newsId: string } {
  return {
    ...input,
    newsId: input.newsId ?? "",
    identityMode: "CONTENT_VERSIONED",
    retrievedAt: "2026-07-24T12:00:00.000Z",
  };
}

function serviceFor(
  targetPool: Pool,
  body: string,
): OfficialEvidenceAcquisitionService {
  return new OfficialEvidenceAcquisitionService(
    new PostgresEvidenceAcquisitionRepository(targetPool),
    new OfficialPageClient(
      (async () => new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })) as typeof fetch,
      async () => [{ address: "140.82.112.4" }],
    ),
    { ...DEFAULT_EVIDENCE_LIMITS, maxRetries: 0 },
  );
}

function launchClaim(newsId: string, suffix: string): VerificationClaim {
  return {
    id: `${newsId}-claim-${suffix}`,
    text: "Acme launched Orbit 2.0.",
    type: "PRODUCT_LAUNCH",
    importance: "PRIMARY",
    expectedSubject: "Orbit",
  };
}

function performanceClaim(
  newsId: string,
  suffix: string,
  importance: "PRIMARY" | "SECONDARY",
): VerificationClaim {
  return {
    id: `${newsId}-claim-${suffix}`,
    text: "Orbit is twice as fast.",
    type: "PERFORMANCE_CLAIM",
    importance,
    expectedSubject: "Orbit",
  };
}

function changedAttempt(
  input: EvidenceAcquisitionInput,
  suffix: string,
): EvidenceAcquisitionInput {
  const newsId = input.claims[0]?.id.split("-claim-")[0] ?? "news";
  return {
    ...input,
    acquisitionId: `${input.acquisitionId}-${suffix}`,
    verificationId: `${input.verificationId}-${suffix}`,
    commandId: `${input.commandId}-${suffix}`,
    idempotencyKey: `${input.idempotencyKey}-${suffix}`,
    claims: [
      launchClaim(newsId, `primary-${suffix}`),
      performanceClaim(newsId, `secondary-${suffix}`, "SECONDARY"),
    ],
  };
}

async function acquisitionCounts(itemId: string) {
  const result = await pool.query<{
    readonly acquisitions: number;
    readonly fetches: number;
    readonly snapshots: number;
    readonly metadata: number;
    readonly candidates: number;
    readonly verifications: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM evidence_acquisition_runs
        WHERE source_item_id = $1) AS acquisitions,
       (SELECT count(*)::integer FROM official_page_fetch_runs
        WHERE source_item_id = $1) AS fetches,
       (SELECT count(*)::integer FROM official_page_snapshots
        WHERE source_item_id = $1) AS snapshots,
       (SELECT count(*)::integer FROM official_page_metadata metadata
        JOIN official_page_snapshots snapshot
          ON snapshot.id = metadata.snapshot_id
        WHERE snapshot.source_item_id = $1) AS metadata,
       (SELECT count(*)::integer FROM evidence_candidates
        WHERE source_item_id = $1) AS candidates,
       (SELECT count(*)::integer FROM verification_runs verification
        JOIN evidence_acquisition_runs acquisition
          ON acquisition.verification_run_id = verification.id
        WHERE acquisition.source_item_id = $1) AS verifications`,
    [itemId],
  );
  return result.rows[0]!;
}

async function eventCount(newsId: string): Promise<number> {
  const result = await pool.query<{ readonly count: number }>(
    `SELECT count(*)::integer AS count
     FROM audit_events
     WHERE news_id = $1`,
    [newsId],
  );
  return result.rows[0]?.count ?? 0;
}
