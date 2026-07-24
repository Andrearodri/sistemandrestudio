import { InvalidRelevanceScoreError } from "../errors.ts";
import {
  InvalidDateRangeError,
  InvalidRelevanceInputError,
  InvalidRelevancePolicyError,
  UnsupportedNoveltyTypeError,
  UnsupportedSourceTypeError,
} from "./errors.ts";
import {
  COMMERCIAL_RELATIONS,
  CONTENT_FORMATS,
  RELEVANCE_CRITERIA,
  RELEVANCE_DECISIONS,
  RELEVANCE_NOVELTY_TYPES,
  RELEVANCE_PRIORITIES,
  RELEVANCE_SOURCE_TYPES,
} from "./relevance-types.ts";
import type {
  CommercialRelation,
  ContentFormat,
  RelevanceCriterion,
  RelevanceCriterionResult,
  RelevanceDecision,
  RelevanceFactor,
  RelevanceInput,
  RelevanceNoveltyType,
  RelevancePenalty,
  RelevancePolicy,
  RelevancePriority,
  RelevanceResult,
  RelevanceSourceType,
} from "./relevance-types.ts";

const DAY_IN_MILLISECONDS = 86_400_000;

export function calculateRelevance(
  input: RelevanceInput,
  policy: RelevancePolicy,
): RelevanceResult {
  validateRelevancePolicy(policy);
  const dates = validateRelevanceInput(input, policy);
  const recognizedTopics = recognizeTopics(input, policy);
  const criteria = calculateCriteria(
    input,
    policy,
    dates.eventAgeDays,
    recognizedTopics,
  );
  const penalties = calculatePenalties(
    input,
    policy,
    dates.eventAgeDays,
    dates.publicationAgeDays,
    recognizedTopics,
  );
  const positiveTotal = sum(criteria.map((criterion) => criterion.score));
  const penaltyTotal = sum(penalties.map((penalty) => penalty.points));
  const value = clamp(positiveTotal - penaltyTotal, 0, 100);
  const priority = applyPriorityRestrictions(
    priorityFor(value, policy),
    input,
    dates.eventAgeDays,
    dates.publicationAgeDays,
    policy,
  );
  const decision = decisionFor(priority, input.isRumor);
  const positiveFactors = criteria
    .filter((criterion) => criterion.score > 0)
    .map<RelevanceFactor>((criterion) => ({
      code: `CRITERION_${criterion.criterion}`,
      points: criterion.score,
      reason: criterion.reasons[0]?.message ?? criterion.criterion,
    }));
  const negativeFactors = penalties.map<RelevanceFactor>((penalty) => ({
    code: penalty.code,
    points: -penalty.points,
    reason: penalty.reason,
  }));

  const result: RelevanceResult = {
    value,
    threshold: policy.thresholds.verificationMin,
    reason: `${priority}: ${value}/100 according to ${policy.version}.`,
    policyId: policy.id,
    policyVersion: policy.version,
    evaluatedAt: input.evaluatedAt,
    criteria,
    penalties,
    recognizedTopics,
    positiveFactors,
    negativeFactors,
    priority,
    decision,
    weights: { ...policy.weights },
    thresholds: { ...policy.thresholds },
  };

  validateRelevanceResult(result);
  return result;
}

export function validateRelevanceResult(result: RelevanceResult): void {
  if (
    !isRecord(result) ||
    !Array.isArray(result.criteria) ||
    !Array.isArray(result.penalties) ||
    !Array.isArray(result.recognizedTopics) ||
    !Array.isArray(result.positiveFactors) ||
    !Array.isArray(result.negativeFactors) ||
    !isRecord(result.weights) ||
    !isRecord(result.thresholds)
  ) {
    throw new InvalidRelevanceScoreError();
  }
  if (
    !Number.isFinite(result.value) ||
    !Number.isFinite(result.threshold) ||
    result.value < 0 ||
    result.value > 100 ||
    result.threshold < 0 ||
    result.threshold > 100
  ) {
    throw new InvalidRelevanceScoreError();
  }
  if (
    typeof result.policyId !== "string" ||
    typeof result.policyVersion !== "string" ||
    typeof result.reason !== "string" ||
    result.policyId.trim().length === 0 ||
    result.policyVersion.trim().length === 0 ||
    result.reason.trim().length === 0
  ) {
    throw new InvalidRelevancePolicyError("result.policy");
  }
  if (result.criteria.length !== RELEVANCE_CRITERIA.length) {
    throw new InvalidRelevanceScoreError();
  }
  if (
    !RELEVANCE_PRIORITIES.includes(result.priority) ||
    !RELEVANCE_DECISIONS.includes(result.decision) ||
    typeof result.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(result.evaluatedAt)) ||
    result.criteria.some((item) => !isValidCriterionResult(item)) ||
    result.penalties.some((item) => !isValidPenalty(item))
  ) {
    throw new InvalidRelevanceScoreError();
  }
  const positiveTotal = sum(result.criteria.map((item) => item.score));
  const penaltyTotal = sum(result.penalties.map((item) => item.points));
  if (result.value !== clamp(positiveTotal - penaltyTotal, 0, 100)) {
    throw new InvalidRelevanceScoreError();
  }
}

