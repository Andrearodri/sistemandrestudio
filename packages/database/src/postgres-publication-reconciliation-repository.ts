import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  PublicationReconciliationError,
  publicationSlug,
  type PublicationPackage,
  type PublicationReconciliation,
  type PublicationReconciliationRepository,
  type PublicationVerificationCheck,
  type PublicPublicationVerification,
  type ReconciliationSource,
} from "../../application/src/index.ts";
import { withTransaction } from "./client.ts";

export class PostgresPublicationReconciliationRepository
  implements PublicationReconciliationRepository
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async listReadyForReconciliation(): Promise<readonly ReconciliationSource[]> {
    const result = await this.#pool.query<{ readonly id: string }>(
      `SELECT id
       FROM publication_packages
       WHERE destination = 'WEBSITE_EXPORT'
         AND status = 'READY_FOR_PUBLICATION'
       ORDER BY created_at, id`,
    );
    const sources = await Promise.all(
      result.rows.map((row) => this.loadSource(row.id)),
    );
    return sources.filter(
      (source): source is ReconciliationSource => source !== undefined,
    );
  }

  async loadSource(
    publicationId: string,
  ): Promise<ReconciliationSource | undefined> {
    const row = (await this.#pool.query<QueryResultRow>(
      packageQuery,
      [publicationId],
    )).rows[0];
    if (row === undefined) return undefined;
    const files = (await this.#pool.query<QueryResultRow>(
      `SELECT file_role, relative_path, content_hash, size_bytes
       FROM publication_package_files
       WHERE publication_id = $1
       ORDER BY file_role`,
      [publicationId],
    )).rows.map((file) => ({
      role: file.file_role,
      relativePath: file.relative_path,
      contentHash: file.content_hash,
      sizeBytes: file.size_bytes,
    }));
    return { pkg: mapPackage(row), files };
  }

  async findByIdempotency(
    idempotencyKey: string,
  ): Promise<PublicationReconciliation | undefined> {
    const row = (await this.#pool.query<{ readonly id: string }>(
      `SELECT id FROM publication_reconciliations WHERE idempotency_key = $1`,
      [idempotencyKey],
    )).rows[0];
    return row === undefined ? undefined : this.get(row.id);
  }

  saveAtomic(input: {
    readonly reconciliation: PublicationReconciliation;
    readonly idempotencyKey: string;
    readonly commandId: string;
  }): Promise<{ reconciliation: PublicationReconciliation; replayed: boolean }> {
    return withTransaction(this.#pool, (client) => save(client, input));
  }

  async get(id: string): Promise<PublicationReconciliation | undefined> {
    return loadReconciliation(this.#pool, id);
  }

  async list(): Promise<readonly PublicationReconciliation[]> {
    const ids = await this.#pool.query<{ readonly id: string }>(
      `SELECT id FROM publication_reconciliations ORDER BY created_at, id`,
    );
    const values = await Promise.all(ids.rows.map((row) => this.get(row.id)));
    return values.filter(
      (value): value is PublicationReconciliation => value !== undefined,
    );
  }
}

