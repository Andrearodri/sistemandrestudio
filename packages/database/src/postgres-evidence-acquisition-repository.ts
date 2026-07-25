import { createHash } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  EvidenceAcquisitionError,
  OFFICIAL_EVIDENCE_POLICY_VERSION,
  selectOperationalEvidenceItems,
} from "../../evidence/src/index.ts";
import type {
  EvidenceAcquisitionRepository,
  EvidenceAcquisitionResult,
  ExtractedOfficialPage,
  PreparedEvidenceAcquisition,
  StoredRadarItem,
} from "../../evidence/src/index.ts";
import type {
  OperationalEvidenceItem,
} from "../../evidence/src/index.ts";
import {
  VerificationWorkflowError,
} from "../../application/src/index.ts";
import { withTransaction } from "./client.ts";
import {
  executeVerificationAtomic,
} from "./postgres-verification-repository.ts";

type AcquisitionRow = QueryResultRow & {
  readonly id: string;
  readonly source_item_id: string;
  readonly command_fingerprint: string;
  readonly content_identity_hash: string;
  readonly identity_mode: "EXPLICIT" | "CONTENT_VERSIONED";
  readonly policy_version: string;
  readonly source_policy_version: string;
  readonly result: EvidenceAcquisitionResult | null;
};

export interface OperationalStoredEvidenceItem
  extends OperationalEvidenceItem
{
  readonly editorialNewsId: string;
  readonly currentVersion: number;
  readonly updatedAt?: string | undefined;
}

export async function listOperationalEvidenceItems(
  pool: Pool,
  maximum: number,
): Promise<readonly OperationalStoredEvidenceItem[]> {
  const found = await pool.query<
    QueryResultRow & {
      readonly id: string;
      readonly source_id: string;
      readonly canonical_url: string;
      readonly title: string;
      readonly summary: string | null;
      readonly external_id: string | null;
      readonly content_hash: string;
      readonly published_at: Date | string | null;
      readonly updated_at_source: Date | string | null;
      readonly collected_at: Date | string;
      readonly editorial_news_id: string;
      readonly lock_version: number;
      readonly source_enabled: boolean;
    }
  >(`
    SELECT item.id, item.source_id, item.canonical_url, item.title,
           item.summary, item.external_id, item.content_hash,
           item.published_at, item.updated_at_source, item.collected_at,
           item.editorial_news_id, news.lock_version,
           source.enabled AS source_enabled
    FROM collected_source_items item
    JOIN editorial_news news ON news.id = item.editorial_news_id
    JOIN source_definitions source ON source.id = item.source_id
    ORDER BY COALESCE(item.published_at, item.collected_at) DESC,
             item.collected_at DESC, item.source_id, item.id
    LIMIT 100
  `);
  const mapped: OperationalStoredEvidenceItem[] = found.rows.map((item) => ({
    id: item.id,
    sourceId: item.source_id,
    canonicalUrl: item.canonical_url,
    title: item.title,
    summary: item.summary ?? undefined,
    externalId: item.external_id ?? undefined,
    contentHash: item.content_hash,
    publishedAt: optionalIso(item.published_at),
    updatedAt: optionalIso(item.updated_at_source),
    collectedAt: iso(item.collected_at),
    sourceEnabled: item.source_enabled,
    editorialNewsId: item.editorial_news_id,
    currentVersion: item.lock_version,
  }));
  const selected = new Set(
    selectOperationalEvidenceItems(mapped, maximum).map((item) => item.id),
  );
  return mapped.filter((item) => selected.has(item.id));
}

