import assert from "node:assert/strict";
import {
  after,
  before,
  beforeEach,
  describe,
  test,
} from "node:test";

import type { Pool } from "pg";

import type {
  VerificationClaim,
  VerificationEvidence,
} from "../../content-engine/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresVerificationRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../database/src/index.ts";
import {
  EditorialWorkflowService,
  VerificationWorkflowError,
  VerificationWorkflowService,
  createApprovedWorkflowFixture,
} from "../src/index.ts";
import type {
  VerificationWorkflowInput,
} from "../src/index.ts";

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
      verification_claim_results,
      verification_results,
      verification_evidence,
      verification_claims,
      verification_runs,
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

describe("factual verification transaction with PostgreSQL", () => {
  test("persists and recovers claims, evidence, run, result and policy", async () => {
    const input = await pendingInput("complete");
    const service = verificationService(pool);
    const result = await service.evaluate(input);
    const recovered = await new PostgresVerificationRepository(pool)
      .findComplete(input.verificationId);

    assert.equal(result.currentState, "VERIFIED");
    assert.equal(recovered?.claims.length, 1);
    assert.equal(recovered?.evidence.length, 1);
    assert.equal(recovered?.result.status, "CONFIRMED");
    assert.equal(recovered?.result.policyId, "andre-studio-verification");
    assert.equal(
      recovered?.result.policyVersion,
      "andre-studio-verification-v1",
    );
    assert.deepEqual(recovered?.evidence[0]?.structuredFacts, {
      declaredAvailable: true,
    });
  });

  const classifications = [
    {
      status: "CONFIRMED",
      state: "VERIFIED",
      mutate: (input: VerificationWorkflowInput) => input,
    },
    {
      status: "PARTIALLY_CONFIRMED",
      state: "PENDING_VERIFICATION",
      mutate: (input: VerificationWorkflowInput) => ({
        ...input,
        claims: [
          ...input.claims,
          claim(input.newsId, "secondary", "SECONDARY"),
        ],
      }),
    },
    {
      status: "UNCONFIRMED",
      state: "VERIFICATION_REJECTED",
      mutate: (input: VerificationWorkflowInput) => ({
        ...input,
        evidence: input.evidence.map((item) => ({
          ...item,
          sourceAuthority: "UNKNOWN" as const,
        })),
      }),
    },
    {
      status: "CONTRADICTED",
      state: "VERIFICATION_REJECTED",
      mutate: (input: VerificationWorkflowInput) => ({
        ...input,
        evidence: input.evidence.map((item) => ({
          ...item,
          supportsClaim: false,
          contradictsClaim: true,
        })),
      }),
    },
    {
      status: "OUTDATED",
      state: "VERIFICATION_REJECTED",
      mutate: (input: VerificationWorkflowInput) => ({
        ...input,
        evidence: input.evidence.map((item) => ({
          ...item,
          eventDate: "2025-01-01T00:00:00.000Z",
        })),
      }),
    },
    {
      status: "INSUFFICIENT_EVIDENCE",
      state: "VERIFICATION_REJECTED",
      mutate: (input: VerificationWorkflowInput) => ({
        ...input,
        evidence: [],
      }),
    },
  ] as const;

  for (const classification of classifications) {
    test(`persists ${classification.status} with editorial state ${classification.state}`, async () => {
      const base = await pendingInput(
        `status-${classification.status.toLowerCase()}`,
      );
      const result = await verificationService(pool).evaluate(
        classification.mutate(base),
      );
      const news = await new PostgresEditorialNewsRepository(pool)
        .getById(base.newsId);

      assert.equal(result.verificationStatus, classification.status);
      assert.equal(result.currentState, classification.state);
      assert.equal(news.state, classification.state);
      if (classification.status === "PARTIALLY_CONFIRMED") {
        assert.equal(news.auditEvents.length, 3);
      } else {
        assert.equal(news.auditEvents.length, 4);
      }
    });
  }

  test("replays without duplicate rows or editorial events", async () => {
    const input = await pendingInput("replay");
    const service = verificationService(pool);
    const first = await service.evaluate(input);
    const replay = await service.evaluate(input);
    const counts = await verificationCounts(input.newsId);
    const events = await new PostgresEditorialNewsRepository(pool)
      .listAuditEvents(input.newsId);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(counts, {
      runs: 1,
      claims: 1,
      evidence: 1,
      results: 1,
    });
    assert.equal(events.length, 4);
  });

  test("replays after closing and reopening the connection", async () => {
    const input = await pendingInput("reconnect");
    const firstPool = createDatabasePool(config);
    await verificationService(firstPool).evaluate(input);
    await firstPool.end();

    const secondPool = createDatabasePool(config);
    try {
      const replay = await verificationService(secondPool).evaluate(input);
      const recovered = await new PostgresVerificationRepository(secondPool)
        .findByIdempotency(input.idempotencyKey);
      assert.equal(replay.replayed, true);
      assert.equal(recovered?.evidence.length, 1);
      assert.equal(recovered?.currentState, "VERIFIED");
    } finally {
      await secondPool.end();
    }
  });

  test("rejects reuse of a key with different functional content", async () => {
    const input = await pendingInput("idempotency-conflict");
    const service = verificationService(pool);
    await service.evaluate(input);

    await assert.rejects(
      service.evaluate({
        ...input,
        evidence: input.evidence.map((item) => ({
          ...item,
          excerpt: "Different factual input.",
        })),
      }),
      (error) =>
        error instanceof VerificationWorkflowError &&
        error.code === "VERIFICATION_IDEMPOTENCY_CONFLICT",
    );
    assert.deepEqual(await verificationCounts(input.newsId), {
      runs: 1,
      claims: 1,
      evidence: 1,
      results: 1,
    });
  });

  test("rolls back every verification row on a concurrency conflict", async () => {
    const input = await pendingInput("concurrency");
    await assert.rejects(
      verificationService(pool).evaluate({
        ...input,
        expectedVersion: 2,
      }),
      (error) =>
        error instanceof VerificationWorkflowError &&
        error.code === "VERIFICATION_CONCURRENCY_CONFLICT",
    );
    assert.deepEqual(await verificationCounts(input.newsId), {
      runs: 0,
      claims: 0,
      evidence: 0,
      results: 0,
    });
    assert.equal(
      (await new PostgresEditorialNewsRepository(pool).getById(input.newsId))
        .state,
      "PENDING_VERIFICATION",
    );
  });

  test("rolls back rows inserted before an editorial transition failure", async () => {
    const input = await pendingInput("rollback-transition");
    await assert.rejects(
      verificationService(pool).evaluate({
        ...input,
        commandId: `command-rollback-transition-03`,
      }),
    );
    assert.deepEqual(await verificationCounts(input.newsId), {
      runs: 0,
      claims: 0,
      evidence: 0,
      results: 0,
    });
    const news = await new PostgresEditorialNewsRepository(pool)
      .getById(input.newsId);
    assert.equal(news.state, "PENDING_VERIFICATION");
    assert.equal(news.auditEvents.length, 3);
  });

  test("preserves prior editorial history when verification succeeds", async () => {
    const input = await pendingInput("history");
    const before = await new PostgresEditorialNewsRepository(pool)
      .listAuditEvents(input.newsId);
    await verificationService(pool).evaluate(input);
    const after = await new PostgresEditorialNewsRepository(pool)
      .listAuditEvents(input.newsId);

    assert.deepEqual(after.slice(0, 3), before);
    assert.equal(after[3]?.action, "ApproveVerification");
  });

  test("recovers claims and evidence in deterministic input order", async () => {
    const input = await pendingInput("order");
    const secondClaim = claim(input.newsId, "secondary", "SECONDARY");
    await verificationService(pool).evaluate({
      ...input,
      claims: [...input.claims, secondClaim],
      evidence: [
        ...input.evidence,
        {
          ...evidence(input.newsId),
          id: `${input.newsId}-evidence-secondary`,
          claimId: secondClaim.id,
          sourceAuthority: "OFFICIAL_DOCUMENTATION",
        },
      ],
    });
    const recovered = await new PostgresVerificationRepository(pool)
      .findComplete(input.verificationId);
    assert.deepEqual(
      recovered?.claims.map((item) => item.id),
      input.claims.map((item) => item.id).concat(secondClaim.id),
    );
    assert.equal(recovered?.evidence[1]?.claimId, secondClaim.id);
  });

  test("closes the persisted run with expected version and states", async () => {
    const input = await pendingInput("run-closed");
    await verificationService(pool).evaluate(input);
    const run = await pool.query<{
      readonly status: string;
      readonly expected_version: number;
      readonly previous_state: string;
      readonly current_state: string;
      readonly finished_at: Date | null;
    }>("SELECT * FROM verification_runs WHERE id = $1", [
      input.verificationId,
    ]);
    assert.deepEqual(
      {
        status: run.rows[0]?.status,
        expectedVersion: run.rows[0]?.expected_version,
        previousState: run.rows[0]?.previous_state,
        currentState: run.rows[0]?.current_state,
        finished: run.rows[0]?.finished_at instanceof Date,
      },
      {
        status: "SUCCEEDED",
        expectedVersion: 3,
        previousState: "PENDING_VERIFICATION",
        currentState: "VERIFIED",
        finished: true,
      },
    );
  });

  test("persists the individual claim result", async () => {
    const input = await pendingInput("claim-result");
    await verificationService(pool).evaluate(input);
    const result = await pool.query<{
      readonly status: string;
      readonly confidence: number;
    }>(
      `SELECT status, confidence
       FROM verification_claim_results
       WHERE result_id = $1`,
      [input.verificationId],
    );
    assert.deepEqual(result.rows, [{ status: "SUPPORTED", confidence: 100 }]);
  });

  test("replays partial verification without an editorial event", async () => {
    const base = await pendingInput("partial-replay");
    const input = {
      ...base,
      claims: [
        ...base.claims,
        claim(base.newsId, "secondary", "SECONDARY"),
      ],
    };
    await verificationService(pool).evaluate(input);
    const replay = await verificationService(pool).evaluate(input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.currentState, "PENDING_VERIFICATION");
    assert.equal(
      (await new PostgresEditorialNewsRepository(pool)
        .listAuditEvents(input.newsId)).length,
      3,
    );
  });

  test("blocked verification never creates a draft", async () => {
    const input = await pendingInput("blocked-no-draft");
    await verificationService(pool).evaluate({ ...input, evidence: [] });
    const drafts = await pool.query(
      "SELECT id FROM draft_versions WHERE news_id = $1",
      [input.newsId],
    );
    assert.equal(drafts.rowCount, 0);
  });

  test("confirmed result preserves a VERIFIED editorial result", async () => {
    const input = await pendingInput("legacy-verified");
    await verificationService(pool).evaluate(input);
    const news = await new PostgresEditorialNewsRepository(pool)
      .getById(input.newsId);
    assert.equal(news.verification?.outcome, "VERIFIED");
    assert.equal(news.verification?.policyVersion, "andre-studio-verification-v1");
  });

  test("blocked result preserves a REJECTED editorial result", async () => {
    const input = await pendingInput("legacy-rejected");
    await verificationService(pool).evaluate({ ...input, evidence: [] });
    const news = await new PostgresEditorialNewsRepository(pool)
      .getById(input.newsId);
    assert.equal(news.verification?.outcome, "REJECTED");
  });

  test("allows only one simultaneous verification at the same version", async () => {
    const first = await pendingInput("simultaneous");
    const second = attemptWithSuffix(first, "second");
    const settled = await Promise.allSettled([
      verificationService(pool).evaluate(first),
      verificationService(pool).evaluate(second),
    ]);
    assert.equal(
      settled.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(
      settled.some((item) =>
        item.status === "rejected" &&
        item.reason instanceof VerificationWorkflowError &&
        item.reason.code === "VERIFICATION_CONCURRENCY_CONFLICT"
      ),
      true,
    );
  });

  test("preserves multiple partial verification attempts as history", async () => {
    const firstBase = await pendingInput("partial-history");
    const first = {
      ...firstBase,
      claims: [
        ...firstBase.claims,
        claim(firstBase.newsId, "secondary", "SECONDARY"),
      ],
    };
    const secondBase = attemptWithSuffix(firstBase, "second");
    const second = {
      ...secondBase,
      claims: [
        ...secondBase.claims,
        claim(secondBase.newsId, "secondary-second", "SECONDARY"),
      ],
    };
    await verificationService(pool).evaluate(first);
    await verificationService(pool).evaluate(second);
    const counts = await verificationCounts(first.newsId);
    assert.equal(counts?.runs, 2);
    assert.equal(counts?.results, 2);
  });

  test("stores a canonical SHA-256 fingerprint", async () => {
    const input = await pendingInput("fingerprint");
    await verificationService(pool).evaluate(input);
    const recovered = await new PostgresVerificationRepository(pool)
      .findComplete(input.verificationId);
    assert.match(recovered?.fingerprint ?? "", /^[a-f0-9]{64}$/);
  });

  test("rejects a new verification after the news already left pending", async () => {
    const input = await pendingInput("invalid-state");
    await verificationService(pool).evaluate(input);
    await assert.rejects(
      verificationService(pool).evaluate({
        ...attemptWithSuffix(input, "second"),
        expectedVersion: 4,
      }),
      (error) =>
        error instanceof VerificationWorkflowError &&
        error.code === "VERIFICATION_INVALID_EDITORIAL_STATE",
    );
    assert.equal((await verificationCounts(input.newsId))?.runs, 1);
  });

  test("does not persist verification data for a missing news item", async () => {
    const input = await pendingInput("missing-news-base");
    const missing = {
      ...attemptWithSuffix(input, "missing"),
      newsId: "news-does-not-exist",
    };
    await assert.rejects(
      verificationService(pool).evaluate(missing),
      (error) =>
        error instanceof VerificationWorkflowError &&
        error.code === "VERIFICATION_NEWS_NOT_FOUND",
    );
    assert.equal((await verificationCounts(missing.newsId))?.runs, 0);
  });
});

async function pendingInput(id: string): Promise<VerificationWorkflowInput> {
  const fixture = createApprovedWorkflowFixture(id);
  const editorial = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(pool),
  );
  await editorial.execute(fixture.receive);
  for (const envelope of fixture.commands.slice(0, 3)) {
    await editorial.execute(envelope);
  }
  return {
    newsId: fixture.receive.newsId,
    verificationId: `verification-${id}`,
    commandId: `verification-command-${id}`,
    idempotencyKey: `verification-key-${id}`,
    expectedVersion: 3,
    actor: { type: "SYSTEM", id: "factual-verification" },
    occurredAt: "2026-07-24T12:00:00.000Z",
    claims: [claim(fixture.receive.newsId, "primary", "PRIMARY")],
    evidence: [evidence(fixture.receive.newsId)],
    allowedSourceIds: ["fictional-primary"],
    allowedSources: [{
      id: "fictional-primary",
      allowedHosts: ["example.invalid"],
    }],
  };
}

