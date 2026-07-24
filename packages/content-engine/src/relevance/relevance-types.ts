export const RELEVANCE_CRITERIA = [
  "TOPIC_AFFINITY",
  "SOURCE_AUTHORITY",
  "FRESHNESS",
  "TECHNICAL_IMPACT",
  "COMMERCIAL_POTENTIAL",
  "CONTENT_POTENTIAL",
] as const;

export type RelevanceCriterion = (typeof RELEVANCE_CRITERIA)[number];

export const RELEVANCE_SOURCE_TYPES = [
  "OFFICIAL",
  "DOCUMENTATION",
  "REPUTABLE_TECH_MEDIA",
  "COMMUNITY",
  "UNKNOWN",
] as const;

export type RelevanceSourceType = (typeof RELEVANCE_SOURCE_TYPES)[number];

export const RELEVANCE_NOVELTY_TYPES = [
  "NEW_PRODUCT",
  "NEW_MODEL",
  "MAJOR_UPDATE",
  "API_CHANGE",
  "VULNERABILITY",
  "DISCONTINUATION",
  "PRICE_CHANGE",
  "PLATFORM_RULE_CHANGE",
  "TUTORIAL",
  "OPINION",
  "NO_CONCRETE_NOVELTY",
] as const;

export type RelevanceNoveltyType =
  (typeof RELEVANCE_NOVELTY_TYPES)[number];

export const CONTENT_FORMATS = [
  "POST",
  "ARTICLE",
  "VIDEO",
  "TUTORIAL",
  "DEMONSTRATION",
  "TECHNICAL_OPINION",
] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const COMMERCIAL_RELATIONS = [
  "AUTOMATION_SERVICE",
  "WEBSITE_SERVICE",
  "CUSTOM_SYSTEM",
  "APPLIED_AI",
  "CONSULTING",
  "LEAD_GENERATION",
  "SMALL_BUSINESS_TOOLS",
] as const;

export type CommercialRelation = (typeof COMMERCIAL_RELATIONS)[number];

export const RELEVANCE_PRIORITIES = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "IGNORE",
] as const;

export type RelevancePriority = (typeof RELEVANCE_PRIORITIES)[number];

export const RELEVANCE_DECISIONS = [
  "FAST_TRACK",
  "CONTINUE_TO_VERIFICATION",
  "HOLD_FOR_REVIEW",
  "DISCARD_LOW_RELEVANCE",
] as const;

export type RelevanceDecision = (typeof RELEVANCE_DECISIONS)[number];

export interface RelevanceInput {
  readonly title: string;
  readonly summary: string;
  readonly informedTopics: readonly string[];
  readonly sourceType: RelevanceSourceType;
  readonly publishedAt: string;
  readonly eventAt: string | null;
  readonly evaluatedAt: string;
  readonly noveltyType: RelevanceNoveltyType;
  readonly isRumor: boolean;
  readonly isPromotional: boolean;
  readonly isSensationalist: boolean;
  readonly similarityToExisting: number;
  readonly contentFormats: readonly ContentFormat[];
  readonly commercialRelations: readonly CommercialRelation[];
}

export interface RelevanceReason {
  readonly code: string;
  readonly message: string;
}

export interface RelevanceCriterionResult {
  readonly criterion: RelevanceCriterion;
  readonly score: number;
  readonly maxScore: number;
  readonly reasons: readonly RelevanceReason[];
}

export interface RelevancePenalty {
  readonly code: string;
  readonly points: number;
  readonly reason: string;
}

export interface RelevanceFactor {
  readonly code: string;
  readonly points: number;
  readonly reason: string;
}

export interface RelevanceThresholds {
  readonly criticalMin: number;
  readonly highMin: number;
  readonly mediumMin: number;
  readonly lowMin: number;
  readonly verificationMin: number;
  readonly duplicateSimilarity: number;
  readonly probableDuplicateSimilarity: number;
  readonly oldEventDays: number;
  readonly recentPresentationDays: number;
}

export interface RelevanceTopicDefinition {
  readonly id: string;
  readonly aliases: readonly string[];
}

export interface RelevancePolicy {
  readonly id: string;
  readonly version: string;
  readonly weights: Readonly<Record<RelevanceCriterion, number>>;
  readonly sourceScores: Readonly<Record<RelevanceSourceType, number>>;
  readonly noveltyScores: Readonly<Record<RelevanceNoveltyType, number>>;
  readonly contentFormatScores: Readonly<Record<ContentFormat, number>>;
  readonly commercialRelationScores: Readonly<
    Record<CommercialRelation, number>
  >;
  readonly penaltyPoints: {
    readonly probablyDuplicate: number;
    readonly similarContent: number;
    readonly unknownSource: number;
    readonly missingEventDate: number;
    readonly sensationalistTitle: number;
    readonly unconfirmedRumor: number;
    readonly purelyPromotional: number;
    readonly lowBrandAffinity: number;
    readonly oldNewsPresentedAsCurrent: number;
    readonly noConcreteNovelty: number;
  };
  readonly thresholds: RelevanceThresholds;
  readonly topics: readonly RelevanceTopicDefinition[];
}

export interface RelevanceResult {
  readonly value: number;
  readonly threshold: number;
  readonly reason: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly evaluatedAt: string;
  readonly criteria: readonly RelevanceCriterionResult[];
  readonly penalties: readonly RelevancePenalty[];
  readonly recognizedTopics: readonly string[];
  readonly positiveFactors: readonly RelevanceFactor[];
  readonly negativeFactors: readonly RelevanceFactor[];
  readonly priority: RelevancePriority;
  readonly decision: RelevanceDecision;
  readonly weights: Readonly<Record<RelevanceCriterion, number>>;
  readonly thresholds: RelevanceThresholds;
}