async function save(
  client: PoolClient,
  input: {
    readonly reconciliation: PublicationReconciliation;
    readonly idempotencyKey: string;
    readonly commandId: string;
  },
): Promise<{ reconciliation: PublicationReconciliation; replayed: boolean }> {
  const previous = (await client.query<{ readonly id: string }>(
    `SELECT id
     FROM publication_reconciliations
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  )).rows[0];
  if (previous !== undefined) {
    const reconciliation = await loadReconciliation(client, previous.id);
    if (
      reconciliation === undefined ||
      reconciliation.functionalFingerprint !==
        input.reconciliation.functionalFingerprint
    ) {
      conflict();
    }
    return { reconciliation, replayed: true };
  }

  const identity = (await client.query<{ readonly id: string }>(
    `SELECT id
     FROM publication_reconciliations
     WHERE functional_fingerprint = $1
     FOR UPDATE`,
    [input.reconciliation.functionalFingerprint],
  )).rows[0];
  if (identity !== undefined) {
    const reconciliation = await loadReconciliation(client, identity.id);
    if (reconciliation === undefined) conflict();
    return { reconciliation, replayed: true };
  }

  const source = (await client.query<QueryResultRow>(
    `SELECT
       p.id,
       p.news_id,
       p.news_version,
       p.draft_id,
       p.draft_version,
       p.approval_decision_id,
       p.destination,
       p.content_hash,
       p.functional_fingerprint,
       p.status,
       n.state,
       n.current_draft_version_id,
       n.lock_version,
       d.version_number,
       review.decision,
       review.reviewer_id
     FROM publication_packages p
     JOIN editorial_news n ON n.id = p.news_id
     JOIN editorial_drafts d ON d.id = p.draft_id
     JOIN editorial_review_decisions review
       ON review.id = p.approval_decision_id
     WHERE p.id = $1
     FOR UPDATE OF p, n, d, review`,
    [input.reconciliation.publicationPackageId],
  )).rows[0];

  const concurrentIdentity = (await client.query<{ readonly id: string }>(
    `SELECT id
     FROM publication_reconciliations
     WHERE functional_fingerprint = $1`,
    [input.reconciliation.functionalFingerprint],
  )).rows[0];
  if (concurrentIdentity !== undefined) {
    const reconciliation = await loadReconciliation(
      client,
      concurrentIdentity.id,
    );
    if (reconciliation === undefined) conflict();
    return { reconciliation, replayed: true };
  }

  if (
    source === undefined ||
    source.status !== "READY_FOR_PUBLICATION" ||
    source.state !== "READY_FOR_PUBLICATION" ||
    source.destination !== "WEBSITE_EXPORT"
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_PACKAGE_NOT_READY",
      "The package and editorial aggregate must both be ready.",
    );
  }
  if (
    source.news_id !== input.reconciliation.newsId ||
    source.draft_id !== input.reconciliation.draftId ||
    source.draft_version !== input.reconciliation.draftVersion ||
    source.version_number !== input.reconciliation.draftVersion ||
    source.current_draft_version_id !== input.reconciliation.draftId ||
    source.decision !== "APPROVE" ||
    source.reviewer_id.length === 0 ||
    input.reconciliation.executionOrigin !== "MANUAL_SUPERVISED_DEPLOY" ||
    input.reconciliation.verificationStatus === "FAILED" ||
    input.reconciliation.verification.status === "FAILED"
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_INTEGRITY_FAILED",
      "Publication identity, approval, origin, or verification changed.",
    );
  }

  try {
    await client.query(
      `INSERT INTO publication_reconciliations (
         id, publication_id, news_id, draft_id, draft_version, destination,
         execution_origin, operator_id, confirmed_at, public_url, canonical_url,
         website_commit, deployment_target_label, policy_id, policy_version,
         verification_status, reconciliation_status, functional_fingerprint,
         previous_state, final_state, warnings, idempotency_key, command_id,
         created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21::jsonb, $22, $23, $24
       )`,
      [
        input.reconciliation.reconciliationId,
        input.reconciliation.publicationPackageId,
        input.reconciliation.newsId,
        input.reconciliation.draftId,
        input.reconciliation.draftVersion,
        input.reconciliation.destination,
        input.reconciliation.executionOrigin,
        input.reconciliation.operatorId,
        input.reconciliation.confirmedAt,
        input.reconciliation.publicUrl,
        input.reconciliation.canonicalUrl,
        input.reconciliation.websiteCommit ?? null,
        input.reconciliation.deploymentTargetLabel ?? null,
        input.reconciliation.policyId,
        input.reconciliation.policyVersion,
        input.reconciliation.verificationStatus,
        input.reconciliation.reconciliationStatus,
        input.reconciliation.functionalFingerprint,
        input.reconciliation.previousState,
        input.reconciliation.finalState,
        JSON.stringify(input.reconciliation.warnings),
        input.idempotencyKey,
        input.commandId,
        input.reconciliation.createdAt,
      ],
    );

    const verification = input.reconciliation.verification;
    await client.query(
      `INSERT INTO publication_public_verifications (
         id, reconciliation_id, publication_id, started_at, completed_at,
         status, http_status, final_url, canonical_url, content_fingerprint,
         warnings
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        verification.verificationId,
        input.reconciliation.reconciliationId,
        input.reconciliation.publicationPackageId,
        verification.startedAt,
        verification.completedAt,
        verification.status,
        verification.httpStatus,
        verification.finalUrl,
        verification.canonicalUrl,
        verification.contentFingerprint,
        JSON.stringify(verification.warnings),
      ],
    );
    for (const check of verification.checks) {
      await client.query(
        `INSERT INTO publication_verification_checks (
           verification_id, position, check_code, status, expected_value,
           observed_summary, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          verification.verificationId,
          check.position,
          check.code,
          check.status,
          check.expectedValue ?? null,
          check.observedSummary,
          JSON.stringify(check.metadata),
        ],
      );
    }

    await client.query(
      `UPDATE publication_packages
       SET status = 'PUBLISHED'
       WHERE id = $1 AND status = 'READY_FOR_PUBLICATION'`,
      [input.reconciliation.publicationPackageId],
    );
    await client.query(
      `UPDATE editorial_news
       SET state = 'PUBLISHED',
           lock_version = lock_version + 1,
           updated_at = $1
       WHERE id = $2 AND state = 'READY_FOR_PUBLICATION'`,
      [input.reconciliation.createdAt, input.reconciliation.newsId],
    );

    const audit = [
      ["requested", "PUBLICATION_RECONCILIATION_REQUESTED", false],
      ["verification-started", "PUBLICATION_PUBLIC_VERIFICATION_STARTED", false],
      [
        "verification-completed",
        "PUBLICATION_PUBLIC_VERIFICATION_COMPLETED",
        false,
      ],
      ["externally-confirmed", "PUBLICATION_EXTERNALLY_CONFIRMED", false],
      ["published", "PUBLICATION_MARKED_AS_PUBLISHED", true],
    ] as const;
    for (const [suffix, action, publishes] of audit) {
      await client.query(
        `INSERT INTO audit_events (
           id, news_id, previous_state, new_state, action, actor_type, actor_id,
           content_version_id, idempotency_key, technical_payload, occurred_at
         ) VALUES (
           $1, $2, 'READY_FOR_PUBLICATION', $3, $4, 'HUMAN', $5, $6, $7,
           $8::jsonb, $9
         )`,
        [
          `${input.commandId}:${suffix}`,
          input.reconciliation.newsId,
          publishes ? "PUBLISHED" : "READY_FOR_PUBLICATION",
          action,
          input.reconciliation.operatorId,
          input.reconciliation.draftId,
          `${input.idempotencyKey}:${suffix}`,
          JSON.stringify({
            reconciliationId: input.reconciliation.reconciliationId,
            publicationId: input.reconciliation.publicationPackageId,
            executionOrigin: input.reconciliation.executionOrigin,
            verificationStatus: input.reconciliation.verificationStatus,
            policyVersion: input.reconciliation.policyVersion,
          }),
          input.reconciliation.createdAt,
        ],
      );
    }
  } catch (error) {
    if ((error as { readonly code?: string }).code === "23505") {
      conflict();
    }
    throw error;
  }

  return { reconciliation: input.reconciliation, replayed: false };
}

async function loadReconciliation(
  queryable: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  reconciliationId: string,
): Promise<PublicationReconciliation | undefined> {
  const row = (await queryable.query<QueryResultRow>(
    `SELECT
       r.*,
       v.id AS verification_id,
       v.started_at,
       v.completed_at,
       v.status AS public_verification_status,
       v.http_status,
       v.final_url,
       v.canonical_url AS verified_canonical_url,
       v.content_fingerprint,
       v.warnings AS verification_warnings
     FROM publication_reconciliations r
     JOIN publication_public_verifications v ON v.reconciliation_id = r.id
     WHERE r.id = $1`,
    [reconciliationId],
  )).rows[0];
  if (row === undefined) return undefined;
  const checks = (await queryable.query<QueryResultRow>(
    `SELECT
       position, check_code, status, expected_value, observed_summary, metadata
     FROM publication_verification_checks
     WHERE verification_id = $1
     ORDER BY position`,
    [row.verification_id],
  )).rows.map(mapCheck);
  const verification: PublicPublicationVerification = {
    verificationId: row.verification_id,
    publicationPackageId: row.publication_id,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: new Date(row.completed_at).toISOString(),
    status: row.public_verification_status,
    httpStatus: row.http_status,
    finalUrl: row.final_url,
    canonicalUrl: row.verified_canonical_url,
    contentFingerprint: row.content_fingerprint,
    warnings: row.verification_warnings ?? [],
    checks,
  };
  return {
    reconciliationId: row.id,
    publicationPackageId: row.publication_id,
    newsId: row.news_id,
    draftId: row.draft_id,
    draftVersion: row.draft_version,
    destination: row.destination,
    executionOrigin: row.execution_origin,
    operatorId: row.operator_id,
    confirmedAt: new Date(row.confirmed_at).toISOString(),
    publicUrl: row.public_url,
    canonicalUrl: row.canonical_url,
    ...(row.website_commit === null
      ? {}
      : { websiteCommit: row.website_commit }),
    ...(row.deployment_target_label === null
      ? {}
      : { deploymentTargetLabel: row.deployment_target_label }),
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    verificationStatus: row.verification_status,
    reconciliationStatus: row.reconciliation_status,
    functionalFingerprint: row.functional_fingerprint,
    previousState: row.previous_state,
    finalState: row.final_state,
    warnings: row.warnings ?? [],
    verification,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const packageQuery = `SELECT
  p.*,
  d.format AS draft_format,
  d.title,
  d.subtitle,
  d.body,
  validation.warnings,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'evidenceId', citation.evidence_id,
      'claimId', citation.claim_id,
      'sourceId', citation.source,
      'canonicalUrl', citation.canonical_url,
      'title', citation.title,
      'publishedAt', citation.published_at
    ))
    FROM publication_package_citations citation
    WHERE citation.publication_id = p.id
  ), '[]') AS citations