function claim(
  newsId: string,
  suffix: string,
  importance: "PRIMARY" | "SECONDARY",
): VerificationClaim {
  return {
    id: `${newsId}-claim-${suffix}`,
    text: suffix === "primary"
      ? "A fictitious product became available."
      : "A secondary performance statement.",
    type: suffix === "primary" ? "PRODUCT_LAUNCH" : "PERFORMANCE_CLAIM",
    importance,
  };
}

function evidence(newsId: string): VerificationEvidence {
  return {
    id: `${newsId}-evidence-primary`,
    claimId: `${newsId}-claim-primary`,
    sourceId: "fictional-primary",
    canonicalUrl: "https://example.invalid/releases/factual-test",
    sourceAuthority: "PRIMARY_OFFICIAL",
    evidenceType: "RELEASE_NOTE",
    publishedAt: "2026-07-24T10:00:00.000Z",
    eventDate: "2026-07-24T10:00:00.000Z",
    retrievedAt: "2026-07-24T12:00:00.000Z",
    excerpt: "Fictitious bounded evidence.",
    structuredFacts: { declaredAvailable: true },
    supportsClaim: true,
    contradictsClaim: false,
  };
}

function verificationService(targetPool: Pool): VerificationWorkflowService {
  return new VerificationWorkflowService(
    new PostgresVerificationRepository(targetPool),
  );
}