export function validateRelevancePolicy(policy: RelevancePolicy): void {
  if (policy.id.trim().length === 0) {
    throw new InvalidRelevancePolicyError("id");
  }
  if (policy.version.trim().length === 0) {
    throw new InvalidRelevancePolicyError("version");
  }
  const weightTotal = sum(RELEVANCE_CRITERIA.map((key) => policy.weights[key]));
  if (weightTotal !== 100) {
    throw new InvalidRelevancePolicyError("weights");
  }
  for (const criterion of RELEVANCE_CRITERIA) {
    const weight = policy.weights[criterion];
    if (!Number.isInteger(weight) || weight < 0) {
      throw new InvalidRelevancePolicyError(`weights.${criterion}`);
    }
  }
  for (const sourceType of RELEVANCE_SOURCE_TYPES) {
    const score = policy.sourceScores[sourceType];
    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > policy.weights.SOURCE_AUTHORITY
    ) {
      throw new InvalidRelevancePolicyError(`sourceScores.${sourceType}`);
    }
  }
  for (const noveltyType of RELEVANCE_NOVELTY_TYPES) {
    const score = policy.noveltyScores[noveltyType];
    if (
      !Number.isInteger(score) ||
      score < 0 ||
      score > policy.weights.TECHNICAL_IMPACT
    ) {
      throw new InvalidRelevancePolicyError(`noveltyScores.${noveltyType}`);
    }
  }
  const thresholds = policy.thresholds;
  if (
    !(
      thresholds.criticalMin > thresholds.highMin &&
      thresholds.highMin > thresholds.mediumMin &&
      thresholds.mediumMin > thresholds.lowMin &&
      thresholds.lowMin >= 0 &&
      thresholds.criticalMin <= 100 &&
      thresholds.verificationMin >= 0 &&
      thresholds.verificationMin <= 100 &&
      thresholds.duplicateSimilarity >= 0 &&
      thresholds.probableDuplicateSimilarity <= 1 &&
      thresholds.duplicateSimilarity <
        thresholds.probableDuplicateSimilarity
    )
  ) {
    throw new InvalidRelevancePolicyError("thresholds");
  }
  if (
    policy.topics.length === 0 ||
    new Set(policy.topics.map((topic) => topic.id)).size !==
      policy.topics.length ||
    policy.topics.some(
      (topic) =>
        topic.id.trim().length === 0 ||
        topic.aliases.length === 0 ||
        topic.aliases.some((alias) => alias.trim().length === 0),
    )
  ) {
    throw new InvalidRelevancePolicyError("topics");
  }
  for (const points of Object.values(policy.penaltyPoints)) {
    if (!Number.isInteger(points) || points < 0) {
      throw new InvalidRelevancePolicyError("penaltyPoints");
    }
  }
}

