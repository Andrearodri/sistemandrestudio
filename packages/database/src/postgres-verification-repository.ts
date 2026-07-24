import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  transition,
} from "../../content-engine/src/index.ts";
import type {
  FactualVerificationResult,
  VerificationClaim,
  VerificationEvidence,
  VerificationResult,
} from "../../content-engine/src/index.ts";
import {
  VerificationWorkflowError,
} from "../../application/src/index.ts";
import type {
  VerificationAtomicOperation,
  VerificationAtomicResult,
  VerificationUnitOfWork,
} from "../../application/src/index.ts";
import { withTransaction } from "./client.ts";
import {
  loadEditorialNewsAggregate,
  saveEditorialNewsAggregate,
} from "./postgres-editorial-news-repository.ts";

type RunRow = QueryResultRow & {
  readonly id: string;
  readonly news_id: string;
  readonly idempotency_key: string;
  readonly command_fingerprint: string;
  readonly policy_id: string;
  readonly policy_version: string;
  readonly expected_version: number;
  readonly previous_state: string;
  readonly current_state: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly finished_at: Date | string | null;
};

export interface CompleteVerification {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly expectedVersion: number;
  readonly previousState: string;
  readonly currentState: string;
  readonly claims: readonly VerificationClaim[];
  readonly evidence: readonly VerificationEvidence[];
  readonly result: FactualVerificationResult;
}

export class PostgresVerificationRepository
  implements VerificationUnitOfWork
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async executeAtomic(
    operation: VerificationAtomicOperation,
  ): Promise<VerificationAtomicResult> {
    return withTransaction(this.#pool, async (client) => {
      const existing = await findRunByKey(
        client,
        operation.input.idempotencyKey,
        true,
      );
      if (existing !== undefined) {
        if (
          existing.news_id !== operation.input.newsId ||
          existing.command_fingerprint !== operation.fingerprint
        ) {
          throw new VerificationWorkflowError(
            "VERIFICATION_IDEMPOTENCY_CONFLICT",
            "The verification key is associated with different content.",
          );
        }
        const replay = await loadCompleteByRun(client, existing);
        return {
          previousState: replay.previousState,
          currentState: replay.currentState,
          replayed: true,
          result: replay.result,
        };
      }

      const locked = await client.query<
        QueryResultRow & {
          readonly state: string;
          readonly lock_version: number;
        }
      >(
        `SELECT state, lock_version
         FROM editorial_news
         WHERE id = $1
         FOR UPDATE`,
        [operation.input.newsId],
      );
      const row = locked.rows[0];
      if (row === undefined) {
        throw new VerificationWorkflowError(
          "VERIFICATION_NEWS_NOT_FOUND",
          "The editorial news item does not exist.",
        );
      }
      if (row.lock_version !== operation.input.expectedVersion) {
        throw new VerificationWorkflowError(
          "VERIFICATION_CONCURRENCY_CONFLICT",
          "The editorial news version changed before verification.",
        );
      }
      if (row.state !== "PENDING_VERIFICATION") {
        throw new VerificationWorkflowError(
          "VERIFICATION_INVALID_EDITORIAL_STATE",
          "Only news pending verification can be fact-checked.",
        );
      }

      const current = await loadEditorialNewsAggregate(
        client,
        operation.input.newsId,
      );
      if (current === undefined) {
        throw new VerificationWorkflowError(
          "VERIFICATION_NEWS_NOT_FOUND",
          "The editorial news item disappeared during verification.",
        );
      }

      await insertRun(client, operation, current.state);
      await insertClaims(client, operation);
      await insertEvidence(client, operation);
      await insertResult(client, operation);

      let currentState = current.state;
      if (operation.result.status !== "PARTIALLY_CONFIRMED") {
        const approved = operation.result.status === "CONFIRMED";
        const command = {
          type: approved
            ? "ApproveVerification" as const
            : "RejectVerification" as const,
          verification: toEditorialVerification(operation.result),
          idempotencyKey: operation.input.idempotencyKey,
          reason: operation.result.blockingReasons[0]?.code ??
            operation.result.status,
        };
        const transitioned = transition(current, command, {
          eventId: operation.input.commandId,
          actor: operation.input.actor,
          occurredAt: operation.input.occurredAt,
        });
        await saveEditorialNewsAggregate(
          client,
          transitioned.entity,
          operation.input.expectedVersion,
        );
        currentState = transitioned.entity.state;
      }

      await client.query(
        `UPDATE verification_runs
         SET status = 'SUCCEEDED',
             finished_at = $2,
             current_state = $3
         WHERE id = $1`,
        [
          operation.input.verificationId,
          operation.input.occurredAt,
          currentState,
        ],
      );

      return {
        previousState: current.state,
        currentState,
        replayed: false,
        result: operation.result,
      };
    });
  }

  async findByIdempotency(
    key: string,
  ): Promise<CompleteVerification | undefined> {
    return withTransaction(this.#pool, async (client) => {
      const run = await findRunByKey(client, key, false);
      return run === undefined ? undefined : loadCompleteByRun(client, run);
    });
  }

  async findComplete(
    verificationId: string,
  ): Promise<CompleteVerification | undefined> {
    return withTransaction(this.#pool, async (client) => {
      const found = await client.query<RunRow>(
        `SELECT *
         FROM verification_runs
         WHERE id = $1`,
        [verificationId],
      );
      const run = found.rows[0];
      return run === undefined ? undefined : loadCompleteByRun(client, run);
    });
  }
}

