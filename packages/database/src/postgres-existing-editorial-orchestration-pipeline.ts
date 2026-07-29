import type { Pool, QueryResultRow } from "pg";

import {
  EditorialOrchestrationError,
  type DraftReference,
  type EditorialOrchestrationPipeline,
  type EditorialPipelineReference,
  type EvidenceReference,
  type HumanDecisionMessage,
  type RelevanceReference,
  type VerificationReference,
} from "../../application/src/editorial-orchestration-service.ts";
import { PostgresHumanEditorialReviewRepository } from "./postgres-human-editorial-review-repository.ts";

/**
 * Conservative DRY_RUN adapter for already persisted items.
 *
 * It does not duplicate or re-run domain rules. It projects references created
 * by the existing radar, evidence, verification, drafting and review services.
 * The live orchestration CLI caps this adapter at three news items and one
 * decision request.
 */
export class PostgresExistingEditorialOrchestrationPipeline
implements EditorialOrchestrationPipeline {
  private readonly pool: Pool;
  private readonly maximumExistingItems: number;

  constructor(pool: Pool, maximumExistingItems = 3) {
    this.pool = pool;
    this.maximumExistingItems = Math.min(3, Math.max(1, maximumExistingItems));
  }

  async ingest(input: {
    readonly sourceIds: readonly string[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }) {
    const rows = await this.pool.query<QueryResultRow>(
      `SELECT DISTINCT n.id news_id, c.id item_id
       FROM editorial_news n
       JOIN collected_source_items c ON c.editorial_news_id = n.id
       WHERE c.source_id = ANY($1::text[])
         AND n.state IN (
           'PENDING_VERIFICATION',
           'VERIFIED',
           'DRAFT_CREATED',
           'PENDING_APPROVAL',
           'CHANGES_REQUESTED',
           'APPROVED',
           'READY_FOR_PUBLICATION',
           'PUBLISHED'
         )
       ORDER BY n.id
       LIMIT $2`,
      [
        input.sourceIds,
        Math.min(input.maximumItems, this.maximumExistingItems),
      ],
    );
    return rows.rows.map((row) => ({
      id: row.item_id as string,
      newsId: row.news_id as string,
    }));
  }

  async evaluateRelevance(input: {
    readonly items: readonly EditorialPipelineReference[];
    readonly minimumScore: number;
    readonly idempotencyKey: string;
  }) {
    const output: RelevanceReference[] = [];
    for (const item of input.items.slice(0, this.maximumExistingItems)) {
      const row = await this.pool.query<QueryResultRow>(
        `SELECT (result->>'value')::smallint score
         FROM editorial_relevance_results
         WHERE news_id = $1
         ORDER BY evaluated_at DESC, id DESC
         LIMIT 1`,
        [item.newsId],
      );
      const score = Number(row.rows[0]?.score ?? 0);
      output.push({
        ...item,
        relevanceScore: score,
        eligible: score >= input.minimumScore,
      });
    }
    return output;
  }

  async acquireEvidence(input: {
    readonly items: readonly RelevanceReference[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }) {
    const output: EvidenceReference[] = [];
    for (const item of input.items.slice(
      0,
      Math.min(input.maximumItems, this.maximumExistingItems),
    )) {
      const row = await this.pool.query<QueryResultRow>(
        `SELECT ve.id evidence_id
         FROM verification_evidence ve
         JOIN verification_claims vc ON vc.id = ve.claim_id
         WHERE vc.news_id = $1
         ORDER BY ve.created_at DESC, ve.id
         LIMIT 1`,
        [item.newsId],
      );
      if (row.rows[0]?.evidence_id !== undefined) {
        output.push({
          ...item,
          evidenceId: row.rows[0].evidence_id as string,
        });
      }
    }
    return output;
  }

  async verifyFacts(input: {
    readonly items: readonly EvidenceReference[];
    readonly idempotencyKey: string;
  }) {
    const output: VerificationReference[] = [];
    for (const item of input.items.slice(0, this.maximumExistingItems)) {
      const row = await this.pool.query<QueryResultRow>(
        `SELECT id, status, confidence
         FROM verification_results
         WHERE news_id = $1
         ORDER BY evaluated_at DESC, id DESC
         LIMIT 1`,
        [item.newsId],
      );
      if (row.rows[0] !== undefined) {
        output.push({
          ...item,
          verificationId: row.rows[0].id as string,
          status: row.rows[0].status,
          confidence: Number(row.rows[0].confidence) / 100,
        });
      }
    }
    return output;
  }

  async generateDrafts(input: {
    readonly items: readonly VerificationReference[];
    readonly maximumDrafts: number;
    readonly idempotencyKey: string;
  }) {
    const output: DraftReference[] = [];
    for (const item of input.items.slice(
      0,
      Math.min(1, input.maximumDrafts),
    )) {
      const row = await this.pool.query<QueryResultRow>(
        `SELECT d.id draft_id, d.version_number, n.lock_version
         FROM editorial_news n
         JOIN editorial_drafts d ON d.id = n.current_draft_version_id
         WHERE n.id = $1
           AND n.state = 'PENDING_APPROVAL'
           AND d.validation_status IN ('VALID', 'VALID_WITH_WARNINGS')
         LIMIT 1`,
        [item.newsId],
      );
      if (row.rows[0] !== undefined) {
        output.push({
          ...item,
          draftId: row.rows[0].draft_id as string,
          draftVersion: Number(row.rows[0].version_number),
          newsVersion: Number(row.rows[0].lock_version),
        });
      }
    }
    return output;
  }

  async getDecisionMessage(draft: DraftReference): Promise<HumanDecisionMessage> {
    const review = await new PostgresHumanEditorialReviewRepository(this.pool)
      .get(draft.draftId);
    if (review === undefined) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DRAFT_NOT_FOUND",
        "Persisted review package not found.",
      );
    }
    const sourceName = typeof review.news?.source === "object" &&
      review.news?.source !== null && "name" in review.news.source
      ? String(review.news.source.name)
      : "Fonte oficial";
    const verificationStatus = review.brief.verificationStatus;
    if (verificationStatus !== "CONFIRMED" &&
      verificationStatus !== "PARTIALLY_CONFIRMED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DRAFT_NOT_ELIGIBLE",
        "Draft verification is not eligible for a human decision.",
      );
    }
    return {
      sourceName,
      title: review.draft.title,
      verificationStatus,
      confidence: Math.max(
        0,
        Math.min(
          1,
          review.allowedFacts.length === 0
            ? 0
            : review.allowedFacts.reduce(
              (sum, fact) => sum + fact.confidence,
              0,
            ) / review.allowedFacts.length / 100,
        ),
      ),
      summary: review.draft.subtitle ?? review.draft.body.slice(0, 600),
      allowedClaims: review.allowedFacts.map((fact) => fact.statement).slice(0, 5),
      limitations: [
        ...review.warnings.map((warning) => warning.message),
        ...review.brief.requiredDisclosures,
      ].slice(0, 5),
      draftId: review.draft.draftId,
      draftVersion: draft.draftVersion,
      newsVersion: draft.newsVersion,
    };
  }
}