function validateRelevanceInput(
  input: RelevanceInput,
  policy: RelevancePolicy,
): {
  readonly eventAgeDays: number | null;
  readonly publicationAgeDays: number;
} {
  requireText("title", input.title);
  requireText("summary", input.summary);
  if (!RELEVANCE_SOURCE_TYPES.includes(input.sourceType)) {
    throw new UnsupportedSourceTypeError(String(input.sourceType));
  }
  if (!RELEVANCE_NOVELTY_TYPES.includes(input.noveltyType)) {
    throw new UnsupportedNoveltyTypeError(String(input.noveltyType));
  }
  if (
    !Number.isFinite(input.similarityToExisting) ||
    input.similarityToExisting < 0 ||
    input.similarityToExisting > 1
  ) {
    throw new InvalidRelevanceInputError("similarityToExisting");
  }
  assertBooleanFields(input);
  assertAllowedValues(
    "contentFormats",
    input.contentFormats,
    CONTENT_FORMATS,
  );
  assertAllowedValues(
    "commercialRelations",
    input.commercialRelations,
    COMMERCIAL_RELATIONS,
  );
  const topicIds = new Set(policy.topics.map((topic) => topic.id));
  if (
    !Array.isArray(input.informedTopics) ||
    input.informedTopics.some(
      (topic) => typeof topic !== "string" || !topicIds.has(topic),
    )
  ) {
    throw new InvalidRelevanceInputError("informedTopics");
  }

  const publishedAt = parseIsoDate("publishedAt", input.publishedAt);
  const evaluatedAt = parseIsoDate("evaluatedAt", input.evaluatedAt);
  if (publishedAt > evaluatedAt) {
    throw new InvalidDateRangeError("publishedAt");
  }
  const eventAt =
    input.eventAt === null ? null : parseIsoDate("eventAt", input.eventAt);
  if (eventAt !== null && eventAt > evaluatedAt) {
    throw new InvalidDateRangeError("eventAt");
  }

  return {
    eventAgeDays:
      eventAt === null
        ? null
        : differenceInDays(evaluatedAt, eventAt),
    publicationAgeDays: differenceInDays(evaluatedAt, publishedAt),
  };
}

function recognizeTopics(
  input: RelevanceInput,
  policy: RelevancePolicy,
): readonly string[] {
  const text = normalize(`${input.title} ${input.summary}`);
  const informed = new Set(input.informedTopics);
  return policy.topics
    .filter(
      (topic) =>
        informed.has(topic.id) ||
        topic.aliases.some((alias) => text.includes(normalize(alias))),
    )
    .map((topic) => topic.id);
}

function calculateCriteria(
  input: RelevanceInput,
  policy: RelevancePolicy,
  eventAgeDays: number | null,
  recognizedTopics: readonly string[],
): readonly RelevanceCriterionResult[] {
  const topicScore = Math.min(
    policy.weights.TOPIC_AFFINITY,
    recognizedTopics.length * 10,
  );
  const freshnessScore = freshnessFor(
    eventAgeDays,
    policy.weights.FRESHNESS,
  );
  const commercialScore = Math.min(
    policy.weights.COMMERCIAL_POTENTIAL,
    uniqueSum(input.commercialRelations, policy.commercialRelationScores),
  );
  const contentScore = Math.min(
    policy.weights.CONTENT_POTENTIAL,
    uniqueSum(input.contentFormats, policy.contentFormatScores),
  );

  return [
    criterion(
      "TOPIC_AFFINITY",
      topicScore,
      policy.weights.TOPIC_AFFINITY,
      topicScore === 0 ? "TOPIC_NONE" : "TOPICS_RECOGNIZED",
      topicScore === 0
        ? "No priority topic was recognized."
        : `${recognizedTopics.length} priority topic(s) recognized.`,
    ),
    criterion(
      "SOURCE_AUTHORITY",
      policy.sourceScores[input.sourceType],
      policy.weights.SOURCE_AUTHORITY,
      `SOURCE_${input.sourceType}`,
      `Source type ${input.sourceType} has a configured authority score.`,
    ),
    criterion(
      "FRESHNESS",
      freshnessScore,
      policy.weights.FRESHNESS,
      eventAgeDays === null ? "EVENT_DATE_MISSING" : freshnessReason(eventAgeDays),
      eventAgeDays === null
        ? "Event date was not supplied."
        : `Event age is ${eventAgeDays} complete day(s).`,
    ),
    criterion(
      "TECHNICAL_IMPACT",
      policy.noveltyScores[input.noveltyType],
      policy.weights.TECHNICAL_IMPACT,
      `NOVELTY_${input.noveltyType}`,
      `Novelty type ${input.noveltyType} has a configured impact score.`,
    ),
    criterion(
      "COMMERCIAL_POTENTIAL",
      commercialScore,
      policy.weights.COMMERCIAL_POTENTIAL,
      commercialScore === 0
        ? "COMMERCIAL_RELATION_NONE"
        : "COMMERCIAL_RELATIONS_RECOGNIZED",
      `${new Set(input.commercialRelations).size} commercial relation(s) supplied.`,
    ),
    criterion(
      "CONTENT_POTENTIAL",
      contentScore,
      policy.weights.CONTENT_POTENTIAL,
      contentScore === 0
        ? "CONTENT_FORMAT_NONE"
        : "CONTENT_FORMATS_RECOGNIZED",
      `${new Set(input.contentFormats).size} content format(s) supplied.`,
    ),
  ];
}

