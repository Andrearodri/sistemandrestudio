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
  APPROVED_SCENARIO,
  CHANGES_REQUESTED_SCENARIO,
  IDEMPOTENCY_SCENARIO,
  VERIFIED_RESULT,
  ConcurrentUpdateError,
  transition,
} from "../../content-engine/src/index.ts";
import type {
  EditorialNews,
  EditorialScenario,
  ScenarioStep,
} from "../../content-engine/src/index.ts";
import {
  PersistenceIdempotencyConflictError,
  PostgresEditorialNewsRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
  withTransaction,
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

describe("PostgresEditorialNewsRepository", () => {
  test("saves and recovers an editorial news item", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await repository.save(APPROVED_SCENARIO.initialNews, 0);

    const recovered = await repository.getById(
      APPROVED_SCENARIO.initialNews.id,
    );
    assert.deepEqual(recovered, APPROVED_SCENARIO.initialNews);
  });

  test("preserves the current state", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistSteps(
      repository,
      APPROVED_SCENARIO,
      APPROVED_SCENARIO.steps.slice(0, 4),
    );

    const recovered = await repository.getById(entity.id);
    assert.equal(recovered.state, "VERIFIED");
    assert.deepEqual(recovered.verification, VERIFIED_RESULT);
  });

  test("stores multiple immutable draft versions", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistScenario(
      repository,
      CHANGES_REQUESTED_SCENARIO,
    );

    const recovered = await repository.getById(entity.id);
    assert.equal(recovered.draftVersions.length, 2);
    assert.equal(
      recovered.draftVersions[1]?.basedOnVersionId,
      "draft-changes-requested-v1",
    );
  });

  test("database constraint prevents duplicate version numbers", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistSteps(
      repository,
      APPROVED_SCENARIO,
      APPROVED_SCENARIO.steps.slice(0, 5),
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO draft_versions (
           id, news_id, version_number, body, actor_type,
           actor_id, based_on_version_id, created_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "draft-duplicate-number",
          entity.id,
          1,
          "Versão fictícia conflitante.",
          "HUMAN",
          "actor-human-fixture",
          null,
          "2026-01-15T12:00:00.000Z",
        ],
      ),
      isPostgresCode("23505"),
    );
  });

  test("records the complete audit history", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistScenario(repository, APPROVED_SCENARIO);

    const events = await repository.listAuditEvents(entity.id);
    assert.equal(events.length, APPROVED_SCENARIO.steps.length);
    assert.deepEqual(events, entity.auditEvents);
  });

  test("returns audit events in deterministic order", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistScenario(repository, APPROVED_SCENARIO);

    const events = await repository.listAuditEvents(entity.id);
    assert.deepEqual(
      events.map((event) => event.id),
      APPROVED_SCENARIO.steps.map((step) => step.context.eventId),
    );
  });

  test("persists the human decision and approved version", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const entity = await persistScenario(repository, APPROVED_SCENARIO);

    const recovered = await repository.getById(entity.id);
    assert.equal(recovered.decisions.length, 1);
    assert.equal(recovered.decisions[0]?.type, "APPROVE");
    assert.equal(
      recovered.decisions[0]?.contentVersionId,
      recovered.currentDraftVersionId,
    );
  });

  test("keeps idempotency after a new repository instance", async () => {
    const firstRepository = new PostgresEditorialNewsRepository(pool);
    const approved = await persistSteps(
      firstRepository,
      IDEMPOTENCY_SCENARIO,
      IDEMPOTENCY_SCENARIO.steps.slice(0, 7),
    );

    const secondRepository = new PostgresEditorialNewsRepository(pool);
    const recovered = await secondRepository.getById(approved.id);
    const replayStep = IDEMPOTENCY_SCENARIO.steps[7];
    assert.ok(replayStep);
    const replay = transition(
      recovered,
      replayStep.command,
      replayStep.context,
    );

    assert.equal(replay.replayed, true);
    assert.equal(replay.event, null);
    assert.equal(replay.entity.decisions.length, 1);
    assert.ok(
      await secondRepository.findProcessedCommand(
        "idempotency-replayed-approval",
      ),
    );
  });

  test("rejects a conflicting persistent idempotency key", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await persistSteps(
      repository,
      IDEMPOTENCY_SCENARIO,
      IDEMPOTENCY_SCENARIO.steps.slice(0, 7),
    );

    const conflicting: EditorialNews = {
      ...APPROVED_SCENARIO.initialNews,
      id: "news-persistent-idempotency-conflict",
      processedCommands: [
        {
          commandType: "ApproveDraft",
          fingerprint: "different-fingerprint",
          idempotencyKey: "idempotency-replayed-approval",
        },
      ],
    };

    await assert.rejects(
      repository.save(conflicting, 0),
      (error: unknown) =>
        error instanceof PersistenceIdempotencyConflictError &&
        error.code === "PERSISTENCE_IDEMPOTENCY_CONFLICT",
    );
  });

  test("rejects an update made with a stale concurrency version", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await repository.save(APPROVED_SCENARIO.initialNews, 0);

    const firstCopy = await repository.getById(
      APPROVED_SCENARIO.initialNews.id,
    );
    const secondCopy = await repository.getById(
      APPROVED_SCENARIO.initialNews.id,
    );
    const firstStep = APPROVED_SCENARIO.steps[0];
    assert.ok(firstStep);

    const firstUpdate = transition(
      firstCopy,
      firstStep.command,
      firstStep.context,
    );
    await repository.save(firstUpdate.entity, 0);

    const secondUpdate = transition(
      secondCopy,
      {
        type: "NormalizeNews",
        normalizedTitle: "Título fictício concorrente.",
        canonicalUrl: "https://example.test/noticias/ia-local",
      },
      {
        ...firstStep.context,
        eventId: "event-concurrent-copy",
      },
    );

    await assert.rejects(
      repository.save(secondUpdate.entity, 0),
      (error: unknown) =>
        error instanceof ConcurrentUpdateError &&
        error.code === "CONCURRENT_UPDATE",
    );
  });

  test("commits all statements in a successful transaction", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await repository.save(APPROVED_SCENARIO.initialNews, 0);

    await withTransaction(pool, async (client) => {
      await client.query(
        "UPDATE editorial_news SET title = $1 WHERE id = $2",
        ["Título transacional fictício.", APPROVED_SCENARIO.initialNews.id],
      );
      await client.query(
        "UPDATE editorial_news SET base_content = $1 WHERE id = $2",
        ["Conteúdo-base transacional.", APPROVED_SCENARIO.initialNews.id],
      );
    });

    const result = await pool.query<{ readonly title: string }>(
      "SELECT title FROM editorial_news WHERE id = $1",
      [APPROVED_SCENARIO.initialNews.id],
    );
    assert.equal(result.rows[0]?.title, "Título transacional fictício.");
  });

  test("rolls back every statement when a transaction fails", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await repository.save(APPROVED_SCENARIO.initialNews, 0);
    const originalTitle = APPROVED_SCENARIO.initialNews.title;

    await assert.rejects(
      withTransaction(pool, async (client) => {
        await client.query(
          "UPDATE editorial_news SET title = $1 WHERE id = $2",
          ["Título que deve sofrer rollback.", APPROVED_SCENARIO.initialNews.id],
        );
        throw new Error("forced rollback");
      }),
      /forced rollback/,
    );

    const result = await pool.query<{ readonly title: string }>(
      "SELECT title FROM editorial_news WHERE id = $1",
      [APPROVED_SCENARIO.initialNews.id],
    );
    assert.equal(result.rows[0]?.title, originalTitle);
  });

  test("prevents ready state without a persisted approval", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    await repository.save(APPROVED_SCENARIO.initialNews, 0);

    await assert.rejects(
      pool.query(
        "UPDATE editorial_news SET state = 'READY_FOR_PUBLICATION' WHERE id = $1",
        [APPROVED_SCENARIO.initialNews.id],
      ),
      isPostgresCode("23514"),
    );
  });

  test("recovers the aggregate after opening a new connection", async () => {
    const repository = new PostgresEditorialNewsRepository(pool);
    const completed = await persistScenario(repository, APPROVED_SCENARIO);

    const secondPool = createDatabasePool(config);
    try {
      const restartedRepository = new PostgresEditorialNewsRepository(
        secondPool,
      );
      const recovered = await restartedRepository.getById(completed.id);
      assert.deepEqual(recovered, completed);
    } finally {
      await secondPool.end();
    }
  });
});

async function persistScenario(
  repository: PostgresEditorialNewsRepository,
  scenario: EditorialScenario,
): Promise<EditorialNews> {
  return persistSteps(repository, scenario, scenario.steps);
}

async function persistSteps(
  repository: PostgresEditorialNewsRepository,
  scenario: EditorialScenario,
  steps: readonly ScenarioStep[],
): Promise<EditorialNews> {
  let entity = scenario.initialNews;
  await repository.save(entity, 0);

  for (const step of steps) {
    const result = transition(entity, step.command, step.context);
    await repository.save(result.entity, entity.auditEvents.length);
    entity = result.entity;
  }

  return entity;
}

function isPostgresCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}