async function insertRun(
  client: PoolClient,
  operation: VerificationAtomicOperation,
  previousState: string,
): Promise<void> {
  await client.query(
    `INSERT INTO verification_runs (
       id, news_id, idempotency_key, command_fingerprint,
       policy_id, policy_version, expected_version,
       previous_state, current_state, status,
       started_at, finished_at, actor_id
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8, $8, 'RUNNING',
       $9, NULL, $10
     )`,
    [
      operation.input.verificationId,
      operation.input.newsId,
      operation.input.idempotencyKey,
      operation.fingerprint,
      operation.result.policyId,
      operation.result.policyVersion,
      operation.input.expectedVersion,
      previousState,
      operation.input.occurredAt,
      operation.input.actor.id,
    ],
  );
}

async function insertClaims(
  client: PoolClient,
  operation: VerificationAtomicOperation,
): Promise<void> {
  for (const [ordinal, claim] of operation.input.claims.entries()) {
    await client.query(
      `INSERT INTO verification_claims (
         id, run_id, news_id, ordinal, claim_type, claim_text,
         importance, expected_subject, expected_date, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        claim.id,
        operation.input.verificationId,
        operation.input.newsId,
        ordinal,
        claim.type,
        claim.text,
        claim.importance,
        claim.expectedSubject ?? null,
        claim.expectedDate ?? null,
        operation.input.occurredAt,
      ],
    );
  }
}

async function insertEvidence(
  client: PoolClient,
  operation: VerificationAtomicOperation,
): Promise<void> {
  const ordinalByClaim = new Map<string, number>();
  for (const evidence of operation.input.evidence) {
    const ordinal = ordinalByClaim.get(evidence.claimId) ?? 0;
    ordinalByClaim.set(evidence.claimId, ordinal + 1);
    await client.query(
      `INSERT INTO verification_evidence (
         id, claim_id, ordinal, source_id, canonical_url,
         authority, evidence_type, published_at, event_date,
         updated_at, superseded_at, available_at, retrieved_at,
         excerpt, structured_facts, supports_claim,
         contradicts_claim, created_at
       )
       VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, $13,
         $14, $15::jsonb, $16,
         $17, $13
       )`,
      [
        evidence.id,
        evidence.claimId,
        ordinal,
        evidence.sourceId,
        evidence.canonicalUrl,
        evidence.sourceAuthority,
        evidence.evidenceType,
        evidence.publishedAt ?? null,
        evidence.eventDate ?? null,
        evidence.updatedAt ?? null,
        evidence.supersededAt ?? null,
        evidence.availableAt ?? null,
        evidence.retrievedAt,
        evidence.excerpt ?? null,
        JSON.stringify(evidence.structuredFacts),
        evidence.supportsClaim,
        evidence.contradictsClaim,
      ],
    );
  }
}

async function insertResult(
  client: PoolClient,
  operation: VerificationAtomicOperation,
): Promise<void> {
  await client.query(
    `INSERT INTO verification_results (
       id, run_id, news_id, status, editorial_decision,
       confidence, result, evaluated_at
     )
     VALUES ($1, $1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      operation.input.verificationId,
      operation.input.newsId,
      operation.result.status,
      operation.result.editorialDecision,
      operation.result.confidence,
      JSON.stringify(operation.result),
      operation.result.evaluatedAt,
    ],
  );
  for (const claim of operation.result.claims) {
    await client.query(
      `INSERT INTO verification_claim_results (
         result_id, claim_id, status, confidence,
         supporting_evidence_ids, contradicting_evidence_ids, reasons
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [
        operation.input.verificationId,
        claim.claimId,
        claim.status,
        claim.confidence,
        JSON.stringify(claim.supportingEvidenceIds),
        JSON.stringify(claim.contradictingEvidenceIds),
        JSON.stringify(claim.reasons),
      ],
    );
  }
}

async function findRunByKey(
  client: PoolClient,
  key: string,
  lock: boolean,
): Promise<RunRow | undefined> {
  const found = await client.query<RunRow>(
    `SELECT *
     FROM verification_runs
     WHERE idempotency_key = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [key],
  );
  return found.rows[0];
}

async function loadCompleteByRun(
  client: PoolClient,
  run: RunRow,
): Promise<CompleteVerification> {
  const result = await client.query<
    QueryResultRow & { readonly result: FactualVerificationResult }
  >(
    `SELECT result
     FROM verification_results
     WHERE run_id = $1`,
    [run.id],
  );
  const claims = await client.query<
    QueryResultRow & {
      readonly id: string;
      readonly claim_type: VerificationClaim["type"];
      readonly claim_text: string;
      readonly importance: VerificationClaim["importance"];
      readonly expected_subject: string | null;
      readonly expected_date: Date | string | null;
    }
  >(
    `SELECT id, claim_type, claim_text, importance,
            expected_subject, expected_date
     FROM verification_claims
     WHERE run_id = $1
     ORDER BY ordinal`,
    [run.id],
  );
  const evidence = await client.query<
    QueryResultRow & {
      readonly id: string;
      readonly claim_id: string;
      readonly source_id: string;
      readonly canonical_url: string;
      readonly authority: VerificationEvidence["sourceAuthority"];
      readonly evidence_type: VerificationEvidence["evidenceType"];
      readonly published_at: Date | string | null;
      readonly event_date: Date | string | null;
      readonly updated_at: Date | string | null;
      readonly superseded_at: Date | string | null;
      readonly available_at: Date | string | null;
      readonly retrieved_at: Date | string;
      readonly excerpt: string | null;
      readonly structured_facts: Readonly<Record<string, unknown>>;
      readonly supports_claim: boolean;
      readonly contradicts_claim: boolean;
    }
  >(
    `SELECT evidence.*
     FROM verification_evidence evidence
     JOIN verification_claims claim ON claim.id = evidence.claim_id
     WHERE claim.run_id = $1
     ORDER BY claim.ordinal, evidence.ordinal`,
    [run.id],
  );
  const factualResult = result.rows[0]?.result;
  if (factualResult === undefined) {
    throw new VerificationWorkflowError(
      "VERIFICATION_INCOMPLETE_PERSISTENCE",
      "A completed verification has no persisted result.",
    );
  }
  return {
    runId: run.id,
    idempotencyKey: run.idempotency_key,
    fingerprint: run.command_fingerprint,
    expectedVersion: run.expected_version,
    previousState: run.previous_state,
    currentState: run.current_state,
    claims: claims.rows.map((claim) => ({
      id: claim.id,
      text: claim.claim_text,
      type: claim.claim_type,
      importance: claim.importance,
      expectedSubject: claim.expected_subject ?? undefined,
      expectedDate: optionalIso(claim.expected_date),
    })),
    evidence: evidence.rows.map((item) => ({
      id: item.id,
      claimId: item.claim_id,
      sourceId: item.source_id,
      canonicalUrl: item.canonical_url,
      sourceAuthority: item.authority,
      evidenceType: item.evidence_type,
      publishedAt: optionalIso(item.published_at),
      eventDate: optionalIso(item.event_date),
      updatedAt: optionalIso(item.updated_at),
      supersededAt: optionalIso(item.superseded_at),
      availableAt: optionalIso(item.available_at),
      retrievedAt: iso(item.retrieved_at),
      excerpt: item.excerpt ?? undefined,
      structuredFacts: item.structured_facts,
      supportsClaim: item.supports_claim,
      contradictsClaim: item.contradicts_claim,
    })),
    result: factualResult,
  };
}

function toEditorialVerification(
  result: FactualVerificationResult,
): VerificationResult {
  return {
    outcome: result.status === "CONFIRMED" ? "VERIFIED" : "REJECTED",
    confidence:
      result.confidence >= 80 ? "HIGH" :
      result.confidence >= 50 ? "MEDIUM" :
      "LOW",
    claimType: "FACT",
    evidence: [],
    reason: result.blockingReasons[0]?.code ?? result.status,
    policyVersion: result.policyVersion,
  };
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
