import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";

import {
  EditorialOrchestrationError,
  EditorialOrchestrationService,
  FixtureEditorialOrchestrationPipeline,
  InMemoryHumanDecisionChannel,
  InMemoryHumanEditorialDecisionExecutor,
  type EditorialOrchestrationEvent,
} from "../src/index.ts";
import {
  PostgresEditorialOrchestrationRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../database/src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
const at = "2026-07-29T11:00:00.000Z";
let pool: Pool;

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE
    editorial_orchestration_events,
    editorial_orchestration_attempts,
    editorial_human_decisions,
    editorial_human_decision_requests,
    editorial_orchestration_steps,
    editorial_orchestration_runs CASCADE`);
});

after(async () => {
  await pool.end();
});

describe("editorial orchestration with PostgreSQL", () => {
  test("persists a run and all ordered steps", async () => {
    const fixture = createFixture("persist-run");
    const started = await fixture.service.startScheduledRun(fixture.trigger);
    assert.equal(await count("editorial_orchestration_runs"), 1);
    assert.equal(await count("editorial_orchestration_steps"), 8);
    assert.deepEqual(
      started.run.steps.map((step) => step.position),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
  });

  test("persists one bounded human decision request", async () => {
    const fixture = createFixture("persist-request");
    await fixture.service.startScheduledRun(fixture.trigger);
    assert.equal(await count("editorial_human_decision_requests"), 1);
    const size = await pool.query<{ readonly size: number }>(
      `SELECT octet_length(context::text) size
       FROM editorial_human_decision_requests`,
    );
    assert.ok(Number(size.rows[0]?.size) < 16_000);
  });

  test("persists one final human decision", async () => {
    const fixture = createFixture("persist-decision");
    await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await approve(fixture.service, request.id, "persist-decision-key");
    assert.equal(await count("editorial_human_decisions"), 1);
    assert.equal(
      (await fixture.repository.getDecisionByRequest(request.id))?.decision,
      "APPROVE",
    );
  });

  test("recovers a waiting run after reconnecting", async () => {
    const fixture = createFixture("reconnect");
    const started = await fixture.service.startScheduledRun(fixture.trigger);
    await pool.end();
    pool = createDatabasePool(config);
    const recovered = await new PostgresEditorialOrchestrationRepository(pool)
      .getRun(started.run.id);
    assert.equal(recovered?.status, "WAITING_HUMAN_DECISION");
    assert.equal(recovered?.steps.length, 8);
  });

  test("registers approval and resumes after reconnecting", async () => {
    const fixture = createFixture("resume-reconnect");
    const started = await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await pool.end();
    pool = createDatabasePool(config);
    const resumed = createFixture("resume-reconnect");
    await approve(resumed.service, request.id, "resume-reconnect-key");
    assert.equal(
      (await resumed.service.resumeRun(started.run.id)).status,
      "COMPLETED",
    );
  });

  test("replays a run after reconnecting without duplicate rows", async () => {
    const fixture = createFixture("replay-reconnect");
    const first = await fixture.service.startScheduledRun(fixture.trigger);
    await pool.end();
    pool = createDatabasePool(config);
    const replayFixture = createFixture("replay-reconnect");
    const replay = await replayFixture.service.startScheduledRun(
      replayFixture.trigger,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.run.id, first.run.id);
    assert.equal(await count("editorial_orchestration_runs"), 1);
    assert.equal(await count("editorial_human_decision_requests"), 1);
  });

  test("serializes concurrent creation for one trigger key", async () => {
    const left = createFixture("concurrent-run");
    const right = createFixture("concurrent-run");
    const results = await Promise.all([
      left.service.startScheduledRun(left.trigger),
      right.service.startScheduledRun(right.trigger),
    ]);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(await count("editorial_orchestration_runs"), 1);
    assert.equal(await count("editorial_human_decision_requests"), 1);
  });

  test("rejects an incompatible concurrent trigger identity", async () => {
    const fixture = createFixture("trigger-conflict");
    await fixture.service.startScheduledRun(fixture.trigger);
    await assert.rejects(
      fixture.service.startScheduledRun({
        ...fixture.trigger,
        triggerType: "N8N_RETRY",
      }),
      code("EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(await count("editorial_orchestration_runs"), 1);
  });

  test("serializes concurrent identical human decisions", async () => {
    const fixture = createFixture("concurrent-decision");
    await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    const results = await Promise.all([
      approve(fixture.service, request.id, "same-decision"),
      approve(fixture.service, request.id, "same-decision"),
    ]);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(await count("editorial_human_decisions"), 1);
  });

  test("rejects a conflicting final decision", async () => {
    const fixture = createFixture("decision-conflict");
    await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await approve(fixture.service, request.id, "approve-first");
    await assert.rejects(
      fixture.service.registerHumanDecision({
        requestId: request.id,
        reviewerId: "andre-local",
        decision: "REJECT",
        reason: "Conflito intencional de teste.",
        receivedAt: at,
        idempotencyKey: "reject-second",
      }),
      code("EDITORIAL_ORCHESTRATION_DECISION_CONFLICT"),
    );
    assert.equal(await count("editorial_human_decisions"), 1);
  });

  test("rolls back a decision when its event cannot be persisted", async () => {
    const fixture = createFixture("decision-rollback");
    await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    const decision = {
      id: "human-decision-rollback",
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "APPROVE" as const,
      receivedAt: at,
      functionalFingerprint: "a".repeat(64),
    };
    const invalidEvent: EditorialOrchestrationEvent = {
      id: "invalid-event-reference",
      runId: request.runId,
      stepId: "missing-step",
      requestId: request.id,
      eventType: "HUMAN_DECISION_RECEIVED",
      metadata: {},
      occurredAt: at,
    };
    await assert.rejects(
      fixture.repository.registerDecision({
        requestId: request.id,
        decision,
        event: invalidEvent,
      }),
    );
    assert.equal(await count("editorial_human_decisions"), 0);
    assert.equal(
      (await fixture.repository.getDecisionRequest(request.id))?.status,
      "DELIVERED",
    );
  });

  test("a failed step leaves no downstream decision state", async () => {
    const fixture = createFixture(
      "failure-no-partial",
      new FixtureEditorialOrchestrationPipeline({
        failure: {
          step: "FACTUAL_VERIFICATION",
          code: "FACTUAL_VERIFICATION_INSUFFICIENT_EVIDENCE",
        },
      }),
    );
    await assert.rejects(fixture.service.startScheduledRun(fixture.trigger));
    assert.equal(await count("editorial_human_decision_requests"), 0);
    assert.equal(await count("editorial_human_decisions"), 0);
    assert.equal(
      (await fixture.service.listRuns())[0]?.status,
      "FAILED",
    );
  });

  test("enforces one request for each draft version", async () => {
    const first = createFixture("one-request-first");
    await first.service.startScheduledRun(first.trigger);
    const second = createFixture("one-request-second");
    await assert.rejects(
      second.service.startScheduledRun(second.trigger),
      code("EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(await count("editorial_human_decision_requests"), 1);
  });

  test("records required events once per transition", async () => {
    const fixture = createFixture("events");
    const started = await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await approve(fixture.service, request.id, "events-approval");
    await fixture.service.resumeRun(started.run.id);
    const events = await fixture.repository.listEvents(started.run.id);
    assert.equal(
      events.filter((event) => event.eventType === "HUMAN_DECISION_RECEIVED")
        .length,
      1,
    );
    assert.equal(
      events.filter((event) =>
        event.eventType === "EDITORIAL_ORCHESTRATION_COMPLETED"
      ).length,
      1,
    );
  });

  test("cancels a run and its pending request atomically", async () => {
    const fixture = createFixture("cancel");
    const started = await fixture.service.startScheduledRun(fixture.trigger);
    await fixture.service.cancelRun({
      runId: started.run.id,
      operator: "andre-local",
      reason: "Cancelamento controlado.",
    });
    assert.equal(
      (await fixture.service.getRun(started.run.id)).status,
      "CANCELLED",
    );
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
  });

  test("expires a request without creating a decision", async () => {
    let now = at;
    const fixture = createFixture("expire", undefined, () => now);
    await fixture.service.startScheduledRun(fixture.trigger);
    now = "2026-07-31T12:00:00.000Z";
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
    assert.equal(await count("editorial_human_decisions"), 0);
  });

  test("persists attempts without raw content or credentials", async () => {
    const fixture = createFixture("attempts");
    await fixture.service.startScheduledRun(fixture.trigger);
    assert.equal(await count("editorial_orchestration_attempts"), 6);
    const text = await pool.query<{ readonly value: string }>(
      `SELECT COALESCE(string_agg(row_to_json(a)::text, ''), '') value
       FROM editorial_orchestration_attempts a`,
    );
    assert.doesNotMatch(text.rows[0]?.value ?? "", /token|password|BEGIN PRIVATE/i);
  });

  test("database blocks REQUEST_CHANGES without instructions", async () => {
    const fixture = createFixture("changes-constraint");
    await fixture.service.startScheduledRun(fixture.trigger);
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await assert.rejects(
      pool.query(
        `INSERT INTO editorial_human_decisions(
          id, request_id, reviewer_id, decision, reason,
          change_instructions, received_at, functional_fingerprint
        ) VALUES($1,$2,$3,'REQUEST_CHANGES',$4,NULL,$5,$6)`,
        [
          "invalid-changes-decision",
          request.id,
          "andre-local",
          "Alteração sem instruções.",
          at,
          "f".repeat(64),
        ],
      ),
    );
    assert.equal(await count("editorial_human_decisions"), 0);
  });
});

function createFixture(
  suffix: string,
  pipeline = new FixtureEditorialOrchestrationPipeline(),
  clock: () => string = () => at,
) {
  const repository = new PostgresEditorialOrchestrationRepository(pool);
  const service = new EditorialOrchestrationService({
    repository,
    pipeline,
    channel: new InMemoryHumanDecisionChannel(clock),
    decisionExecutor: new InMemoryHumanEditorialDecisionExecutor(),
    clock,
  });
  return {
    repository,
    service,
    trigger: {
      triggerType: "N8N_SCHEDULED" as const,
      triggerKey: `editorial-run:2026-07-29:${suffix}`,
      triggeredBy: "postgres-test",
    },
  };
}

function approve(
  service: EditorialOrchestrationService,
  requestId: string,
  key: string,
) {
  return service.registerHumanDecision({
    requestId,
    reviewerId: "andre-local",
    decision: "APPROVE",
    receivedAt: at,
    idempotencyKey: key,
  });
}

async function count(table: string) {
  if (!/^editorial_(?:orchestration|human_decision)/.test(table)) {
    throw new Error("Unsafe test table.");
  }
  const result = await pool.query<{ readonly count: string }>(
    `SELECT count(*) count FROM ${table}`,
  );
  return Number(result.rows[0]?.count);
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof EditorialOrchestrationError && error.code === expected;
}