FROM publication_packages p
JOIN editorial_drafts d ON d.id = p.draft_id
JOIN editorial_draft_validations validation ON validation.draft_id = d.id
WHERE p.id = $1
  AND p.destination = 'WEBSITE_EXPORT'
  AND p.status = 'READY_FOR_PUBLICATION'`;

function mapPackage(row: QueryResultRow): PublicationPackage {
  return {
    publicationId: row.id,
    newsId: row.news_id,
    newsVersion: row.news_version,
    draftId: row.draft_id,
    draftVersion: row.draft_version,
    draftFormat: row.draft_format,
    approvalDecisionId: row.approval_decision_id,
    reviewerId: row.reviewer_id,
    approvedAt: new Date(row.approved_at).toISOString(),
    destination: row.destination,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    title: row.title,
    ...(row.subtitle === null ? {} : { subtitle: row.subtitle }),
    body: row.body,
    slug: publicationSlug(row.title, row.id),
    citations: row.citations ?? [],
    warnings: row.warnings ?? [],
    contentHash: row.content_hash,
    functionalFingerprint: row.functional_fingerprint,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapCheck(row: QueryResultRow): PublicationVerificationCheck {
  return {
    position: row.position,
    code: row.check_code,
    status: row.status,
    ...(row.expected_value === null
      ? {}
      : { expectedValue: row.expected_value }),
    observedSummary: row.observed_summary,
    metadata: row.metadata ?? {},
  };
}

function conflict(): never {
  throw new PublicationReconciliationError(
    "PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT",
    "A different reconciliation already exists for this identity.",
  );
}
