import type {
  Pool,
  PoolClient,
  QueryResultRow,
} from "pg";

import {
  ConcurrentUpdateError,
  EntityNotFoundError,
  RequiredFieldMissingError,
  validateEntity,
} from "../../content-engine/src/index.ts";
import type {
  ApprovalRequest,
  AuditEvent,
  DraftVersion,
  EditorialNews,
  EditorialNewsRepository,
  HumanDecision,
  ProcessedCommand,
} from "../../content-engine/src/index.ts";
import { withTransaction } from "./client.ts";
import {
  DatabaseError,
  PersistenceConstraintError,
  PersistenceIdempotencyConflictError,
} from "./errors.ts";

type NewsRow = QueryResultRow & {
  readonly id: string;
  readonly state: EditorialNews["state"];
  readonly source: EditorialNews["source"];
  readonly title: string;
  readonly original_url: string;
  readonly canonical_url: string | null;
  readonly published_at: Date | string;
  readonly event_at: Date | string;
  readonly received_at: Date | string;
  readonly duplicate_of_news_id: string | null;
  readonly relevance: EditorialNews["relevance"];
  readonly verification_result: EditorialNews["verification"];
  readonly current_draft_version_id: string | null;
  readonly current_approval_request_id: string | null;
  readonly lock_version: number;
};

type DraftRow = QueryResultRow & {
  readonly id: string;
  readonly version_number: number;
  readonly body: string;
  readonly actor_type: DraftVersion["createdBy"]["type"];
  readonly actor_id: string;
  readonly based_on_version_id: string | null;
  readonly created_at: Date | string;
};

type ApprovalRequestRow = QueryResultRow & {
  readonly id: string;
  readonly draft_version_id: string;
  readonly status: ApprovalRequest["status"];
  readonly requested_at: Date | string;
  readonly resolved_at: Date | string | null;
};

type ApprovalActionRow = QueryResultRow & {
  readonly id: string;
  readonly approval_request_id: string;
  readonly draft_version_id: string;
  readonly decision: HumanDecision["type"];
  readonly actor_type: HumanDecision["actor"]["type"];
  readonly actor_id: string;
  readonly reason: string | null;
  readonly idempotency_key: string;
  readonly created_at: Date | string;
};

type AuditEventRow = QueryResultRow & {
  readonly id: string;
  readonly news_id: string;
  readonly previous_state: AuditEvent["previousState"];
  readonly new_state: AuditEvent["newState"];
  readonly action: AuditEvent["action"];
  readonly actor_type: AuditEvent["actor"]["type"];
  readonly actor_id: string;
  readonly reason: string | null;
  readonly content_version_id: string | null;
  readonly idempotency_key: string | null;
  readonly occurred_at: Date | string;
};

type ProcessedCommandRow = QueryResultRow & {
  readonly idempotency_key: string;
  readonly command_type: ProcessedCommand["commandType"];
  readonly command_fingerprint: string;
  readonly news_id: string;
  readonly result: {
    readonly state: EditorialNews["state"];
    readonly auditEventCount: number;
  };
};

export interface PersistedCommandResult {
  readonly idempotencyKey: string;
  readonly commandType: ProcessedCommand["commandType"];
  readonly fingerprint: string;
  readonly newsId: string;
  readonly result: {
    readonly state: EditorialNews["state"];
    readonly auditEventCount: number;
  };
}