export class PostgresEvidenceAcquisitionRepository
  implements EvidenceAcquisitionRepository
{
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async findRadarItem(id: string): Promise<StoredRadarItem | undefined> {
    const result = await this.#pool.query<
      QueryResultRow & {
        readonly id: string;
        readonly source_id: string;
        readonly canonical_url: string;
        readonly title: string;
        readonly summary: string | null;
        readonly published_at: Date | string | null;
        readonly updated_at_source: Date | string | null;
        readonly editorial_news_id: string;
        readonly state: string;
        readonly lock_version: number;
      }
    >(
      `SELECT item.id, item.source_id, item.canonical_url, item.title,
              item.summary, item.published_at, item.updated_at_source,
              item.editorial_news_id, news.state, news.lock_version
       FROM collected_source_items item
       JOIN editorial_news news ON news.id = item.editorial_news_id
       WHERE item.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          sourceId: row.source_id,
          canonicalUrl: row.canonical_url,
          title: row.title,
          summary: row.summary ?? undefined,
          publishedAt: optionalIso(row.published_at),
          updatedAt: optionalIso(row.updated_at_source),
          editorialNewsId: row.editorial_news_id,
          currentState: row.state,
          currentVersion: row.lock_version,
        };
  }

  async executeAtomic(
    prepared: PreparedEvidenceAcquisition,
  ): Promise<EvidenceAcquisitionResult> {
    try {
      return await withTransaction(this.#pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [`evidence-item:${prepared.item.id}`],
        );
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1))",
          [prepared.input.idempotencyKey],
        );
        const existing = await client.query<AcquisitionRow>(
          `SELECT id, source_item_id, command_fingerprint,
                  content_identity_hash, identity_mode,
                  policy_version, source_policy_version, result
           FROM evidence_acquisition_runs
           WHERE idempotency_key = $1
           FOR UPDATE`,
          [prepared.input.idempotencyKey],
        );
        const previous = existing.rows[0];
        if (previous !== undefined) {
          const contentVersionReplay =
            prepared.identityMode === "CONTENT_VERSIONED" &&
            previous.identity_mode === "CONTENT_VERSIONED" &&
            previous.source_item_id === prepared.item.id &&
            previous.content_identity_hash === prepared.contentIdentityHash &&
            previous.policy_version === OFFICIAL_EVIDENCE_POLICY_VERSION &&
            previous.source_policy_version === prepared.policy.version &&
            previous.result !== null;
          const explicitConflict =
            prepared.identityMode === "EXPLICIT" &&
            (
              previous.source_item_id !== prepared.item.id ||
              previous.command_fingerprint !==
                prepared.acquisitionFingerprint ||
              previous.result === null
            );
          if (!contentVersionReplay && explicitConflict) {
            throw new EvidenceAcquisitionError(
              "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
              "Acquisition key is associated with different page content.",
            );
          }
          if (!contentVersionReplay && prepared.identityMode === "CONTENT_VERSIONED") {
            throw new EvidenceAcquisitionError(
              "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
              "Derived acquisition identity is associated with incompatible content.",
            );
          }
          return {
            ...previous.result!,
            replayed: true,
            acquisitionOutcome: "REPLAY",
            previousContentHash:
              previous.result!.previousContentHash ??
              previous.content_identity_hash,
            eventsAdditional: 0,
          };
        }

        const prior = await client.query<
          QueryResultRow & { readonly content_identity_hash: string }
        >(
          `SELECT content_identity_hash
           FROM evidence_acquisition_runs
           WHERE source_item_id = $1
             AND external_idempotency_key = $2
             AND status = 'SUCCEEDED'
           ORDER BY finished_at DESC, id DESC
           LIMIT 1`,
          [prepared.item.id, prepared.externalIdempotencyKey],
        );
        const previousContentHash = prior.rows[0]?.content_identity_hash;
        await client.query(
          `INSERT INTO evidence_acquisition_runs (
             id, source_item_id, news_id, verification_run_id,
             idempotency_key, command_fingerprint,
             external_idempotency_key, identity_mode,
             identity_version, content_identity_hash,
             policy_version, source_policy_version, expected_version,
             status, started_at, finished_at, result
           )
           VALUES (
             $1, $2, $3, NULL,
             $4, $5,
             $6, $7,
             $8, $9,
             $10, $11, $12,
             'RUNNING', $13, NULL, NULL
           )`,
          [
            prepared.input.acquisitionId,
            prepared.item.id,
            prepared.item.editorialNewsId,
            prepared.input.idempotencyKey,
            prepared.acquisitionFingerprint,
            prepared.externalIdempotencyKey,
            prepared.identityMode,
            prepared.identityVersion,
            prepared.contentIdentityHash,
            OFFICIAL_EVIDENCE_POLICY_VERSION,
            prepared.policy.version,
            prepared.input.expectedVersion,
            prepared.retrievedAt,
          ],
        );

        const snapshotIds = new Map<string, string>();
        for (const [ordinal, page] of prepared.pages.entries()) {
          const snapshotId = await persistPage(
            client,
            prepared,
            page,
            ordinal,
          );
          snapshotIds.set(page.contentHash, snapshotId);
        }

        const verification = await executeVerificationAtomic(
          client,
          prepared.verification,
        );
        for (const candidate of prepared.candidates) {
          const snapshotId = snapshotIds.get(candidate.pageHash);
          if (snapshotId === undefined) {
            throw new EvidenceAcquisitionError(
              "EVIDENCE_ASSOCIATION_FAILED",
              "Evidence candidate references a missing page snapshot.",
            );
          }
          await client.query(
            `INSERT INTO evidence_candidates (
               id, acquisition_run_id, snapshot_id, source_item_id,
               claim_id, evidence_id, authority, evidence_type,
               excerpt, structured_facts, supports_claim, contradicts_claim,
               extraction_method, association_rule, association_confidence,
               content_hash, created_at
             )
             VALUES (
               $1, $2, $3, $4,
               $5, $6, $7, $8,
               $9, $10::jsonb, $11, $12,
               $13, $14, $15,
               $16, $17
             )`,
            [
              candidate.id,
              prepared.input.acquisitionId,
              snapshotId,
              prepared.item.id,
              candidate.evidence.claimId,
              candidate.evidence.id,
              candidate.evidence.sourceAuthority,
              candidate.evidence.evidenceType,
              candidate.evidence.excerpt ?? "",
              JSON.stringify(candidate.evidence.structuredFacts),
              candidate.evidence.supportsClaim,
              candidate.evidence.contradictsClaim,
              candidate.extractionMethod,
              candidate.associationRule,
              candidate.associationConfidence,
              candidate.pageHash,
              prepared.retrievedAt,
            ],
          );
        }

        const result: EvidenceAcquisitionResult = {
          acquisitionId: prepared.input.acquisitionId,
          radarItemId: prepared.item.id,
          newsId: prepared.item.editorialNewsId,
          pagesConsulted: prepared.pages.length,
          pageTypes: prepared.pages.map((page) => page.pageType),
          claims: prepared.input.claims.length,
          evidence: prepared.candidates.length,
          previousStatus: "INSUFFICIENT_EVIDENCE",
          verificationStatus: verification.result.status,
          confidence: verification.result.confidence,
          editorialDecision: verification.result.editorialDecision,
          previousState: verification.previousState,
          currentState: verification.currentState,
          replayed: false,
          acquisitionOutcome: "NEW_ACQUISITION_VERSION",
          previousContentHash,
          currentContentHash: prepared.contentIdentityHash,
          eventsAdditional:
            verification.previousState === verification.currentState ? 0 : 1,
          policyVersion: OFFICIAL_EVIDENCE_POLICY_VERSION,
        };
        await client.query(
          `UPDATE evidence_acquisition_runs
           SET verification_run_id = $2,
               status = 'SUCCEEDED',
               finished_at = $3,
               result = $4::jsonb
           WHERE id = $1`,
          [
            prepared.input.acquisitionId,
            prepared.input.verificationId,
            prepared.retrievedAt,
            JSON.stringify(result),
          ],
        );
        return result;
      });
    } catch (error) {
      if (error instanceof EvidenceAcquisitionError) throw error;
      if (
        error instanceof VerificationWorkflowError &&
        (
          error.code === "VERIFICATION_CONCURRENCY_CONFLICT" ||
          error.code === "VERIFICATION_INVALID_EDITORIAL_STATE"
        )
      ) {
        throw new EvidenceAcquisitionError(
          "EVIDENCE_ACQUISITION_CONCURRENCY_CONFLICT",
          "Editorial state changed before acquired evidence was committed.",
        );
      }
      if (
        error instanceof VerificationWorkflowError &&
        error.code === "VERIFICATION_IDEMPOTENCY_CONFLICT"
      ) {
        throw new EvidenceAcquisitionError(
          "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
          "Verification idempotency conflicts with acquired page content.",
        );
      }
      throw error;
    }
  }
}

async function persistPage(
  client: PoolClient,
  prepared: PreparedEvidenceAcquisition,
  page: ExtractedOfficialPage,
  ordinal: number,
): Promise<string> {
  const fetchId = `page-fetch-${shortHash([
    prepared.input.acquisitionId,
    page.requestedUrl,
    String(ordinal),
  ])}`;
  await client.query(
    `INSERT INTO official_page_fetch_runs (
       id, acquisition_run_id, source_item_id,
       requested_url, final_url, relationship, status,
       http_status, content_type, response_bytes, redirect_count,
       content_hash, started_at, finished_at
     )
     VALUES (
       $1, $2, $3,
       $4, $5, $6, 'SUCCEEDED',
       $7, $8, $9, $10,
       $11, $12, $12
     )`,
    [
      fetchId,
      prepared.input.acquisitionId,
      prepared.item.id,
      page.requestedUrl,
      page.canonicalUrl,
      page.relationship,
      page.fetch.statusCode,
      page.fetch.contentType,
      page.fetch.responseBytes,
      page.fetch.redirectCount,
      page.contentHash,
      page.fetchedAt,
    ],
  );
  const proposedSnapshotId = `page-snapshot-${shortHash([
    prepared.item.id,
    page.canonicalUrl,
    page.contentHash,
  ])}`;
  const inserted = await client.query<
    QueryResultRow & { readonly id: string }
  >(
    `INSERT INTO official_page_snapshots (
       id, fetch_run_id, source_item_id, canonical_url,
       page_type, relationship, title, summary, headings,
       minimal_text, selected_metadata, published_at,
       updated_at_source, content_hash, retrieved_at
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9::jsonb,
       $10, $11::jsonb, $12,
       $13, $14, $15
     )
     ON CONFLICT (source_item_id, canonical_url, content_hash)
     DO NOTHING
     RETURNING id`,
    [
      proposedSnapshotId,
      fetchId,
      prepared.item.id,
      page.canonicalUrl,
      page.pageType,
      page.relationship,
      page.title,
      page.summary,
      JSON.stringify(page.headings),
      page.minimalText,
      JSON.stringify(page.metadata),
      page.metadata.publishedAt ?? null,
      page.metadata.updatedAt ?? null,
      page.contentHash,
      page.fetchedAt,
    ],
  );
  const snapshotId = inserted.rows[0]?.id ??
    (await client.query<QueryResultRow & { readonly id: string }>(
      `SELECT id
       FROM official_page_snapshots
       WHERE source_item_id = $1
         AND canonical_url = $2
         AND content_hash = $3`,
      [prepared.item.id, page.canonicalUrl, page.contentHash],
    )).rows[0]?.id;
  if (snapshotId === undefined) {
    throw new EvidenceAcquisitionError(
      "EVIDENCE_ACQUISITION_PERSISTENCE_FAILED",
      "Page snapshot could not be recovered.",
    );
  }
  await client.query(
    `INSERT INTO official_page_metadata (
       snapshot_id, canonical_url, author, organization, article_type,
       version, availability, product, open_graph, twitter_card, json_ld
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb
     )
     ON CONFLICT (snapshot_id) DO NOTHING`,
    [
      snapshotId,
      page.metadata.canonicalUrl ?? null,
      page.metadata.author ?? null,
      page.metadata.organization ?? null,
      page.metadata.articleType ?? null,
      page.metadata.version ?? null,
      page.metadata.availability ?? null,
      page.metadata.product ?? null,
      JSON.stringify(page.metadata.openGraph),
      JSON.stringify(page.metadata.twitter),
      JSON.stringify(page.metadata.jsonLd),
    ],
  );
  return snapshotId;
}

function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex")
    .slice(0, 24);
}

function optionalIso(
  value: Date | string | null,
): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
