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
  ConcurrencyConflictError,
  EditorialWorkflowService,
  IdempotencyConflictError,
  createApprovedWorkflowFixture,
} from "../src/index.ts";
import type { EditorialCommandEnvelope } from "../src/index.ts";
import {
  PostgresEditorialNewsRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../database/src/index.ts";

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

describe("EditorialWorkflowService with PostgreSQL", () => {
  test("executes the complete flow through the service", async () => {
    const fixture = createApprovedWorkflowFixture("integration-flow");
    const service = createService(pool);
    const result = await executeAll(service, fixture);

    assert.equal(result.newState, "READY_FOR_PUBLICATION");
    assert.equal(result.currentVersion, 8);
    assert.equal(result.news.decisions.length, 1);
  });

  test("recovers the aggregate after closing and reopening a connection", async () => {
    const fixture = createApprovedWorkflowFixture("integration-reconnect");
    const firstPool = createDatabasePool(config);
    await createService(firstPool).execute(fixture.receive);
    await createService(firstPool).execute(requiredCommand(fixture, 0));
    await firstPool.end();

    const secondPool = createDatabasePool(config);
    try {
      const recovered = await new PostgresEditorialNewsRepository(
        secondPool,
      ).getById(fixture.receive.newsId);
      assert.equal(recovered.state, "NORMALIZED");
      assert.equal(recovered.auditEvents.length, 1);
    } finally {
      await secondPool.end();
    }
  });

  test("replays the same command after reconnecting", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-replay-reconnect",
    );
    const firstPool = createDatabasePool(config);
    await executeAll(createService(firstPool), fixture);
    await firstPool.end();

    const secondPool = createDatabasePool(config);
    try {
      const replay = await createService(secondPool).execute(
        requiredCommand(fixture, 7),
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.newState, "READY_FOR_PUBLICATION");
    } finally {
      await secondPool.end();
    }
  });

  test("does not persist another event during replay", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-replay-events",
    );
    const service = createService(pool);
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    await service.execute(normalize);
    const replay = await service.execute(normalize);
    const repository = new PostgresEditorialNewsRepository(pool);
    const events = await repository.listAuditEvents(fixture.receive.newsId);

    assert.equal(replay.replayed, true);
    assert.equal(replay.events.length, 0);
    assert.equal(events.length, 1);
  });

  test("rejects the same key with different content", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-idempotency-conflict",
    );
    const service = createService(pool);
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    await service.execute(normalize);
    const conflicting: EditorialCommandEnvelope = {
      ...normalize,
      command: {
        type: "NormalizeNews",
        normalizedTitle: "Conteúdo conflitante fictício.",
        canonicalUrl:
          "https://source-alpha.invalid/canonical/conflitante",
      },
    };

    await assert.rejects(
      service.execute(conflicting),
      (error: unknown) =>
        error instanceof IdempotencyConflictError &&
        error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  test("allows only one of two commands with the same expected version", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-concurrent-results",
    );
    const service = createService(pool);
    await service.execute(fixture.receive);
    const [first, second] = concurrentNormalizeCommands(fixture);
    const results = await Promise.allSettled([
      service.execute(first),
      service.execute(second),
    ]);

    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof ConcurrencyConflictError);
  });

  test("persists only the accepted concurrent command", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-concurrent-state",
    );
    const service = createService(pool);
    await service.execute(fixture.receive);
    const [first, second] = concurrentNormalizeCommands(fixture);
    await Promise.allSettled([
      service.execute(first),
      service.execute(second),
    ]);

    const recovered = await new PostgresEditorialNewsRepository(pool).getById(
      fixture.receive.newsId,
    );
    assert.equal(recovered.state, "NORMALIZED");
    assert.equal(recovered.auditEvents.length, 1);
    assert.equal(recovered.processedCommands.length, 2);
  });

  test("rolls back every effect of a stale command", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-total-rollback",
    );
    const service = createService(pool);
    await service.execute(fixture.receive);
    for (const envelope of fixture.commands.slice(0, 4)) {
      await service.execute(envelope);
    }

    const firstDraft = requiredCommand(fixture, 4);
    const staleDraft: EditorialCommandEnvelope = {
      ...firstDraft,
      commandId: "command-integration-total-rollback-stale",
      idempotencyKey: "idempotency-integration-total-rollback-stale",
      command: {
        type: "CreateDraft",
        draftVersionId: "draft-integration-total-rollback-stale",
        body: "Rascunho concorrente que não deve persistir.",
      },
    };
    await service.execute(firstDraft);

    await assert.rejects(
      service.execute(staleDraft),
      (error: unknown) =>
        error instanceof ConcurrencyConflictError &&
        error.code === "CONCURRENCY_CONFLICT",
    );

    const recovered = await new PostgresEditorialNewsRepository(pool).getById(
      fixture.receive.newsId,
    );
    assert.equal(recovered.draftVersions.length, 1);
    assert.equal(recovered.auditEvents.length, 5);
    assert.equal(
      recovered.processedCommands.some(
        (command) =>
          command.idempotencyKey === staleDraft.idempotencyKey,
      ),
      false,
    );
  });

  test("recovers the persisted command result", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-persisted-result",
    );
    const firstService = createService(pool);
    await firstService.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    await firstService.execute(normalize);

    const secondPool = createDatabasePool(config);
    try {
      const replay = await createService(secondPool).execute(normalize);
      assert.equal(replay.replayed, true);
      assert.equal(replay.previousState, "RECEIVED");
      assert.equal(replay.newState, "NORMALIZED");
      assert.equal(replay.currentVersion, 1);
    } finally {
      await secondPool.end();
    }
  });

  test("confirms final state and complete history", async () => {
    const fixture = createApprovedWorkflowFixture(
      "integration-final-history",
    );
    const service = createService(pool);
    await executeAll(service, fixture);
    const repository = new PostgresEditorialNewsRepository(pool);
    const recovered = await repository.getById(fixture.receive.newsId);
    const events = await repository.listAuditEvents(fixture.receive.newsId);

    assert.equal(recovered.state, "READY_FOR_PUBLICATION");
    assert.equal(events.length, 8);
    assert.deepEqual(
      events.map((event) => event.id),
      fixture.commands.map((envelope) => envelope.commandId),
    );
  });
});

function createService(targetPool: Pool): EditorialWorkflowService {
  return new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(targetPool),
  );
}

async function executeAll(
  service: EditorialWorkflowService,
  fixture: ReturnType<typeof createApprovedWorkflowFixture>,
) {
  await service.execute(fixture.receive);
  let result = await service.execute(requiredCommand(fixture, 0));
  for (const envelope of fixture.commands.slice(1)) {
    result = await service.execute(envelope);
  }
  return result;
}

function requiredCommand(
  fixture: ReturnType<typeof createApprovedWorkflowFixture>,
  index: number,
): EditorialCommandEnvelope {
  const envelope = fixture.commands[index];
  assert.ok(envelope);
  return envelope;
}

function concurrentNormalizeCommands(
  fixture: ReturnType<typeof createApprovedWorkflowFixture>,
): readonly [EditorialCommandEnvelope, EditorialCommandEnvelope] {
  const first = requiredCommand(fixture, 0);
  return [
    first,
    {
      ...first,
      commandId: `${first.commandId}-second`,
      idempotencyKey: `${first.idempotencyKey}-second`,
      command: {
        type: "NormalizeNews",
        normalizedTitle: "Segunda normalização concorrente.",
        canonicalUrl:
          "https://source-alpha.invalid/canonical/concorrente",
      },
    },
  ];
}