export class PostgresEditorialNewsRepository
  implements EditorialNewsRepository
{
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async findById(id: string): Promise<EditorialNews | undefined> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return loadAggregate(client, id);
    });
  }

  async getById(id: string): Promise<EditorialNews> {
    const entity = await this.findById(id);
    if (entity === undefined) {
      throw new EntityNotFoundError(id);
    }
    return entity;
  }

  async save(
    entity: EditorialNews,
    expectedVersion = Math.max(0, entity.auditEvents.length - 1),
  ): Promise<void> {
    const issue = validateEntity(entity)[0];
    if (issue !== undefined) {
      throw new RequiredFieldMissingError(issue.field);
    }

    try {
      await withTransaction(this.pool, async (client) => {
        const current = await client.query<
          QueryResultRow & { readonly lock_version: number }
        >(
          `SELECT lock_version
           FROM editorial_news
           WHERE id = $1
           FOR UPDATE`,
          [entity.id],
        );

        if (current.rowCount === 0) {
          if (expectedVersion !== 0) {
            throw new ConcurrentUpdateError(entity.id, expectedVersion);
          }
          await insertInitialNews(client, entity);
        } else if (current.rows[0]?.lock_version !== expectedVersion) {
          throw new ConcurrentUpdateError(entity.id, expectedVersion);
        }

        await persistDraftVersions(client, entity);
        await persistApprovalRequests(client, entity);
        await persistApprovalActions(client, entity);
        await persistProcessedCommands(client, entity);
        await persistAuditEvents(client, entity);
        await updateNews(client, entity, expectedVersion);
      });
    } catch (error) {
      throw mapPersistenceError(error);
    }
  }

  async listAuditEvents(entityId: string): Promise<readonly AuditEvent[]> {
    const result = await this.pool.query<AuditEventRow>(
      `SELECT *
       FROM audit_events
       WHERE news_id = $1
       ORDER BY occurred_at, id`,
      [entityId],
    );
    return result.rows.map(mapAuditEvent);
  }

  async findProcessedCommand(
    idempotencyKey: string,
  ): Promise<PersistedCommandResult | undefined> {
    const result = await this.pool.query<ProcessedCommandRow>(
      `SELECT idempotency_key, command_type, command_fingerprint, news_id, result
       FROM processed_commands
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          idempotencyKey: row.idempotency_key,
          commandType: row.command_type,
          fingerprint: row.command_fingerprint,
          newsId: row.news_id,
          result: row.result,
        };
  }
}

async function insertInitialNews(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  await client.query(
    `INSERT INTO editorial_news (
       id, state, source, title, base_content, original_url, canonical_url,
       published_at, event_at, received_at, duplicate_of_news_id,
       relevance_score, relevance, verification_result,
       current_draft_version_id, current_approval_request_id,
       lock_version, created_at, updated_at
     )
     VALUES (
       $1, $2, $3::jsonb, $4, $5, $6, $7,
       $8, $9, $10, $11,
       $12, $13::jsonb, $14::jsonb,
       NULL, NULL,
       0, $10, $10
     )`,
    newsParameters(entity),
  );
}

async function updateNews(
  client: PoolClient,
  entity: EditorialNews,
  expectedVersion: number,
): Promise<void> {
  const updatedAt =
    entity.auditEvents.at(-1)?.occurredAt ?? entity.receivedAt;
  const result = await client.query(
    `UPDATE editorial_news
     SET state = $2,
         source = $3::jsonb,
         title = $4,
         base_content = $5,
         original_url = $6,
         canonical_url = $7,
         published_at = $8,
         event_at = $9,
         received_at = $10,
         duplicate_of_news_id = $11,
         relevance_score = $12,
         relevance = $13::jsonb,
         verification_result = $14::jsonb,
         current_draft_version_id = $15,
         current_approval_request_id = $16,
         lock_version = $17,
         updated_at = $18
     WHERE id = $1
       AND lock_version = $19`,
    [
      ...newsParameters(entity),
      entity.currentDraftVersionId,
      entity.currentApprovalRequestId,
      entity.auditEvents.length,
      updatedAt,
      expectedVersion,
    ],
  );

  if (result.rowCount !== 1) {
    throw new ConcurrentUpdateError(entity.id, expectedVersion);
  }
}

function newsParameters(entity: EditorialNews): unknown[] {
  return [
    entity.id,
    entity.state,
    JSON.stringify(entity.source),
    entity.title,
    entity.title,
    entity.originalUrl,
    entity.canonicalUrl,
    entity.publishedAt,
    entity.eventAt,
    entity.receivedAt,
    entity.duplicateOfNewsId,
    entity.relevance?.value ?? null,
    entity.relevance === null ? null : JSON.stringify(entity.relevance),
    entity.verification === null
      ? null
      : JSON.stringify(entity.verification),
  ];
}

async function persistDraftVersions(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  for (const version of entity.draftVersions) {
    const event = entity.auditEvents.find(
      (item) =>
        item.action === "CreateDraft" &&
        item.contentVersionId === version.id,
    );
    const result = await client.query(
      `INSERT INTO draft_versions (
         id, news_id, version_number, body, change_reason,
         actor_type, actor_id, based_on_version_id, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        version.id,
        entity.id,
        version.version,
        version.body,
        event?.reason ?? null,
        version.createdBy.type,
        version.createdBy.id,
        version.basedOnVersionId,
        version.createdAt,
      ],
    );

    if (result.rowCount === 0) {
      const existing = await client.query<
        QueryResultRow & {
          readonly news_id: string;
          readonly version_number: number;
          readonly body: string;
        }
      >(
        `SELECT news_id, version_number, body
         FROM draft_versions
         WHERE id = $1`,
        [version.id],
      );
      const row = existing.rows[0];
      if (
        row?.news_id !== entity.id ||
        row.version_number !== version.version ||
        row.body !== version.body
      ) {
        throw new PersistenceConstraintError("draft_versions_immutable");
      }
    }
  }
}

