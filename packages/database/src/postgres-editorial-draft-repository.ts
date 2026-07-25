import type { Pool, PoolClient, QueryResultRow } from "pg";
import { transition } from "../../content-engine/src/index.ts";
import type { EditorialNews } from "../../content-engine/src/index.ts";
import type {
  EditorialDraftAtomicOperation, EditorialDraftAtomicResult, EditorialDraftContext,
  EditorialDraftUnitOfWork,
} from "../../application/src/index.ts";
import { EditorialDraftWorkflowError } from "../../application/src/index.ts";
import { withTransaction } from "./client.ts";
import { loadEditorialNewsAggregate, PostgresEditorialNewsRepository, saveEditorialNewsAggregate } from "./postgres-editorial-news-repository.ts";
import { PostgresVerificationRepository } from "./postgres-verification-repository.ts";

export class PostgresEditorialDraftRepository implements EditorialDraftUnitOfWork {
  readonly #pool: Pool;
  constructor(pool: Pool) { this.#pool = pool; }
  async loadContext(newsId: string, verificationId: string): Promise<EditorialDraftContext | undefined> {
    const [news, verification] = await Promise.all([
      new PostgresEditorialNewsRepository(this.#pool).findById(newsId),
      new PostgresVerificationRepository(this.#pool).findComplete(verificationId),
    ]);
    if (news === undefined || verification === undefined || verification.result.newsId !== newsId) return undefined;
    // The aggregate is read before the drafting transaction; it is rechecked under lock later.
    return { news, verification: verification.result, claims: verification.claims, evidence: verification.evidence };
  }
  async executeAtomic(operation: EditorialDraftAtomicOperation): Promise<EditorialDraftAtomicResult> {
    return withTransaction(this.#pool, (client) => executeDraftAtomic(client, operation));
  }
}

async function executeDraftAtomic(client: PoolClient, operation: EditorialDraftAtomicOperation): Promise<EditorialDraftAtomicResult> {
  const existing = await client.query<QueryResultRow & { readonly command_fingerprint: string; readonly id: string; readonly validation_status: "VALID" | "VALID_WITH_WARNINGS" | "BLOCKED" }>(
    "SELECT id, command_fingerprint, validation_status FROM editorial_drafts WHERE idempotency_key = $1 FOR UPDATE", [operation.input.idempotencyKey],
  );
  if (existing.rows[0] !== undefined) {
    if (existing.rows[0].command_fingerprint !== operation.fingerprint) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_IDEMPOTENCY_CONFLICT", "The draft idempotency key is associated with different content.");
    return { draft: operation.draft, currentState: "PENDING_APPROVAL", replayed: true };
  }
  const locked = await client.query<QueryResultRow & { readonly lock_version: number; readonly state: string }>("SELECT lock_version, state FROM editorial_news WHERE id = $1 FOR UPDATE", [operation.input.newsId]);
  const row = locked.rows[0];
  if (row === undefined) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_PERSISTENCE_FAILED", "Editorial news does not exist.");
  if (row.lock_version !== operation.input.expectedVersion) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_CONCURRENCY_CONFLICT", "Editorial news changed before draft persistence.");
  if (row.state !== "VERIFIED") throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_NEWS_NOT_VERIFIED", "News is no longer VERIFIED.");
  if (operation.draft.validationStatus === "BLOCKED") throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_VALIDATION_FAILED", "Blocked drafts cannot be submitted for approval.");
  const current = await loadEditorialNewsAggregate(client, operation.input.newsId);
  if (current === undefined) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_PERSISTENCE_FAILED", "Editorial aggregate disappeared.");
  const created = transition(current, { type: "CreateDraft", draftVersionId: operation.draft.draftId, body: operation.draft.body, idempotencyKey: operation.input.idempotencyKey }, { eventId: `${operation.input.commandId}:draft`, actor: operation.input.actor, occurredAt: operation.input.occurredAt });
  const submitted = transition(created.entity, { type: "SubmitForApproval", approvalRequestId: operation.input.approvalRequestId, contentVersionId: operation.draft.draftId, idempotencyKey: `${operation.input.idempotencyKey}:approval` }, { eventId: `${operation.input.commandId}:approval`, actor: operation.input.actor, occurredAt: operation.input.occurredAt });
  await saveEditorialNewsAggregate(client, submitted.entity, operation.input.expectedVersion);
  await insertBrief(client, operation);
  await insertDraft(client, operation);
  return { draft: operation.draft, currentState: submitted.entity.state, replayed: false };
}

async function insertBrief(client: PoolClient, operation: EditorialDraftAtomicOperation): Promise<void> {
  const b = operation.brief;
  await client.query(`INSERT INTO editorial_briefs (id, news_id, verification_id, relevance_score, relevance_priority, verification_status, eligibility, policy_id, policy_version, subject, warnings, prohibited_statements, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13)`, [b.briefId,b.newsId,b.verificationId,b.relevanceScore,b.relevancePriority,b.verificationStatus,b.editorialEligibility,b.policyId,b.policyVersion,JSON.stringify(b.subject),JSON.stringify(b.warnings),JSON.stringify(b.prohibitedStatements),b.createdAt]);
  for (const claim of [...b.confirmedClaims, ...b.restrictedClaims, ...b.prohibitedClaims]) await client.query(`INSERT INTO editorial_brief_claims (brief_id, claim_id, classification, factual_status, confidence, evidence_ids, reason) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [b.briefId,claim.claimId,claim.classification,claim.factualStatus,claim.confidence,JSON.stringify(claim.evidenceIds),claim.reason]);
  for (const fact of b.allowedFacts) await client.query(`INSERT INTO editorial_brief_facts (id, brief_id, claim_id, statement, confidence, restrictions, evidence_ids) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [fact.factId,b.briefId,fact.claimId,fact.statement,fact.confidence,JSON.stringify(fact.restrictions),JSON.stringify(fact.evidenceIds)]);
}
async function insertDraft(client: PoolClient, operation: EditorialDraftAtomicOperation): Promise<void> {
  const d = operation.draft;
  await client.query(`INSERT INTO editorial_drafts (id, brief_id, news_id, idempotency_key, command_fingerprint, format, language, title, subtitle, body, generator_id, generator_version, validation_status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [d.draftId,d.briefId,d.newsId,operation.input.idempotencyKey,operation.fingerprint,d.format,d.language,d.title,d.subtitle ?? null,d.body,d.generatorId,d.generatorVersion,d.validationStatus,d.createdAt]);
  for (const citation of d.sourceCitations) await client.query(`INSERT INTO editorial_draft_citations (draft_id, evidence_id, claim_id, source_id, canonical_url, page_title, published_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [d.draftId,citation.evidenceId,citation.claimId,citation.sourceId,citation.canonicalUrl,citation.title,citation.publishedAt ?? null]);
  await client.query(`INSERT INTO editorial_draft_validations (draft_id, status, evaluated_rules, warnings, blocking_reasons, validated_at) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6)`, [d.draftId,d.validationStatus,JSON.stringify(["allowed-facts","citations","anti-sensationalism","no-html"]),JSON.stringify(d.warnings),JSON.stringify([]),d.createdAt]);
}