function calculatePenalties(
  input: RelevanceInput,
  policy: RelevancePolicy,
  eventAgeDays: number | null,
  publicationAgeDays: number,
  recognizedTopics: readonly string[],
): readonly RelevancePenalty[] {
  const penalties: RelevancePenalty[] = [];
  if (
    input.similarityToExisting >=
    policy.thresholds.probableDuplicateSimilarity
  ) {
    penalties.push(
      penalty(
        "PROBABLY_DUPLICATE",
        policy.penaltyPoints.probablyDuplicate,
        "Similarity indicates probable duplicate content.",
      ),
    );
  } else if (
    input.similarityToExisting >= policy.thresholds.duplicateSimilarity
  ) {
    penalties.push(
      penalty(
        "SIMILAR_CONTENT",
        policy.penaltyPoints.similarContent,
        "Similar content has already been found.",
      ),
    );
  }
  if (input.sourceType === "UNKNOWN") {
    penalties.push(
      penalty(
        "UNKNOWN_SOURCE",
        policy.penaltyPoints.unknownSource,
        "Source authority is unknown.",
      ),
    );
  }
  if (input.eventAt === null) {
    penalties.push(
      penalty(
        "MISSING_EVENT_DATE",
        policy.penaltyPoints.missingEventDate,
        "The event date was not supplied.",
      ),
    );
  }
  if (input.isSensationalist) {
    penalties.push(
      penalty(
        "SENSATIONALIST_TITLE",
        policy.penaltyPoints.sensationalistTitle,
        "The input marks the title as sensationalist.",
      ),
    );
  }
  if (input.isRumor) {
    penalties.push(
      penalty(
        "UNCONFIRMED_RUMOR",
        policy.penaltyPoints.unconfirmedRumor,
        "The information is an unconfirmed rumor.",
      ),
    );
  }
  if (input.isPromotional) {
    penalties.push(
      penalty(
        "PURELY_PROMOTIONAL",
        policy.penaltyPoints.purelyPromotional,
        "The content is marked as purely promotional.",
      ),
    );
  }
  if (recognizedTopics.length === 0) {
    penalties.push(
      penalty(
        "LOW_BRAND_AFFINITY",
        policy.penaltyPoints.lowBrandAffinity,
        "No priority topic connects the item to AndreStudio.dev.",
      ),
    );
  }
  if (
    eventAgeDays !== null &&
    eventAgeDays > policy.thresholds.oldEventDays &&
    publicationAgeDays <= policy.thresholds.recentPresentationDays
  ) {
    penalties.push(
      penalty(
        "OLD_NEWS_PRESENTED_AS_CURRENT",
        policy.penaltyPoints.oldNewsPresentedAsCurrent,
        "An old event was presented in a recent publication.",
      ),
    );
  }
  if (
    ["TUTORIAL", "OPINION", "NO_CONCRETE_NOVELTY"].includes(
      input.noveltyType,
    )
  ) {
    penalties.push(
      penalty(
        "NO_CONCRETE_NOVELTY",
        policy.penaltyPoints.noConcreteNovelty,
        "The item does not contain a concrete new development.",
      ),
    );
  }
  return penalties;
}

function criterion(
  criterionCode: RelevanceCriterion,
  score: number,
  maxScore: number,
  reasonCode: string,
  message: string,
): RelevanceCriterionResult {
  return {
    criterion: criterionCode,
    score: clamp(score, 0, maxScore),
    maxScore,
    reasons: [{ code: reasonCode, message }],
  };
}

function penalty(
  code: string,
  points: number,
  reason: string,
): RelevancePenalty {
  return { code, points, reason };
}

