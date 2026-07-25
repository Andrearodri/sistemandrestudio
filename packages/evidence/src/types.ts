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
