import type {
  FactualVerificationResult,
  VerificationClaim,
  VerificationEvidence,
} from "../../content-engine/src/index.ts";
import type {
  VerificationAtomicOperation,
} from "../../application/src/index.ts";
import type {
  OfficialPagePolicyDefinition,
  SourceDefinition,
} from "../../sources/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";

export type OfficialPageType =
  | "OFFICIAL_BLOG_POST"
  | "OFFICIAL_DOCUMENTATION"
  | "OFFICIAL_CHANGELOG"
  | "OFFICIAL_RELEASE"
  | "OFFICIAL_REPOSITORY_RELEASE"
  | "OFFICIAL_SECURITY_ADVISORY"
  | "UNKNOWN_OFFICIAL_PAGE";

export type OfficialPageRelationship =
  | "PRIMARY_ARTICLE"
  | "OFFICIAL_DOCUMENTATION"
  | "OFFICIAL_CHANGELOG"
  | "OFFICIAL_RELEASE"
  | "OFFICIAL_REPOSITORY"
  | "OFFICIAL_SECURITY_ADVISORY";

export interface EvidenceLimits {
  readonly maxItemsPerRun: number;
  readonly maxPagesPerItem: number;
  readonly maxRelatedPages: number;
  readonly maxDepth: number;
  readonly maxResponseBytes: number;
  readonly requestTimeoutMs: number;
  readonly itemTimeoutMs: number;
  readonly maxRedirects: number;
  readonly maxRetries: number;
  readonly maxTitleLength: number;
  readonly maxSummaryLength: number;
  readonly maxExcerptLength: number;
  readonly maxCandidateEvidence: number;
  readonly maxHeadings: number;
  readonly maxMinimalTextLength: number;
}

export interface OfficialPageFetch {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly statusCode: number;
  readonly contentType: string;
  readonly responseBytes: number;
  readonly redirectCount: number;
  readonly body: string;
  readonly fetchedAt: string;
}

export interface OfficialPageMetadata {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly canonicalUrl?: string | undefined;
  readonly heading?: string | undefined;
  readonly author?: string | undefined;
  readonly organization?: string | undefined;
  readonly articleType?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly version?: string | undefined;
  readonly availability?: string | undefined;
  readonly product?: string | undefined;
  readonly openGraph: Readonly<Record<string, string>>;
  readonly twitter: Readonly<Record<string, string>>;
  readonly jsonLd: readonly Readonly<Record<string, unknown>>[];
}

export type EvidenceDiagnosticCode =
  | "CLAIM_ENTITY_MISSING"
  | "CLAIM_TYPE_UNSUPPORTED"
  | "CLAIM_TOO_GENERIC"
  | "CLAIM_DATE_MISSING"
  | "CLAIM_VERSION_MISSING"
  | "PAGE_TITLE_NOT_MATCHED"
  | "PAGE_ENTITY_NOT_MATCHED"
  | "PAGE_DATE_NOT_MATCHED"
  | "PAGE_TYPE_NOT_ELIGIBLE"
  | "EVIDENCE_TEXT_NOT_SPECIFIC"
  | "EVIDENCE_AUTHORITY_INSUFFICIENT"
  | "RELATED_PAGE_NOT_FOUND"
  | "RELATED_PAGE_REJECTED"
  | "ASSOCIATION_SCORE_TOO_LOW"
  | "PERFORMANCE_PROOF_MISSING"
  | "AVAILABILITY_PROOF_MISSING"
  | "EVENT_DATE_AMBIGUOUS"
  | "CONTENT_PROMOTIONAL_ONLY"
  | "NO_VERIFIABLE_CLAIM"
  | "ACCEPTED";

export type EntityMatchMethod =
  | "EXACT_IDENTIFIER"
  | "NORMALIZED_EXACT"
  | "EXPLICIT_ALIAS"
  | "PARTIAL_UNIQUE_MATCH"
  | "NO_MATCH";

export interface AssociationScoreBreakdown {
  readonly entity: number;
  readonly pageType: number;
  readonly date: number;
  readonly explicitLanguage: number;
  readonly authority: number;
  readonly penalties: readonly {
    readonly code: EvidenceDiagnosticCode;
    readonly value: number;
  }[];
  readonly total: number;
}

export interface EvidenceCandidateDiagnostic {
  readonly claimId: string;
  readonly claimType: VerificationClaim["type"];
  readonly pageUrl: string;
  readonly pageType: OfficialPageType;
  readonly relationship: OfficialPageRelationship;
  readonly rule: string;
  readonly accepted: boolean;
  readonly code: EvidenceDiagnosticCode;
  readonly reason: string;
  readonly entityMatch: EntityMatchMethod;
  readonly claimEntities: readonly string[];
  readonly pageEntities: readonly string[];
  readonly matchedEntities: readonly string[];
  readonly dates: {
    readonly expected?: string | undefined;
    readonly published?: string | undefined;
    readonly updated?: string | undefined;
    readonly event?: string | undefined;
  };
  readonly missingFields: readonly string[];
  readonly score: AssociationScoreBreakdown;
  readonly evidence?: VerificationEvidence | undefined;
}