function attemptWithSuffix(
  input: VerificationWorkflowInput,
  suffix: string,
): VerificationWorkflowInput {
  const claimId = `${input.newsId}-claim-primary-${suffix}`;
  return {
    ...input,
    verificationId: `${input.verificationId}-${suffix}`,
    commandId: `${input.commandId}-${suffix}`,
    idempotencyKey: `${input.idempotencyKey}-${suffix}`,
    claims: input.claims.map((item) => ({ ...item, id: claimId })),
    evidence: input.evidence.map((item) => ({
      ...item,
      id: `${item.id}-${suffix}`,
      claimId,
    })),
  };
}

async function verificationCounts(newsId: string) {
  const result = await pool.query<{
    readonly runs: number;
    readonly claims: number;
    readonly evidence: number;
    readonly results: number;
  }>(
    `SELECT
       (SELECT count(*)::integer FROM verification_runs WHERE news_id = $1)
         AS runs,
       (SELECT count(*)::integer FROM verification_claims WHERE news_id = $1)
         AS claims,
       (
         SELECT count(*)::integer
         FROM verification_evidence evidence
         JOIN verification_claims claim ON claim.id = evidence.claim_id
         WHERE claim.news_id = $1
       ) AS evidence,
       (SELECT count(*)::integer FROM verification_results WHERE news_id = $1)
         AS results`,
    [newsId],
  );
  return result.rows[0];
}
