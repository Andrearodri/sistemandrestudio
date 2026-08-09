import { createHash } from "node:crypto";
import {
  createEditorialBrief,
  generateEditorialDraft,
} from "../../content-engine/src/index.ts";
import type {
  EditorialBrief, EditorialDraft, EditorialFormat, EditorialTextGenerator,
  EditorialGenerationDiagnostic,
  FactualVerificationResult, VerificationClaim, VerificationEvidence,
} from "../../content-engine/src/index.ts";
import type { EditorialNews } from "../../content-engine/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";

export interface EditorialDraftWorkflowInput {
  readonly newsId: string;
  readonly verificationId: string;
  readonly format: EditorialFormat;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly approvalRequestId: string;
  readonly actor: Actor;
  readonly occurredAt: string;
}
export interface EditorialDraftContext {
  readonly news: EditorialNews;
  readonly verification: FactualVerificationResult;
  readonly claims: readonly VerificationClaim[];
  readonly evidence: readonly VerificationEvidence[];
}
export interface EditorialDraftAtomicOperation {
  readonly input: EditorialDraftWorkflowInput;
  readonly fingerprint: string;
  readonly brief: EditorialBrief;
  readonly draft: EditorialDraft;
}
export interface EditorialDraftAtomicResult { readonly draft: EditorialDraft; readonly currentState: string; readonly replayed: boolean }
export interface EditorialDraftUnitOfWork {
  loadContext(newsId: string, verificationId: string): Promise<EditorialDraftContext | undefined>;
  executeAtomic(operation: EditorialDraftAtomicOperation): Promise<EditorialDraftAtomicResult>;
}
export class EditorialDraftWorkflowError extends Error {
  readonly code: string;
  readonly diagnostics: readonly EditorialGenerationDiagnostic[] | undefined;
  constructor(code: string, message: string, diagnostics?: readonly EditorialGenerationDiagnostic[]) { super(message); this.name = "EditorialDraftWorkflowError"; this.code = code; this.diagnostics = diagnostics; }
}
export class EditorialDraftWorkflowService {
  readonly #unitOfWork: EditorialDraftUnitOfWork;
  readonly #generator: EditorialTextGenerator | undefined;
  constructor(unitOfWork: EditorialDraftUnitOfWork, generator?: EditorialTextGenerator) { this.#unitOfWork = unitOfWork; this.#generator = generator; }
  async createDraft(input: EditorialDraftWorkflowInput): Promise<EditorialDraftAtomicResult> {
    if (!input.idempotencyKey || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_IDEMPOTENCY_CONFLICT", "Draft command metadata is invalid.");
    if (input.format !== "LINKEDIN_SHORT_POST" && input.format !== "WEBSITE_NEWS_BRIEF") throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_FORMAT_NOT_SUPPORTED", "Unsupported editorial format.");
    const context = await this.#unitOfWork.loadContext(input.newsId, input.verificationId);
    if (context === undefined) throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_VERIFICATION_MISSING", "Verification context is missing.");
    if (context.news.state !== "VERIFIED" && context.news.state !== "PENDING_APPROVAL") {
      throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_NEWS_NOT_VERIFIED", "Only VERIFIED news can create a normal draft.");
    }
    // PENDING_APPROVAL is accepted only so the adapter can resolve an already
    // persisted idempotency key. A new key is rejected under the row lock.
    const brief = createEditorialBrief({ ...context, createdAt: input.occurredAt });
    if (brief.editorialEligibility !== "ALLOW_DRAFT") throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_NOT_ELIGIBLE", "The factual result is not eligible for a normal draft.");
    let draft: EditorialDraft;
    try { draft = await generateEditorialDraft({ brief, format: input.format, language: "pt-BR", tone: "informativo", maxCharacters: 3000, editorialIdentityVersion: "andrestudio-dev-v1" }, this.#generator); }
    catch (error) {
      if (error instanceof Error && "diagnostics" in error && Array.isArray((error as { diagnostics?: unknown }).diagnostics)) {
        throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_GENERATION_FAILED", "Deterministic generation failed.", (error as { diagnostics: readonly EditorialGenerationDiagnostic[] }).diagnostics);
      }
      throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_GENERATION_FAILED", "Deterministic generation failed.");
    }
    if (draft.validationStatus === "BLOCKED") throw new EditorialDraftWorkflowError("EDITORIAL_DRAFT_VALIDATION_FAILED", "Generated draft was blocked by the deterministic validator.");
    return this.#unitOfWork.executeAtomic({ input, brief, draft, fingerprint: fingerprint({ input, briefId: brief.briefId, draftId: draft.draftId }) });
  }
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
