export const VERIFICATION_STATUSES = [
  "CONFIRMED", "PARTIALLY_CONFIRMED", "UNCONFIRMED",
  "CONTRADICTED", "OUTDATED", "INSUFFICIENT_EVIDENCE",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_DECISIONS = [
  "ALLOW_DRAFT_GENERATION", "REQUIRE_HUMAN_REVIEW",
  "BLOCK_UNCONFIRMED", "BLOCK_CONTRADICTED", "BLOCK_OUTDATED",
  "BLOCK_INSUFFICIENT_EVIDENCE",
] as const;
export type VerificationEditorialDecision =
  (typeof VERIFICATION_DECISIONS)[number];

export const CLAIM_TYPES = [
  "PRODUCT_LAUNCH", "MODEL_RELEASE", "FEATURE_RELEASE", "API_CHANGE",
  "VERSION_RELEASE", "PRICE_CHANGE", "DEPRECATION", "SECURITY_ADVISORY",
  "POLICY_CHANGE", "DATE_CLAIM", "AVAILABILITY_CLAIM",
  "PERFORMANCE_CLAIM", "GENERAL_FACT",
] as const;
export type VerificationClaimType = (typeof CLAIM_TYPES)[number];

export const EVIDENCE_AUTHORITIES = [
  "PRIMARY_OFFICIAL", "OFFICIAL_DOCUMENTATION", "OFFICIAL_CHANGELOG",
  "OFFICIAL_REPOSITORY", "OFFICIAL_BLOG", "SECONDARY_REPUTABLE",
  "COMMUNITY", "UNKNOWN",
] as const;
export type EvidenceAuthority = (typeof EVIDENCE_AUTHORITIES)[number];

export const EVIDENCE_TYPES = [
  "RELEASE_NOTE", "DOCUMENTATION", "CHANGELOG", "BLOG_ANNOUNCEMENT",
  "REPOSITORY_RELEASE", "SECURITY_ADVISORY", "STRUCTURED_METADATA",
  "DATE_RECORD", "OTHER",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface VerificationClaim {
  readonly id: string;
  readonly text: string;
  readonly type: VerificationClaimType;
  readonly importance: "PRIMARY" | "SECONDARY";
  readonly expectedSubject?: string | undefined;
  readonly expectedDate?: string | undefined;
}

export interface VerificationEvidence {
  readonly id: string;
  readonly claimId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly sourceAuthority: EvidenceAuthority;
  readonly evidenceType: EvidenceType;
  readonly publishedAt?: string | undefined;
  readonly eventDate?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly supersededAt?: string | undefined;
  readonly availableAt?: string | undefined;
  readonly retrievedAt: string;
  readonly excerpt?: string | undefined;
  readonly structuredFacts: Readonly<Record<string, unknown>>;
  readonly supportsClaim: boolean;
  readonly contradictsClaim: boolean;
}

export interface ClaimVerificationResult {
  readonly claimId: string;
  readonly status:
    | "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED"
    | "CONTRADICTED" | "OUTDATED";
  readonly confidence: number;
  readonly supportingEvidenceIds: readonly string[];
  readonly contradictingEvidenceIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface VerificationPolicy {
  readonly id: string;
  readonly version: string;
  readonly authorityWeights: Readonly<Record<EvidenceAuthority, number>>;
  readonly thresholds: {
    readonly confirmed: number;
    readonly partial: number;
    readonly outdatedDays: number;
    readonly maximumInsufficientConfidence: number;
  };
}

export interface VerificationConfidenceBreakdown {
  readonly claimCoverage: number;
  readonly authority: number;
  readonly dateQuality: number;
  readonly contradictionPenalty: number;
}

export interface FactualVerificationResult {
  readonly verificationId: string;
  readonly newsId: string;
  readonly status: VerificationStatus;
  readonly editorialDecision: VerificationEditorialDecision;
  readonly confidence: number;
  readonly confidenceBreakdown: VerificationConfidenceBreakdown;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly evaluatedAt: string;
  readonly claims: readonly ClaimVerificationResult[];
  readonly evidenceSummary: {
    readonly total: number;
    readonly supporting: number;
    readonly contradicting: number;
    readonly highestAuthority?: EvidenceAuthority | undefined;
  };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
  readonly blockingReasons: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}
