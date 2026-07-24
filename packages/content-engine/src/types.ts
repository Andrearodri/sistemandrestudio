import type {
  Actor,
  IdempotencyKey,
  IsoDateTime,
} from "../../shared/src/index.ts";

export const EDITORIAL_STATES = [
  "RECEIVED",
  "NORMALIZED",
  "DUPLICATE",
  "SCORED",
  "DISCARDED_LOW_RELEVANCE",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "VERIFICATION_REJECTED",
  "DRAFT_CREATED",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
] as const;

export type EditorialState = (typeof EDITORIAL_STATES)[number];

export const TERMINAL_STATES = [
  "DUPLICATE",
  "DISCARDED_LOW_RELEVANCE",
  "VERIFICATION_REJECTED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
] as const satisfies readonly EditorialState[];

export type TerminalState = (typeof TERMINAL_STATES)[number];

export interface NewsSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly isOfficial: boolean;
}

export interface Evidence {
  readonly id: string;
  readonly source: NewsSource;
  readonly url: string;
  readonly publishedAt: IsoDateTime;
  readonly eventAt: IsoDateTime;
  readonly collectedAt: IsoDateTime;
  readonly assessment: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  readonly summary: string;
}

export interface RelevanceScore {
  readonly value: number;
  readonly threshold: number;
  readonly reason: string;
  readonly policyVersion: string;
}

export interface VerificationResult {
  readonly outcome: "VERIFIED" | "REJECTED";
  readonly confidence: "LOW" | "MEDIUM" | "HIGH";
  readonly claimType: "FACT" | "INTERPRETATION" | "RUMOR" | "OPINION";
  readonly evidence: readonly Evidence[];
  readonly reason: string;
  readonly policyVersion: string;
}

export interface DraftVersion {
  readonly id: string;
  readonly version: number;
  readonly body: string;
  readonly createdAt: IsoDateTime;
  readonly createdBy: Actor;
  readonly basedOnVersionId: string | null;
}

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REJECTED";

export interface ApprovalRequest {
  readonly id: string;
  readonly contentVersionId: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: IsoDateTime;
  readonly resolvedAt: IsoDateTime | null;
}

export type HumanDecisionType = "APPROVE" | "REQUEST_CHANGES" | "REJECT";

export interface HumanDecision {
  readonly id: string;
  readonly approvalRequestId: string;
  readonly contentVersionId: string;
  readonly type: HumanDecisionType;
  readonly actor: Actor;
  readonly decidedAt: IsoDateTime;
  readonly reason: string | null;
  readonly idempotencyKey: IdempotencyKey;
}

export interface ProcessedCommand {
  readonly commandType: EditorialCommand["type"];
  readonly fingerprint: string;
  readonly idempotencyKey: IdempotencyKey;
}

export interface AuditEvent {
  readonly id: string;
  readonly entityId: string;
  readonly previousState: EditorialState;
  readonly newState: EditorialState;
  readonly action: EditorialCommand["type"];
  readonly actor: Actor;
  readonly occurredAt: IsoDateTime;
  readonly reason: string | null;
  readonly contentVersionId: string | null;
  readonly idempotencyKey: IdempotencyKey | null;
}

export interface EditorialNews {
  readonly id: string;
  readonly source: NewsSource;
  readonly title: string;
  readonly originalUrl: string;
  readonly canonicalUrl: string | null;
  readonly publishedAt: IsoDateTime;
  readonly eventAt: IsoDateTime;
  readonly receivedAt: IsoDateTime;
  readonly state: EditorialState;
  readonly duplicateOfNewsId: string | null;
  readonly relevance: RelevanceScore | null;
  readonly verification: VerificationResult | null;
  readonly draftVersions: readonly DraftVersion[];
  readonly currentDraftVersionId: string | null;
  readonly approvalRequests: readonly ApprovalRequest[];
  readonly currentApprovalRequestId: string | null;
  readonly decisions: readonly HumanDecision[];
  readonly processedCommands: readonly ProcessedCommand[];
  readonly auditEvents: readonly AuditEvent[];
}

interface CommandMetadata {
  readonly idempotencyKey?: IdempotencyKey;
  readonly reason?: string;
}

export type EditorialCommand =
  | (CommandMetadata & {
      readonly type: "NormalizeNews";
      readonly normalizedTitle: string;
      readonly canonicalUrl: string;
    })
  | (CommandMetadata & {
      readonly type: "MarkAsDuplicate";
      readonly duplicateOfNewsId: string;
    })
  | (CommandMetadata & {
      readonly type: "ScoreNews";
      readonly relevance: RelevanceScore;
    })
  | (CommandMetadata & {
      readonly type: "DiscardLowRelevance";
    })
  | (CommandMetadata & {
      readonly type: "RequestVerification";
    })
  | (CommandMetadata & {
      readonly type: "ApproveVerification";
      readonly verification: VerificationResult;
    })
  | (CommandMetadata & {
      readonly type: "RejectVerification";
      readonly verification: VerificationResult;
    })
  | (CommandMetadata & {
      readonly type: "CreateDraft";
      readonly draftVersionId: string;
      readonly body: string;
    })
  | (CommandMetadata & {
      readonly type: "SubmitForApproval";
      readonly approvalRequestId: string;
      readonly contentVersionId: string;
    })
  | (CommandMetadata & {
      readonly type: "RequestChanges";
      readonly decisionId: string;
      readonly approvalRequestId: string;
      readonly contentVersionId: string;
      readonly idempotencyKey: IdempotencyKey;
      readonly reason: string;
    })
  | (CommandMetadata & {
      readonly type: "ApproveDraft";
      readonly decisionId: string;
      readonly approvalRequestId: string;
      readonly contentVersionId: string;
      readonly idempotencyKey: IdempotencyKey;
    })
  | (CommandMetadata & {
      readonly type: "RejectDraft";
      readonly decisionId: string;
      readonly approvalRequestId: string;
      readonly contentVersionId: string;
      readonly idempotencyKey: IdempotencyKey;
      readonly reason: string;
    })
  | (CommandMetadata & {
      readonly type: "MarkReadyForPublication";
    });

export interface TransitionContext {
  readonly eventId: string;
  readonly actor: Actor;
  readonly occurredAt: IsoDateTime;
}

export interface TransitionResult {
  readonly entity: EditorialNews;
  readonly event: AuditEvent | null;
  readonly replayed: boolean;
}

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

export interface CreateReceivedNewsInput {
  readonly id: string;
  readonly source: NewsSource;
  readonly title: string;
  readonly originalUrl: string;
  readonly publishedAt: IsoDateTime;
  readonly eventAt: IsoDateTime;
  readonly receivedAt: IsoDateTime;
}