async function persistApprovalRequests(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  for (const request of entity.approvalRequests) {
    const result = await client.query(
      `INSERT INTO approval_requests (
         id, news_id, draft_version_id, status, requested_at, resolved_at
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           resolved_at = EXCLUDED.resolved_at
       WHERE approval_requests.news_id = EXCLUDED.news_id
         AND approval_requests.draft_version_id = EXCLUDED.draft_version_id`,
      [
        request.id,
        entity.id,
        request.contentVersionId,
        request.status,
        request.requestedAt,
        request.resolvedAt,
      ],
    );
    if (result.rowCount !== 1) {
      throw new PersistenceConstraintError("approval_requests_immutable");
    }
  }
}

async function persistApprovalActions(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  for (const decision of entity.decisions) {
    await client.query(
      `INSERT INTO approval_actions (
         id, news_id, approval_request_id, draft_version_id,
         decision, actor_type, actor_id, reason,
         idempotency_key, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING`,
      [
        decision.id,
        entity.id,
        decision.approvalRequestId,
        decision.contentVersionId,
        decision.type,
        decision.actor.type,
        decision.actor.id,
        decision.reason,
        decision.idempotencyKey,
        decision.decidedAt,
      ],
    );
  }
}

async function persistProcessedCommands(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  for (const command of entity.processedCommands) {
    const existing = await client.query<ProcessedCommandRow>(
      `SELECT idempotency_key, command_type, command_fingerprint, news_id, result
       FROM processed_commands
       WHERE idempotency_key = $1
       FOR UPDATE`,
      [command.idempotencyKey],
    );
    const row = existing.rows[0];

    if (row !== undefined) {
      if (
        row.news_id !== entity.id ||
        row.command_type !== command.commandType ||
        row.command_fingerprint !== command.fingerprint
      ) {
        throw new PersistenceIdempotencyConflictError(command.idempotencyKey);
      }
      continue;
    }

    const event = entity.auditEvents.find(
      (item) => item.idempotencyKey === command.idempotencyKey,
    );
    await client.query(
      `INSERT INTO processed_commands (
         idempotency_key, command_type, command_fingerprint,
         news_id, result, processed_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        command.idempotencyKey,
        command.commandType,
        command.fingerprint,
        entity.id,
        JSON.stringify({
          state: entity.state,
          auditEventCount: entity.auditEvents.length,
        }),
        event?.occurredAt ?? entity.receivedAt,
      ],
    );
  }
}

async function persistAuditEvents(
  client: PoolClient,
  entity: EditorialNews,
): Promise<void> {
  const existing = await client.query<
    QueryResultRow & { readonly id: string }
  >(
    `SELECT id
     FROM audit_events
     WHERE news_id = $1`,
    [entity.id],
  );
  const existingIds = new Set(existing.rows.map((row) => row.id));

  for (const event of entity.auditEvents) {
    if (existingIds.has(event.id)) {
      continue;
    }
    await client.query(
      `INSERT INTO audit_events (
         id, news_id, previous_state, new_state, action,
         actor_type, actor_id, reason, content_version_id,
         idempotency_key, technical_payload, occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`,
      [
        event.id,
        entity.id,
        event.previousState,
        event.newState,
        event.action,
        event.actor.type,
        event.actor.id,
        event.reason,
        event.contentVersionId,
        event.idempotencyKey,
        JSON.stringify({ action: event.action }),
        event.occurredAt,
      ],
    );
  }
}

async function loadAggregate(
  client: PoolClient,
  id: string,
): Promise<EditorialNews | undefined> {
  const newsResult = await client.query<NewsRow>(
    `SELECT *
     FROM editorial_news
     WHERE id = $1`,
    [id],
  );
  const news = newsResult.rows[0];
  if (news === undefined) {
    return undefined;
  }

  const drafts = await client.query<DraftRow>(
    `SELECT *
     FROM draft_versions
     WHERE news_id = $1
     ORDER BY version_number`,
    [id],
  );
  const requests = await client.query<ApprovalRequestRow>(
    `SELECT *
     FROM approval_requests
     WHERE news_id = $1
     ORDER BY requested_at, id`,
    [id],
  );
  const actions = await client.query<ApprovalActionRow>(
    `SELECT *
     FROM approval_actions
     WHERE news_id = $1
     ORDER BY created_at, id`,
    [id],
  );
  const commands = await client.query<ProcessedCommandRow>(
    `SELECT idempotency_key, command_type, command_fingerprint, news_id, result
     FROM processed_commands
     WHERE news_id = $1
     ORDER BY processed_at, idempotency_key`,
    [id],
  );
  const events = await client.query<AuditEventRow>(
    `SELECT *
     FROM audit_events
     WHERE news_id = $1
     ORDER BY occurred_at, id`,
    [id],
  );

  return {
    id: news.id,
    source: news.source,
    title: news.title,
    originalUrl: news.original_url,
    canonicalUrl: news.canonical_url,
    publishedAt: iso(news.published_at),
    eventAt: iso(news.event_at),
    receivedAt: iso(news.received_at),
    state: news.state,
    duplicateOfNewsId: news.duplicate_of_news_id,
    relevance: news.relevance,
    verification: news.verification_result,
    draftVersions: drafts.rows.map(mapDraftVersion),
    currentDraftVersionId: news.current_draft_version_id,
    approvalRequests: requests.rows.map(mapApprovalRequest),
    currentApprovalRequestId: news.current_approval_request_id,
    decisions: actions.rows.map(mapDecision),
    processedCommands: commands.rows.map(mapProcessedCommand),
    auditEvents: events.rows.map(mapAuditEvent),
  };
}

function mapDraftVersion(row: DraftRow): DraftVersion {
  return {
    id: row.id,
    version: row.version_number,
    body: row.body,
    createdAt: iso(row.created_at),
    createdBy: { id: row.actor_id, type: row.actor_type },
    basedOnVersionId: row.based_on_version_id,
  };
}

function mapApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    contentVersionId: row.draft_version_id,
    status: row.status,
    requestedAt: iso(row.requested_at),
    resolvedAt: row.resolved_at === null ? null : iso(row.resolved_at),
  };
}

function mapDecision(row: ApprovalActionRow): HumanDecision {
  return {
    id: row.id,
    approvalRequestId: row.approval_request_id,
    contentVersionId: row.draft_version_id,
    type: row.decision,
    actor: { id: row.actor_id, type: row.actor_type },
    decidedAt: iso(row.created_at),
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
  };
}

function mapProcessedCommand(row: ProcessedCommandRow): ProcessedCommand {
  return {
    commandType: row.command_type,
    fingerprint: row.command_fingerprint,
    idempotencyKey: row.idempotency_key,
  };
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    entityId: row.news_id,
    previousState: row.previous_state,
    newState: row.new_state,
    action: row.action,
    actor: { id: row.actor_id, type: row.actor_type },
    occurredAt: iso(row.occurred_at),
    reason: row.reason,
    contentVersionId: row.content_version_id,
    idempotencyKey: row.idempotency_key,
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPersistenceError(error: unknown): unknown {
  if (
    error instanceof DatabaseError ||
    error instanceof ConcurrentUpdateError ||
    error instanceof RequiredFieldMissingError
  ) {
    return error;
  }

  if (isPostgresError(error)) {
    if (
      error.code === "23505" &&
      error.constraint === "processed_commands_pkey"
    ) {
      return new PersistenceIdempotencyConflictError("conflicting-key");
    }
    if (error.code === "23505" && error.constraint === "approval_actions_idempotency_key_key") {
      return new PersistenceIdempotencyConflictError("conflicting-key");
    }
    if (["23502", "23503", "23505", "23514"].includes(error.code)) {
      return new PersistenceConstraintError(error.constraint ?? error.code);
    }
  }

  return error;
}

function isPostgresError(
  error: unknown,
): error is Error & { readonly code: string; readonly constraint?: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  );
}