export interface EvidenceAssociationFunnel {
  readonly claimsCreated: number;
  readonly candidatesExtracted: number;
  readonly typeCompatible: number;
  readonly entityCompatible: number;
  readonly dateCompatible: number;
  readonly accepted: number;
  readonly evidencePersistable: number;
}

export interface EvidenceAssociationDiagnosticReport {
  readonly mode: "DIAGNOSE_ONLY" | "APPLY_VALIDATED_IMPROVEMENTS";
  readonly claims: readonly {
    readonly id: string;
    readonly text: string;
    readonly type: VerificationClaim["type"];
    readonly importance: VerificationClaim["importance"];
    readonly entities: readonly string[];
    readonly version?: string | undefined;
    readonly codes: readonly EvidenceDiagnosticCode[];
  }[];
  readonly candidates: readonly EvidenceCandidateDiagnostic[];
  readonly funnel: EvidenceAssociationFunnel;
  readonly primaryBlocker: EvidenceDiagnosticCode | "NONE";
}

export interface StoredEvidenceDiagnosticItem {
  readonly radarItemId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly canonicalUrl: string;
  readonly factualStatus: FactualVerificationResult["status"];
  readonly claims: readonly VerificationClaim[];
  readonly pages: readonly ExtractedOfficialPage[];
}

export interface ExtractedOfficialPage {
  readonly requestedUrl: string;
  readonly canonicalUrl: string;
  readonly relationship: OfficialPageRelationship;
  readonly pageType: OfficialPageType;
  readonly title: string;
  readonly summary: string;
  readonly headings: readonly string[];
  readonly minimalText: string;
  readonly metadata: OfficialPageMetadata;
  readonly relatedLinks: readonly {
    readonly url: string;
    readonly relationship: Exclude<
      OfficialPageRelationship,
      "PRIMARY_ARTICLE"
    >;
  }[];
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly fetch: Omit<OfficialPageFetch, "body">;
}

export interface StoredRadarItem {
  readonly id: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly editorialNewsId: string;
  readonly currentState: string;
  readonly currentVersion: number;
}

export interface EvidenceCandidate {
  readonly id: string;
  readonly pageHash: string;
  readonly evidence: VerificationEvidence;
  readonly relationship: OfficialPageRelationship;
  readonly extractionMethod: string;
  readonly associationRule: string;
  readonly associationConfidence: number;
}

export interface EvidenceAcquisitionInput {
  readonly acquisitionId: string;
  readonly radarItemId: string;
  readonly verificationId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly retrievedAt?: string | undefined;
  readonly identityMode?: "EXPLICIT" | "CONTENT_VERSIONED" | undefined;
  readonly claims: readonly VerificationClaim[];
}

export interface PreparedEvidenceAcquisition {
  readonly input: EvidenceAcquisitionInput;
  readonly item: StoredRadarItem;
  readonly source: SourceDefinition;
  readonly policy: OfficialPagePolicyDefinition;
  readonly pages: readonly ExtractedOfficialPage[];
  readonly candidates: readonly EvidenceCandidate[];
  readonly externalIdempotencyKey: string;
  readonly identityMode: "EXPLICIT" | "CONTENT_VERSIONED";
  readonly contentIdentityHash: string;
  readonly identityVersion: string;
  readonly retrievedAt: string;
  readonly acquisitionFingerprint: string;
  readonly verification: VerificationAtomicOperation;
}

export interface EvidenceAcquisitionResult {
  readonly acquisitionId: string;
  readonly radarItemId: string;
  readonly newsId: string;
  readonly pagesConsulted: number;
  readonly pageTypes: readonly OfficialPageType[];
  readonly claims: number;
  readonly evidence: number;
  readonly previousStatus: "INSUFFICIENT_EVIDENCE" | "UNKNOWN";
  readonly verificationStatus: FactualVerificationResult["status"];
  readonly confidence: number;
  readonly editorialDecision: FactualVerificationResult["editorialDecision"];
  readonly previousState: string;
  readonly currentState: string;
  readonly replayed: boolean;
  readonly acquisitionOutcome: "REPLAY" | "NEW_ACQUISITION_VERSION";
  readonly previousContentHash?: string | undefined;
  readonly currentContentHash: string;
  readonly eventsAdditional: number;
  readonly policyVersion: string;
}

export interface EvidenceAcquisitionRepository {
  findRadarItem(id: string): Promise<StoredRadarItem | undefined>;
  executeAtomic(
    prepared: PreparedEvidenceAcquisition,
  ): Promise<EvidenceAcquisitionResult>;
}

export interface OfficialPagePolicy {
  readonly source: SourceDefinition;
  readonly limits: EvidenceLimits;
}
