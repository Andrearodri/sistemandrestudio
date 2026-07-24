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
  ANDRE_STUDIO_RELEVANCE_POLICY_V1,
  DUPLICATE_CONTENT_FIXTURE,
  OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
  OUT_OF_POSITIONING_FIXTURE,
  calculateFixtureRelevance,
} from "../../content-engine/src/index.ts";
import type { RelevanceFixture } from "../../content-engine/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
  withTransaction,
} from "../../database/src/index.ts";
import {
  EditorialWorkflowService,
  createApprovedWorkflowFixture,
  executeRelevanceWorkflow,
} from "../src/index.ts";
import type {
  ExecuteRelevanceWorkflowInput,
} from "../src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);

let pool: Pool;

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
});

beforeEach(async () => {
  assertSafeTestDatabase(config.database);
  await pool.query(`
    TRUNCATE TABLE
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

describe("relevance workflow with PostgreSQL", () => {
  test("persists the complete relevance result", async () => {
    const { recovered, relevance } = await executeFixture(
      "relevance-complete",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    assert.deepEqual(recovered.relevance, relevance);
  });

  test("recovers the criterion breakdown", async () => {
    const { recovered } = await executeFixture(
      "relevance-breakdown",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    assert.equal(recovered.relevance?.criteria.length, 6);
    assert.equal(
      recovered.relevance?.criteria[0]?.criterion,
      "TOPIC_AFFINITY",
    );
  });

  test("recovers explicit penalties", async () => {
    const { recovered } = await executeFixture(
      "relevance-penalties",
      DUPLICATE_CONTENT_FIXTURE,
    );
    assert.equal(
      recovered.relevance?.penalties.some(
        (penalty) => penalty.code === "PROBABLY_DUPLICATE",
      ),
      true,
    );
  });

  test("preserves policy identity and version", async () => {
    const { recovered } = await executeFixture(
      "relevance-policy",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    assert.equal(recovered.relevance?.policyId, "andre-studio-relevance");
    assert.equal(
      recovered.relevance?.policyVersion,
      "andre-studio-relevance-v1",
    );
  });

  test("keeps the same values after opening a new connection", async () => {
    const id = "relevance-reconnect";
    const { relevance } = await executeFixture(
      id,
      DUPLICATE_CONTENT_FIXTURE,
    );
    const secondPool = createDatabasePool(config);
    try {
      const recovered = await new PostgresEditorialNewsRepository(
        secondPool,
      ).getById(`news-${id}`);
      assert.deepEqual(recovered.relevance, relevance);
    } finally {
      await secondPool.end();
    }
  });

  test("executes scoring through the application service", async () => {
    const service = createService(pool);
    const request = await prepareNormalized(
      service,
      "relevance-application-score",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    const result = await executeRelevanceWorkflow(service, request);
    assert.equal(result.scoring.previousState, "NORMALIZED");
    assert.equal(result.scoring.newState, "SCORED");
    assert.deepEqual(result.scoring.news.relevance, result.relevance);
  });

  test("moves relevant content to pending verification", async () => {
    const { recovered } = await executeFixture(
      "relevance-verification",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    assert.equal(recovered.state, "PENDING_VERIFICATION");
  });

  test("discards irrelevant content", async () => {
    const { recovered } = await executeFixture(
      "relevance-discard",
      OUT_OF_POSITIONING_FIXTURE,
    );
    assert.equal(recovered.state, "DISCARDED_LOW_RELEVANCE");
  });

  test("rolls back a failed relevance update", async () => {
    const { recovered } = await executeFixture(
      "relevance-rollback",
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query(
          `UPDATE editorial_news
           SET relevance = $1::jsonb, relevance_score = $2
           WHERE id = $3`,
          [
            JSON.stringify({
              ...recovered.relevance,
              value: 1,
            }),
            1,
            recovered.id,
          ],
        );
        throw new Error("forced relevance rollback");
      }),
      /forced relevance rollback/,
    );
    const afterFailure = await new PostgresEditorialNewsRepository(
      pool,
    ).getById(recovered.id);
    assert.deepEqual(afterFailure.relevance, recovered.relevance);
  });

  test("preserves idempotency for scoring and routing", async () => {
    const id = "relevance-idempotency";
    const service = createService(pool);
    const request = await prepareNormalized(
      service,
      id,
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    const first = await executeRelevanceWorkflow(service, request);
    const replay = await executeRelevanceWorkflow(service, request);
    const recovered = await new PostgresEditorialNewsRepository(pool).getById(
      `news-${id}`,
    );

    assert.equal(first.scoring.replayed, false);
    assert.equal(replay.scoring.replayed, true);
    assert.equal(replay.routing.replayed, true);
    assert.equal(recovered.auditEvents.length, 3);
  });
});

async function executeFixture(
  id: string,
  fixture: RelevanceFixture,
): Promise<{
  readonly recovered: Awaited<
    ReturnType<PostgresEditorialNewsRepository["getById"]>
  >;
  readonly relevance: ReturnType<typeof calculateFixtureRelevance>;
}> {
  const service = createService(pool);
  const request = await prepareNormalized(service, id, fixture);
  const result = await executeRelevanceWorkflow(service, request);
  const recovered = await new PostgresEditorialNewsRepository(pool).getById(
    request.newsId,
  );
  return { recovered, relevance: result.relevance };
}

async function prepareNormalized(
  service: EditorialWorkflowService,
  id: string,
  fixture: RelevanceFixture,
): Promise<ExecuteRelevanceWorkflowInput> {
  const workflow = createApprovedWorkflowFixture(id);
  if (workflow.receive.command.type !== "ReceiveNews") {
    throw new Error("The fixture must begin with ReceiveNews.");
  }
  await service.execute({
    ...workflow.receive,
    command: {
      ...workflow.receive.command,
      title: fixture.input.title,
      publishedAt: fixture.input.publishedAt,
      eventAt: fixture.input.eventAt ?? fixture.input.publishedAt,
    },
  });
  const normalize = workflow.commands[0];
  assert.ok(normalize);
  await service.execute({
    ...normalize,
    command: {
      type: "NormalizeNews",
      normalizedTitle: fixture.input.title,
      canonicalUrl: `https://relevance-fixture.invalid/${id}`,
    },
  });

  return {
    newsId: workflow.receive.newsId,
    input: fixture.input,
    policy: ANDRE_STUDIO_RELEVANCE_POLICY_V1,
    scoring: {
      commandId: `command-${id}-relevance-score`,
      idempotencyKey: `idempotency-${id}-relevance-score`,
      actor: { id: "actor-relevance-policy", type: "SYSTEM" },
      occurredAt: fixture.input.evaluatedAt,
      expectedVersion: 1,
    },
    routing: {
      commandId: `command-${id}-relevance-route`,
      idempotencyKey: `idempotency-${id}-relevance-route`,
      actor: { id: "actor-relevance-policy", type: "SYSTEM" },
      occurredAt: "2026-07-24T12:01:00.000Z",
    },
  };
}

function createService(targetPool: Pool): EditorialWorkflowService {
  return new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(targetPool),
  );
}
