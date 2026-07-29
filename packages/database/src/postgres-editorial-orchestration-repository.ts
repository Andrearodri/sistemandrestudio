import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  EditorialOrchestrationError,
  type EditorialOrchestrationAttempt,
  type EditorialOrchestrationEvent,
  type EditorialOrchestrationRepository,
  type EditorialOrchestrationRun,
  type EditorialOrchestrationRunStatus,
  type EditorialOrchestrationStep,
  type EditorialOrchestrationStepType,
  type HumanDecisionDelivery,
  type HumanDecisionRequest,
  type PersistedHumanDecision,
} from "../../application/src/editorial-orchestration-service.ts";
import { withTransaction } from "./client.ts";

export class PostgresEditorialOrchestrationRepository
implements EditorialOrchestrationRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createRun(
    run: EditorialOrchestrationRun,
    firstEvent: EditorialOrchestrationEvent,
  ) {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [run.triggerKey],
      );
      const prior = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_orchestration_runs
         WHERE trigger_key = $1
         FOR UPDATE`,
        [run.triggerKey],
      );
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].functional_fingerprint !== run.functionalFingerprint) {
          throw new EditorialOrchestrationError(
            "EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT",
            "Trigger key was reused with incompatible functional input.",
          );
        }
        return {
          run: await loadRun(client, prior.rows[0].id as string),
          replayed: true,
        };
      }
      await client.query(
        `INSERT INTO editorial_orchestration_runs(
          id, policy_id, policy_version, trigger_type, trigger_key,
          triggered_by, status, started_at, completed_at,
          functional_fingerprint, created_at, updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          run.id,
          run.policyId,
          run.policyVersion,
          run.triggerType,
          run.triggerKey,
          run.triggeredBy,
          run.status,
          run.startedAt,
          run.completedAt ?? null,
          run.functionalFingerprint,
          run.createdAt,
          run.updatedAt,
        ],
      );
      for (const step of run.steps) {
        await client.query(
          `INSERT INTO editorial_orchestration_steps(
            id, run_id, position, step_type, status, attempt_count,
            input_reference, output_reference, started_at, completed_at,
            error_code, metadata
          ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb)`,
          [
            step.id,
            step.runId,
            step.position,
            step.stepType,
            step.status,
            step.attemptCount,
            json(step.inputReference),
            json(step.outputReference),
            step.startedAt ?? null,
            step.completedAt ?? null,
            step.errorCode ?? null,
            JSON.stringify(step.metadata),
          ],
        );
      }
      await insertEvent(client, firstEvent);
      return { run: await loadRun(client, run.id), replayed: false };
    });
  }

  async getRun(id: string) {
    const row = await this.pool.query(
      "SELECT id FROM editorial_orchestration_runs WHERE id = $1",
      [id],
    );
    if (row.rows[0] === undefined) return undefined;
    return loadRun(this.pool, id);
  }

  async listRuns() {
    const rows = await this.pool.query<{ readonly id: string }>(
      `SELECT id FROM editorial_orchestration_runs
       ORDER BY created_at DESC, id`,
    );
    return Promise.all(rows.rows.map((row) => loadRun(this.pool, row.id)));
  }

  async updateRunStatus(input: {
    readonly runId: string;
    readonly status: EditorialOrchestrationRunStatus;
    readonly occurredAt: string;
    readonly completedAt?: string;
    readonly event?: EditorialOrchestrationEvent;
  }) {
    return withTransaction(this.pool, async (client) => {
      const current = await lockRun(client, input.runId);
      if (isTerminal(current.status as EditorialOrchestrationRunStatus) &&
        current.status !== input.status) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_TERMINAL_RUN",
          "Terminal orchestration run cannot change status.",
        );
      }
      await client.query(
        `UPDATE editorial_orchestration_runs
         SET status = $2,
             completed_at = COALESCE($3, completed_at),
             updated_at = $4
         WHERE id = $1`,
        [input.runId, input.status, input.completedAt ?? null, input.occurredAt],
      );
      if (input.status === "CANCELLED") {
        await client.query(
          `UPDATE editorial_human_decision_requests
           SET status = 'CANCELLED'
           WHERE run_id = $1 AND status IN ('PENDING', 'DELIVERED')`,
          [input.runId],
        );
      }
      if (input.event !== undefined) await insertEvent(client, input.event);
      return loadRun(client, input.runId);
    });
  }

  async startStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      await lockRun(client, input.runId);
      const row = await lockStep(client, input.runId, input.stepType);
      if (row.status === "COMPLETED" || row.status === "SKIPPED" ||
        row.status === "RUNNING") return toStep(row);
      if (row.status === "FAILED") {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_STEP_FAILED",
          "Failed step must be reset before retry.",
        );
      }
      const updated = await client.query<QueryResultRow>(
        `UPDATE editorial_orchestration_steps
         SET status = 'RUNNING',
             attempt_count = attempt_count + 1,
             started_at = $3,
             completed_at = NULL,
             error_code = NULL
         WHERE run_id = $1 AND step_type = $2
         RETURNING *`,
        [input.runId, input.stepType, input.occurredAt],
      );
      const step = toStep(updated.rows[0]!);
      await insertEvent(client, {
        id: eventId(step.id, "started", step.attemptCount),
        runId: input.runId,
        stepId: step.id,
        eventType: "EDITORIAL_ORCHESTRATION_STEP_STARTED",
        metadata: {
          stepType: input.stepType,
          attemptCount: step.attemptCount,
        },
        occurredAt: input.occurredAt,
      });
      return step;
    });
  }

  async completeStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly outputReference: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      await lockRun(client, input.runId);
      const row = await lockStep(client, input.runId, input.stepType);
      if (row.status === "COMPLETED" || row.status === "SKIPPED") {
        return toStep(row);
      }
      const status = input.outputReference.skipped === true
        ? "SKIPPED"
        : "COMPLETED";
      const updated = await client.query<QueryResultRow>(
        `UPDATE editorial_orchestration_steps
         SET status = $3,
             output_reference = $4::jsonb,
             started_at = COALESCE(started_at, $5::timestamptz),
             completed_at = $5,
             error_code = NULL
         WHERE run_id = $1 AND step_type = $2
         RETURNING *`,
        [
          input.runId,
          input.stepType,
          status,
          JSON.stringify(input.outputReference),
          input.occurredAt,
        ],
      );
      const step = toStep(updated.rows[0]!);
      await insertEvent(client, {
        id: eventId(step.id, "completed", step.attemptCount),
        runId: input.runId,
        stepId: step.id,
        eventType: "EDITORIAL_ORCHESTRATION_STEP_COMPLETED",
        metadata: { stepType: input.stepType, status },
        occurredAt: input.occurredAt,
      });
      return step;
    });
  }

  async failStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly errorCode: string;
    readonly occurredAt: string;
  }) {
    const updated = await this.pool.query<QueryResultRow>(
      `UPDATE editorial_orchestration_steps
       SET status = 'FAILED', error_code = $3, completed_at = $4
       WHERE run_id = $1 AND step_type = $2
       RETURNING *`,
      [input.runId, input.stepType, input.errorCode, input.occurredAt],
    );
    if (updated.rows[0] === undefined) stepMissing();
    return toStep(updated.rows[0]!);
  }

  async resetFailedStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }) {
    return withTransaction(this.pool, async (client) => {
      await lockRun(client, input.runId);
      const row = await lockStep(client, input.runId, input.stepType);
      if (row.status !== "FAILED") {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_STEP_NOT_FAILED",
          "Step is not failed.",
        );
      }
      const updated = await client.query<QueryResultRow>(
        `UPDATE editorial_orchestration_steps
         SET status = 'PENDING',
             started_at = NULL,
             completed_at = NULL,
             error_code = NULL
         WHERE id = $1
         RETURNING *`,
        [row.id],
      );
      await client.query(
        `UPDATE editorial_orchestration_runs
         SET status = 'RUNNING', updated_at = $2
         WHERE id = $1`,
        [input.runId, input.occurredAt],
      );
      return toStep(updated.rows[0]!);
    });
  }

  async createDecisionRequest(
    request: HumanDecisionRequest,
    requestEvent: EditorialOrchestrationEvent,
  ) {
    return withTransaction(this.pool, async (client) => {
      await lockRun(client, request.runId);
      const prior = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_human_decision_requests
         WHERE id = $1 OR (draft_id = $2 AND draft_version = $3)
         FOR UPDATE`,
        [request.id, request.draftId, request.draftVersion],
      );
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].functional_fingerprint !== request.functionalFingerprint) {
          throw new EditorialOrchestrationError(
            "EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT",
            "Decision request identity conflict.",
          );
        }
        return { request: toRequest(prior.rows[0]), replayed: true };
      }
      const inserted = await client.query<QueryResultRow>(
        `INSERT INTO editorial_human_decision_requests(
          id, run_id, draft_id, draft_version, news_version, channel,
          recipient_reference, status, expires_at, functional_fingerprint,
          context, created_at, delivered_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
        RETURNING *`,
        [
          request.id,
          request.runId,
          request.draftId,
          request.draftVersion,
          request.newsVersion,
          request.channel,
          request.recipientReference,
          request.status,
          request.expiresAt,
          request.functionalFingerprint,
          JSON.stringify(request.context),
          request.createdAt,
          request.deliveredAt ?? null,
        ],
      );
      await insertEvent(client, requestEvent);
      return { request: toRequest(inserted.rows[0]!), replayed: false };
    });
  }

  async markDecisionDelivered(input: {
    readonly requestId: string;
    readonly delivery: HumanDecisionDelivery;
    readonly event: EditorialOrchestrationEvent;
  }) {
    return withTransaction(this.pool, async (client) => {
      const row = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_human_decision_requests
         WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const current = row.rows[0];
      if (current === undefined) requestMissing();
      if (current!.status === "DELIVERED" || current!.status === "DECIDED") {
        return toRequest(current!);
      }
      const updated = await client.query<QueryResultRow>(
        `UPDATE editorial_human_decision_requests
         SET status = 'DELIVERED',
             recipient_reference = $2,
             delivered_at = $3
         WHERE id = $1
         RETURNING *`,
        [
          input.requestId,
          input.delivery.recipientReference,
          input.delivery.deliveredAt,
        ],
      );
      await insertEvent(client, input.event);
      return toRequest(updated.rows[0]!);
    });
  }

  async getDecisionRequest(id: string) {
    const row = await this.pool.query<QueryResultRow>(
      "SELECT * FROM editorial_human_decision_requests WHERE id = $1",
      [id],
    );
    return row.rows[0] === undefined ? undefined : toRequest(row.rows[0]);
  }

  async getPendingHumanDecisions(now: string) {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE editorial_human_decision_requests
         SET status = 'EXPIRED'
         WHERE status IN ('PENDING', 'DELIVERED') AND expires_at < $1`,
        [now],
      );
      const rows = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_human_decision_requests
         WHERE status IN ('PENDING', 'DELIVERED')
         ORDER BY created_at, id`,
      );
      return rows.rows.map(toRequest);
    });
  }

  async getDecisionByRequest(requestId: string) {
    const row = await this.pool.query<QueryResultRow>(
      `SELECT * FROM editorial_human_decisions WHERE request_id = $1`,
      [requestId],
    );
    return row.rows[0] === undefined ? undefined : toDecision(row.rows[0]);
  }

  async registerDecision(input: {
    readonly requestId: string;
    readonly decision: PersistedHumanDecision;
    readonly event: EditorialOrchestrationEvent;
  }) {
    return withTransaction(this.pool, async (client) => {
      const request = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_human_decision_requests
         WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const requestRow = request.rows[0];
      if (requestRow === undefined) requestMissing();
      const prior = await client.query<QueryResultRow>(
        `SELECT * FROM editorial_human_decisions
         WHERE request_id = $1 FOR UPDATE`,
        [input.requestId],
      );
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].functional_fingerprint !==
          input.decision.functionalFingerprint) {
          throw new EditorialOrchestrationError(
            "EDITORIAL_ORCHESTRATION_DECISION_CONFLICT",
            "A different final decision already exists.",
          );
        }
        return { decision: toDecision(prior.rows[0]), replayed: true };
      }
      if (requestRow!.status !== "PENDING" &&
        requestRow!.status !== "DELIVERED") {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_DECISION_NOT_PENDING",
          "Human decision request is not pending.",
        );
      }
      if (new Date(requestRow!.expires_at as string | Date).getTime() <
        new Date(input.decision.receivedAt).getTime()) {
        await client.query(
          `UPDATE editorial_human_decision_requests
           SET status = 'EXPIRED' WHERE id = $1`,
          [input.requestId],
        );
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_DECISION_EXPIRED",
          "Human decision request expired.",
        );
      }
      const inserted = await client.query<QueryResultRow>(
        `INSERT INTO editorial_human_decisions(
          id, request_id, reviewer_id, decision, reason,
          change_instructions, received_at, external_message_reference,
          functional_fingerprint
        ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
        RETURNING *`,
        [
          input.decision.id,
          input.decision.requestId,
          input.decision.reviewerId,
          input.decision.decision,
          input.decision.reason ?? null,
          input.decision.changeInstructions === undefined
            ? null
            : JSON.stringify(input.decision.changeInstructions),
          input.decision.receivedAt,
          input.decision.externalMessageReference ?? null,
          input.decision.functionalFingerprint,
        ],
      );
      await client.query(
        `UPDATE editorial_human_decision_requests
         SET status = 'DECIDED' WHERE id = $1`,
        [input.requestId],
      );
      await insertEvent(client, input.event);
      return { decision: toDecision(inserted.rows[0]!), replayed: false };
    });
  }

  async getDecisionForRun(runId: string) {
    const row = await this.pool.query<QueryResultRow>(
      `SELECT d.*
       FROM editorial_human_decisions d
       JOIN editorial_human_decision_requests r ON r.id = d.request_id
       WHERE r.run_id = $1
       ORDER BY d.received_at, d.id
       LIMIT 1`,
      [runId],
    );
    return row.rows[0] === undefined ? undefined : toDecision(row.rows[0]);
  }

  async recordAttempt(attempt: EditorialOrchestrationAttempt) {
    await this.pool.query(
      `INSERT INTO editorial_orchestration_attempts(
        id, run_id, step_id, attempt_number, status, error_code,
        started_at, completed_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        completed_at = EXCLUDED.completed_at`,
      [
        attempt.id,
        attempt.runId,
        attempt.stepId,
        attempt.attemptNumber,
        attempt.status,
        attempt.errorCode ?? null,
        attempt.startedAt,
        attempt.completedAt ?? null,
      ],
    );
  }

  async listEvents(runId: string) {
    const rows = await this.pool.query<QueryResultRow>(
      `SELECT * FROM editorial_orchestration_events
       WHERE run_id = $1
       ORDER BY occurred_at, id`,
      [runId],
    );
    return rows.rows.map(toEvent);
  }
}

async function loadRun(
  queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  id: string,
): Promise<EditorialOrchestrationRun> {
  const runResult = await queryable.query<QueryResultRow>(
    "SELECT * FROM editorial_orchestration_runs WHERE id = $1",
    [id],
  );
  const row = runResult.rows[0];
  if (row === undefined) runMissing();
  const stepResult = await queryable.query<QueryResultRow>(
    `SELECT * FROM editorial_orchestration_steps
     WHERE run_id = $1 ORDER BY position`,
    [id],
  );
  return {
    id: row!.id,
    policyId: row!.policy_id,
    policyVersion: row!.policy_version,
    triggerType: row!.trigger_type,
    triggerKey: row!.trigger_key,
    triggeredBy: row!.triggered_by,
    status: row!.status,
    startedAt: iso(row!.started_at),
    functionalFingerprint: row!.functional_fingerprint,
    steps: stepResult.rows.map(toStep),
    createdAt: iso(row!.created_at),
    updatedAt: iso(row!.updated_at),
    ...(row!.completed_at === null
      ? {}
      : { completedAt: iso(row!.completed_at) }),
  };
}

async function lockRun(client: PoolClient, id: string) {
  const row = await client.query<QueryResultRow>(
    "SELECT * FROM editorial_orchestration_runs WHERE id = $1 FOR UPDATE",
    [id],
  );
  if (row.rows[0] === undefined) runMissing();
  return row.rows[0]!;
}

async function lockStep(
  client: PoolClient,
  runId: string,
  stepType: EditorialOrchestrationStepType,
) {
  const row = await client.query<QueryResultRow>(
    `SELECT * FROM editorial_orchestration_steps
     WHERE run_id = $1 AND step_type = $2
     FOR UPDATE`,
    [runId, stepType],
  );
  if (row.rows[0] === undefined) stepMissing();
  return row.rows[0]!;
}

async function insertEvent(client: PoolClient, item: EditorialOrchestrationEvent) {
  await client.query(
    `INSERT INTO editorial_orchestration_events(
      id, run_id, event_type, step_id, request_id, metadata, occurred_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT (id) DO NOTHING`,
    [
      item.id,
      item.runId,
      item.eventType,
      item.stepId ?? null,
      item.requestId ?? null,
      JSON.stringify(item.metadata),
      item.occurredAt,
    ],
  );
}

function toStep(row: QueryResultRow): EditorialOrchestrationStep {
  return {
    id: row.id,
    runId: row.run_id,
    position: row.position,
    stepType: row.step_type,
    status: row.status,
    attemptCount: row.attempt_count,
    metadata: row.metadata,
    ...(row.input_reference === null
      ? {}
      : { inputReference: row.input_reference }),
    ...(row.output_reference === null
      ? {}
      : { outputReference: row.output_reference }),
    ...(row.started_at === null ? {} : { startedAt: iso(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at) }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  };
}

function toRequest(row: QueryResultRow): HumanDecisionRequest {
  return {
    id: row.id,
    runId: row.run_id,
    draftId: row.draft_id,
    draftVersion: row.draft_version,
    newsVersion: row.news_version,
    channel: row.channel,
    recipientReference: row.recipient_reference,
    status: row.status,
    expiresAt: iso(row.expires_at),
    functionalFingerprint: row.functional_fingerprint,
    context: row.context,
    createdAt: iso(row.created_at),
    ...(row.delivered_at === null ? {} : { deliveredAt: iso(row.delivered_at) }),
  };
}

function toDecision(row: QueryResultRow): PersistedHumanDecision {
  return {
    id: row.id,
    requestId: row.request_id,
    reviewerId: row.reviewer_id,
    decision: row.decision,
    receivedAt: iso(row.received_at),
    functionalFingerprint: row.functional_fingerprint,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.change_instructions === null
      ? {}
      : { changeInstructions: row.change_instructions }),
    ...(row.external_message_reference === null
      ? {}
      : { externalMessageReference: row.external_message_reference }),
  };
}

function toEvent(row: QueryResultRow): EditorialOrchestrationEvent {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    metadata: row.metadata,
    occurredAt: iso(row.occurred_at),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.request_id === null ? {} : { requestId: row.request_id }),
  };
}

function json(value: Readonly<Record<string, unknown>> | undefined) {
  return value === undefined ? null : JSON.stringify(value);
}

function iso(value: string | Date) {
  return new Date(value).toISOString();
}

function eventId(stepId: string, state: string, attempt: number) {
  return `${stepId}:event:${state}:${attempt}`;
}

function isTerminal(status: EditorialOrchestrationRunStatus) {
  return status === "COMPLETED" || status === "COMPLETED_WITH_WARNINGS" ||
    status === "CANCELLED";
}

function runMissing(): never {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_RUN_NOT_FOUND",
    "Orchestration run not found.",
  );
}

function stepMissing(): never {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_STEP_NOT_FOUND",
    "Orchestration step not found.",
  );
}

function requestMissing(): never {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_DECISION_REQUEST_NOT_FOUND",
    "Decision request not found.",
  );
}
