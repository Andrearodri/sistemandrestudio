import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  EditorialDraftView,
  EditorialEvidenceView,
  EditorialItemSummary,
  EditorialReadRepository,
} from "../../application/src/editorial-read-service.ts";
import type { EditorialState } from "../../content-engine/src/index.ts";
import { withTransaction } from "./client.ts";
import { PostgresEditorialNewsRepository } from "./postgres-editorial-news-repository.ts";

export class PostgresEditorialReadRepository implements EditorialReadRepository {
  readonly #news;
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.#news = new PostgresEditorialNewsRepository(pool);
  }

  health() {
    return readOnly(this.pool, async (client) => {
      await client.query("SELECT 1");
      return { database: "available" as const };
    });
  }

  systemStatus() {
    return readOnly(this.pool, async (client) => {
      const counts = await client.query<{ state: EditorialState; count: string }>(
        "SELECT state, count(*) FROM editorial_news GROUP BY state ORDER BY state",
      );
      const pending = await client.query<{ count: string }>(
        `SELECT count(*) FROM editorial_human_decision_requests
         WHERE status IN ('PENDING','DELIVERED')`,
      );
      return {
        database: "available" as const,
        itemsByState: Object.fromEntries(
          counts.rows.map((row) => [row.state, Number(row.count)]),
        ),
        pendingHumanDecisions: Number(pending.rows[0]?.count ?? 0),
      };
    });
  }

  listItems(input: {
    readonly state?: EditorialState;
    readonly limit: number;
    readonly offset: number;
  }) {
    return readOnly(this.pool, async (client) => {
      const result = await client.query<QueryResultRow & {
        id: string;
        state: EditorialState;
        source: { id: string; name: string; isOfficial: boolean };
        title: string;
        canonical_url: string | null;
        published_at: Date | string;
        received_at: Date | string;
        relevance_score: number | null;
        current_draft_version_id: string | null;
        updated_at: Date | string;
      }>(
        `SELECT id,state,source,title,canonical_url,published_at,received_at,
                relevance_score,current_draft_version_id,updated_at
         FROM editorial_news
         WHERE ($1::text IS NULL OR state=$1)
         ORDER BY received_at DESC,id DESC
         LIMIT $2 OFFSET $3`,
        [input.state ?? null, input.limit, input.offset],
      );
      return result.rows.map((row): EditorialItemSummary => ({
        newsId: row.id,
        state: row.state,
        source: {
          id: row.source.id,
          name: row.source.name,
          isOfficial: row.source.isOfficial,
        },
        title: row.title,
        canonicalUrl: row.canonical_url,
        publishedAt: iso(row.published_at),
        receivedAt: iso(row.received_at),
        relevanceScore: row.relevance_score,
        currentDraftVersionId: row.current_draft_version_id,
        updatedAt: iso(row.updated_at),
      }));
    });
  }

  findItem(newsId: string) {
    return this.#news.findById(newsId);
  }

  async listEvidence(input: {
    readonly newsId: string;
    readonly limit: number;
    readonly offset: number;
  }) {
    return readOnly(this.pool, async (client) => {
      const exists = await client.query(
        "SELECT 1 FROM editorial_news WHERE id=$1",
        [input.newsId],
      );
      if (exists.rowCount === 0) return undefined;
      const result = await client.query<QueryResultRow & {
        evidence_id: string;
        claim_id: string;
        claim_text: string;
        source_id: string;
        canonical_url: string;
        authority: string;
        evidence_type: string;
        published_at: Date | string | null;
        event_date: Date | string | null;
        retrieved_at: Date | string;
        excerpt: string | null;
        supports_claim: boolean;
        contradicts_claim: boolean;
      }>(
        `SELECT e.id evidence_id,c.id claim_id,c.claim_text,e.source_id,
                e.canonical_url,e.authority,e.evidence_type,e.published_at,
                e.event_date,e.retrieved_at,e.excerpt,e.supports_claim,
                e.contradicts_claim
         FROM verification_evidence e
         JOIN verification_claims c ON c.id=e.claim_id
         JOIN verification_runs r ON r.id=c.run_id
         WHERE r.news_id=$1
         ORDER BY r.started_at DESC,c.ordinal,e.ordinal,e.id
         LIMIT $2 OFFSET $3`,
        [input.newsId, input.limit, input.offset],
      );
      return result.rows.map((row): EditorialEvidenceView => ({
        evidenceId: row.evidence_id,
        claimId: row.claim_id,
        claim: row.claim_text,
        sourceId: row.source_id,
        canonicalUrl: row.canonical_url,
        authority: row.authority,
        evidenceType: row.evidence_type,
        ...(row.published_at === null
          ? {}
          : { publishedAt: iso(row.published_at) }),
        ...(row.event_date === null ? {} : { eventDate: iso(row.event_date) }),
        retrievedAt: iso(row.retrieved_at),
        ...(row.excerpt === null ? {} : { excerpt: row.excerpt }),
        supportsClaim: row.supports_claim,
        contradictsClaim: row.contradicts_claim,
      }));
    });
  }

  findDraft(input: { readonly draftId: string; readonly version?: number }) {
    return readOnly(this.pool, async (client) => {
      const result = await client.query<QueryResultRow & {
        id: string;
        news_id: string;
        version_number: number;
        source_draft_id: string | null;
        format: string;
        language: string;
        title: string;
        subtitle: string | null;
        body: string;
        validation_status: string;
        created_at: Date | string;
        warnings: readonly string[];
        citations: readonly {
          evidenceId: string;
          claimId: string;
          sourceId: string;
          canonicalUrl: string;
          title: string;
          publishedAt: string | null;
        }[];
      }>(
        `SELECT d.*,
           COALESCE(v.warnings,'[]'::jsonb) warnings,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
               'evidenceId',c.evidence_id,'claimId',c.claim_id,
               'sourceId',c.source_id,'canonicalUrl',c.canonical_url,
               'title',c.page_title,'publishedAt',c.published_at
             ) ORDER BY c.evidence_id)
             FROM editorial_draft_citations c WHERE c.draft_id=d.id
           ),'[]'::jsonb) citations
         FROM editorial_drafts d
         LEFT JOIN editorial_draft_validations v ON v.draft_id=d.id
         WHERE (
           ($2::integer IS NULL AND d.id=$1)
           OR
           ($2::integer IS NOT NULL AND d.version_number=$2 AND d.news_id=(
             SELECT news_id FROM editorial_drafts WHERE id=$1
           ))
         )
         ORDER BY d.created_at DESC
         LIMIT 1`,
        [input.draftId, input.version ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        draftId: row.id,
        newsId: row.news_id,
        version: row.version_number,
        sourceDraftId: row.source_draft_id,
        format: row.format,
        language: row.language,
        title: row.title,
        ...(row.subtitle === null ? {} : { subtitle: row.subtitle }),
        body: row.body,
        validationStatus: row.validation_status,
        warnings: row.warnings,
        citations: row.citations.map((citation) => {
          const {
            publishedAt,
            ...required
          } = citation;
          return {
            ...required,
            ...(publishedAt === null ? {} : { publishedAt }),
          };
        }),
        createdAt: iso(row.created_at),
      } satisfies EditorialDraftView;
    });
  }
}

function readOnly<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  return withTransaction(pool, async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout = '4500ms'");
    const controls = await client.query<{
      readonly read_only: boolean;
      readonly timeout_configured: boolean;
    }>(
      `SELECT
         current_setting('transaction_read_only') = 'on' AS read_only,
         current_setting('statement_timeout')::interval =
           interval '4500 milliseconds' AS timeout_configured`,
    );
    if (!controls.rows[0]?.read_only ||
      !controls.rows[0]?.timeout_configured) {
      throw new Error("PostgreSQL read boundary is not active.");
    }
    return operation(client);
  });
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