function freshnessFor(
  eventAgeDays: number | null,
  maxScore: number,
): number {
  if (eventAgeDays === null) return Math.min(8, maxScore);
  if (eventAgeDays <= 2) return maxScore;
  if (eventAgeDays <= 7) return Math.min(17, maxScore);
  if (eventAgeDays <= 30) return Math.min(13, maxScore);
  if (eventAgeDays <= 90) return Math.min(8, maxScore);
  if (eventAgeDays <= 180) return Math.min(4, maxScore);
  return 0;
}

function freshnessReason(eventAgeDays: number): string {
  if (eventAgeDays <= 2) return "EVENT_CURRENT";
  if (eventAgeDays <= 7) return "EVENT_RECENT";
  if (eventAgeDays <= 30) return "EVENT_THIS_MONTH";
  if (eventAgeDays <= 90) return "EVENT_AGING";
  return "EVENT_OLD";
}

function priorityFor(
  value: number,
  policy: RelevancePolicy,
): RelevancePriority {
  if (value >= policy.thresholds.criticalMin) return "CRITICAL";
  if (value >= policy.thresholds.highMin) return "HIGH";
  if (value >= policy.thresholds.mediumMin) return "MEDIUM";
  if (value >= policy.thresholds.lowMin) return "LOW";
  return "IGNORE";
}

function applyPriorityRestrictions(
  priority: RelevancePriority,
  input: RelevanceInput,
  eventAgeDays: number | null,
  publicationAgeDays: number,
  policy: RelevancePolicy,
): RelevancePriority {
  if (
    eventAgeDays !== null &&
    eventAgeDays > policy.thresholds.oldEventDays &&
    publicationAgeDays <= policy.thresholds.recentPresentationDays &&
    (priority === "CRITICAL" || priority === "HIGH")
  ) {
    return "MEDIUM";
  }
  if (input.sourceType === "UNKNOWN" && priority === "CRITICAL") {
    return "HIGH";
  }
  return priority;
}

function decisionFor(
  priority: RelevancePriority,
  isRumor: boolean,
): RelevanceDecision {
  if (priority === "CRITICAL") {
    return isRumor ? "CONTINUE_TO_VERIFICATION" : "FAST_TRACK";
  }
  if (priority === "HIGH") return "CONTINUE_TO_VERIFICATION";
  if (priority === "MEDIUM") return "HOLD_FOR_REVIEW";
  return "DISCARD_LOW_RELEVANCE";
}

function assertBooleanFields(input: RelevanceInput): void {
  for (const field of [
    "isRumor",
    "isPromotional",
    "isSensationalist",
  ] as const) {
    if (typeof input[field] !== "boolean") {
      throw new InvalidRelevanceInputError(field);
    }
  }
}

function assertAllowedValues<T extends string>(
  field: string,
  values: readonly T[],
  allowed: readonly T[],
): void {
  if (
    !Array.isArray(values) ||
    values.some((value) => !allowed.includes(value))
  ) {
    throw new InvalidRelevanceInputError(field);
  }
}

function parseIsoDate(field: string, value: string): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new InvalidRelevanceInputError(field);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new InvalidRelevanceInputError(field);
  }
  return timestamp;
}

function differenceInDays(later: number, earlier: number): number {
  return Math.floor((later - earlier) / DAY_IN_MILLISECONDS);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function requireText(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidRelevanceInputError(field);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidCriterionResult(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const criterion = value.criterion;
  const score = value.score;
  const maxScore = value.maxScore;
  return (
    typeof criterion === "string" &&
    RELEVANCE_CRITERIA.some((item) => item === criterion) &&
    typeof score === "number" &&
    Number.isFinite(score) &&
    typeof maxScore === "number" &&
    Number.isFinite(maxScore) &&
    score >= 0 &&
    score <= maxScore &&
    Array.isArray(value.reasons)
  );
}

function isValidPenalty(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    typeof value.reason === "string" &&
    typeof value.points === "number" &&
    Number.isFinite(value.points) &&
    value.points >= 0
  );
}

function uniqueSum<T extends string>(
  values: readonly T[],
  scores: Readonly<Record<T, number>>,
): number {
  return sum([...new Set(values)].map((value) => scores[value]));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
