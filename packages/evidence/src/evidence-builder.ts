import { createHash } from "node:crypto";

import type {
  EvidenceAuthority,
  EvidenceType,
  VerificationClaim,
  VerificationEvidence,
} from "../../content-engine/src/index.ts";
import {
  matchEntity,
  normalizeEntity,
  normalizeVersion,
} from "./entity-normalizer.ts";
import type {
  AssociationScoreBreakdown,
  EntityMatchMethod,
  EvidenceAssociationDiagnosticReport,
  EvidenceCandidate,
  EvidenceCandidateDiagnostic,
  EvidenceDiagnosticCode,
  EvidenceLimits,
  ExtractedOfficialPage,
} from "./types.ts";

export function buildEvidenceCandidates(
  sourceId: string,
  claims: readonly VerificationClaim[],
  pages: readonly ExtractedOfficialPage[],
  limits: EvidenceLimits,
): readonly EvidenceCandidate[] {
  return diagnoseEvidenceAssociations(
    sourceId,
    claims,
    pages,
    limits,
    "APPLY_VALIDATED_IMPROVEMENTS",
  ).candidates
    .filter((candidate) => candidate.accepted && candidate.evidence !== undefined)
    .slice(0, limits.maxCandidateEvidence)
    .map((candidate) => ({
      id: `candidate-${shortHash([
        candidate.evidence!.id,
        candidate.relationship,
      ])}`,
      pageHash: pages.find((page) =>
        page.canonicalUrl === candidate.pageUrl &&
        page.relationship === candidate.relationship
      )!.contentHash,
      relationship: candidate.relationship,
      extractionMethod: "STATIC_HTML_METADATA_AND_BOUNDED_TEXT",
      associationRule: candidate.rule,
      associationConfidence: candidate.score.total,
      evidence: candidate.evidence!,
    }));
}

export function diagnoseEvidenceAssociations(
  sourceId: string,
  claims: readonly VerificationClaim[],
  pages: readonly ExtractedOfficialPage[],
  limits: EvidenceLimits,
  mode: EvidenceAssociationDiagnosticReport["mode"] = "DIAGNOSE_ONLY",
): EvidenceAssociationDiagnosticReport {
  const candidates = claims.flatMap((claim) =>
    pages.map((page) => diagnoseCandidate(sourceId, claim, page, limits))
  );
  const accepted = candidates.filter((candidate) => candidate.accepted);
  const claimReports = claims.map((claim) => {
    const entities = claimEntities(claim);
    const codes: EvidenceDiagnosticCode[] = [];
    if (entities.length === 0) codes.push("CLAIM_ENTITY_MISSING");
    if (claim.type === "GENERAL_FACT") codes.push("CLAIM_TYPE_UNSUPPORTED");
    if (meaningfulTokens(normalize(claim.text)).length < 2) {
      codes.push("CLAIM_TOO_GENERIC");
    }
    if (
      claim.type === "VERSION_RELEASE" &&
      normalizeVersion(claim.text) === undefined
    ) {
      codes.push("CLAIM_VERSION_MISSING");
    }
    return {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      importance: claim.importance,
      entities,
      version: normalizeVersion(claim.text),
      codes,
    };
  });
  const blockerCounts = new Map<EvidenceDiagnosticCode, number>();
  for (const candidate of candidates.filter((item) => !item.accepted)) {
    blockerCounts.set(candidate.code, (blockerCounts.get(candidate.code) ?? 0) + 1);
  }
  const primaryBlocker = [...blockerCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    [0]?.[0] ?? "NONE";

  return {
    mode,
    claims: claimReports,
    candidates,
    funnel: {
      claimsCreated: claims.length,
      candidatesExtracted: candidates.length,
      typeCompatible: candidates.filter((candidate) =>
        !["CLAIM_TYPE_UNSUPPORTED", "PAGE_TYPE_NOT_ELIGIBLE"].includes(
          candidate.code,
        )
      ).length,
      entityCompatible: candidates.filter((candidate) =>
        candidate.entityMatch !== "NO_MATCH" &&
        candidate.code !== "CLAIM_TYPE_UNSUPPORTED" &&
        candidate.code !== "PAGE_TYPE_NOT_ELIGIBLE"
      ).length,
      dateCompatible: candidates.filter((candidate) =>
        candidate.entityMatch !== "NO_MATCH" &&
        !["CLAIM_TYPE_UNSUPPORTED", "PAGE_TYPE_NOT_ELIGIBLE",
          "EVENT_DATE_AMBIGUOUS", "PAGE_DATE_NOT_MATCHED",
          "CLAIM_DATE_MISSING"].includes(candidate.code)
      ).length,
      accepted: accepted.length,
      evidencePersistable: Math.min(
        accepted.length,
        limits.maxCandidateEvidence,
      ),
    },
    primaryBlocker,
  };
}

function diagnoseCandidate(
  sourceId: string,
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
  limits: EvidenceLimits,
): EvidenceCandidateDiagnostic {
  const content = normalize([
    page.title,
    page.metadata.heading,
    page.headings.join(" "),
    page.summary,
    page.minimalText,
    page.metadata.product,
    page.metadata.version,
    page.metadata.availability,
  ].filter(Boolean).join(" "));
  const entities = claimEntities(claim);
  const pageEntities = pageEntityCandidates(page);
  const entityResult = bestEntityMatch(entities, pageEntities);
  const base = {
    claimId: claim.id,
    claimType: claim.type,
    pageUrl: page.canonicalUrl,
    pageType: page.pageType,
    relationship: page.relationship,
    entityMatch: entityResult.method,
    claimEntities: entities,
    pageEntities,
    matchedEntities: entityResult.page === undefined
      ? []
      : [entityResult.page],
    dates: {
      expected: claim.expectedDate,
      published: page.metadata.publishedAt,
      updated: page.metadata.updatedAt,
    },
  };

  if (claim.type === "GENERAL_FACT" || unsupportedType(claim.type)) {
    return rejected(
      base,
      "UNSUPPORTED_CLAIM_TYPE",
      "CLAIM_TYPE_UNSUPPORTED",
      "The deterministic association policy does not accept this claim type.",
      ["supportedClaimType"],
      score(entityResult.method, page, false, false, [
        { code: "CLAIM_TYPE_UNSUPPORTED", value: -100 },
      ]),
    );
  }
  if (entities.length === 0) {
    return rejected(
      base,
      "CLAIM_REQUIRES_ENTITY",
      "CLAIM_ENTITY_MISSING",
      "The claim has no explicit subject or technical entity.",
      ["expectedSubject"],
      score(entityResult.method, page, false, false),
    );
  }
  if (entityResult.method === "NO_MATCH") {
    return rejected(
      base,
      "ENTITY_REQUIRED",
      "PAGE_ENTITY_NOT_MATCHED",
      "No explainable entity match was found between claim and page.",
      ["matchingEntity"],
      score(entityResult.method, page, true, false, [
        { code: "PAGE_ENTITY_NOT_MATCHED", value: -50 },
      ]),
    );
  }

  const contradiction = explicitContradiction(content);
  if (contradiction) {
    return acceptedDiagnostic(
      sourceId,
      claim,
      page,
      limits,
      base,
      "EXPLICIT_OFFICIAL_CONTRADICTION",
      entityResult.method,
      false,
      true,
      page.metadata.publishedAt,
      score(entityResult.method, page, true, true),
    );
  }
  if (!pageTypeEligible(claim, page)) {
    return rejected(
      base,
      "PAGE_TYPE_COMPATIBILITY",
      "PAGE_TYPE_NOT_ELIGIBLE",
      "The page type is not eligible for this claim type.",
      ["eligiblePageType"],
      score(entityResult.method, page, false, false, [
        { code: "PAGE_TYPE_NOT_ELIGIBLE", value: -30 },
      ]),
    );
  }

  const explicitLanguage = hasExplicitLanguage(claim, content);
  const date = associationDate(claim, page, content);
  if (date.required && date.value === undefined) {
    return rejected(
      base,
      "DATE_INVARIANT",
      date.code,
      date.reason,
      ["eventDate"],
      score(entityResult.method, page, true, explicitLanguage, [
        { code: date.code, value: -20 },
      ]),
    );
  }

  const claimVersion = normalizeVersion(claim.text);
  const pageVersionMatches = claimVersion !== undefined &&
    versionAppears(
      claimVersion,
      `${page.metadata.version ?? ""} ${page.title} ${page.summary} ${page.minimalText}`,
    );
  if (
    claim.type === "VERSION_RELEASE" &&
    (claimVersion === undefined || !pageVersionMatches)
  ) {
    return rejected(
      base,
      "VERSION_INVARIANT",
      "CLAIM_VERSION_MISSING",
      "A version release requires a normalized version on both sides.",
      ["matchingVersion"],
      score(entityResult.method, page, true, explicitLanguage),
    );
  }
  if (claim.type === "PERFORMANCE_CLAIM" && !performanceProof(content)) {
    return rejected(
      base,
      "PERFORMANCE_REQUIRES_METRIC_AND_METHOD",
      promotional(content)
        ? "CONTENT_PROMOTIONAL_ONLY"
        : "PERFORMANCE_PROOF_MISSING",
      "Performance requires a numeric metric and explicit methodology.",
      ["metric", "methodology"],
      score(entityResult.method, page, true, false, [
        {
          code: promotional(content)
            ? "CONTENT_PROMOTIONAL_ONLY"
            : "PERFORMANCE_PROOF_MISSING",
          value: -50,
        },
      ]),
    );
  }
  if (
    claim.type === "AVAILABILITY_CLAIM" &&
    !explicitAvailability(content)
  ) {
    return rejected(
      base,
      "AVAILABILITY_REQUIRES_EXPLICIT_STATUS",
      "AVAILABILITY_PROOF_MISSING",
      "Availability status is not explicit enough for the claim.",
      ["availabilityStatus"],
      score(entityResult.method, page, true, false, [
        { code: "AVAILABILITY_PROOF_MISSING", value: -40 },
      ]),
    );
  }
  if (!explicitLanguage) {
    return rejected(
      base,
      "EXPLICIT_FACT_LANGUAGE",
      "EVIDENCE_TEXT_NOT_SPECIFIC",
      "The page lacks the explicit language required by this claim type.",
      ["explicitFactLanguage"],
      score(entityResult.method, page, true, false, [
        { code: "EVIDENCE_TEXT_NOT_SPECIFIC", value: -30 },
      ]),
    );
  }

  const associationScore = score(
    entityResult.method,
    page,
    true,
    true,
  );
  const minimumScore = claim.type === "PERFORMANCE_CLAIM" ? 55 : 70;
  if (associationScore.total < minimumScore) {
    return rejected(
      base,
      "MINIMUM_ASSOCIATION_SCORE",
      "ASSOCIATION_SCORE_TOO_LOW",
      "The explainable association score is below the minimum.",
      ["associationScore"],
      associationScore,
    );
  }

  return acceptedDiagnostic(
    sourceId,
    claim,
    page,
    limits,
    base,
    associationRule(claim),
    entityResult.method,
    true,
    false,
    date.value,
    associationScore,
  );
}

function acceptedDiagnostic(
  sourceId: string,
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
  limits: EvidenceLimits,
  base: Omit<EvidenceCandidateDiagnostic,
    "rule" | "accepted" | "code" | "reason" | "missingFields" | "score" |
    "evidence">,
  rule: string,
  method: EntityMatchMethod,
  supports: boolean,
  contradicts: boolean,
  eventDate: string | undefined,
  associationScore: AssociationScoreBreakdown,
): EvidenceCandidateDiagnostic {
  const excerpt = selectExcerpt(claim, page, limits.maxExcerptLength);
  const evidenceId = `evidence-${shortHash([
    claim.id,
    page.contentHash,
    rule,
  ])}`;
  const evidence: VerificationEvidence = {
    id: evidenceId,
    claimId: claim.id,
    sourceId,
    canonicalUrl: page.canonicalUrl,
    sourceAuthority: authorityFor(page),
    evidenceType: evidenceTypeFor(page),
    publishedAt: page.metadata.publishedAt,
    eventDate,
    updatedAt: page.metadata.updatedAt,
    availableAt: claim.type === "AVAILABILITY_CLAIM" ? eventDate : undefined,
    retrievedAt: page.fetchedAt,
    excerpt,
    structuredFacts: {
      extractionMethod: "STATIC_HTML_METADATA_AND_BOUNDED_TEXT",
      associationRule: rule,
      associationScore,
      entityMatchMethod: method,
      pageType: page.pageType,
      relationship: page.relationship,
      pageHash: page.contentHash,
      version: page.metadata.version,
      product: page.metadata.product,
      availability: page.metadata.availability,
      eventDateBasis: eventDate === page.metadata.publishedAt
        ? "PUBLICATION_DATE_WITH_EXPLICIT_EVENT_LANGUAGE"
        : eventDate === undefined ? "NONE" : "EXPLICIT_EXPECTED_DATE",
    },
    supportsClaim: supports,
    contradictsClaim: contradicts,
  };
  return {
    ...base,
    dates: { ...base.dates, event: eventDate },
    rule,
    accepted: true,
    code: "ACCEPTED",
    reason: contradicts
      ? "An explicit official contradiction matched the claim entity."
      : "All mandatory invariants and the minimum score were satisfied.",
    missingFields: [],
    score: associationScore,
    evidence,
  };
}

function rejected(
  base: Omit<EvidenceCandidateDiagnostic,
    "rule" | "accepted" | "code" | "reason" | "missingFields" | "score" |
    "evidence">,
  rule: string,
  code: EvidenceDiagnosticCode,
  reason: string,
  missingFields: readonly string[],
  breakdown: AssociationScoreBreakdown,
): EvidenceCandidateDiagnostic {
  return {
    ...base,
    rule,
    accepted: false,
    code,
    reason,
    missingFields,
    score: breakdown,
  };
}

function claimEntities(claim: VerificationClaim): string[] {
  if (claim.expectedSubject?.trim()) return [claim.expectedSubject.trim()];
  const identifiers = claim.text.match(
    /`([^`]{2,80})`|\b([A-Z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+)\b/g,
  ) ?? [];
  return [...new Set(identifiers.map((value) => value.replaceAll("`", "")))];
}

function pageEntityCandidates(page: ExtractedOfficialPage): string[] {
  const candidates = [
    page.metadata.product,
    page.metadata.organization,
    ...page.title.split(/[:|,—]/).slice(0, 2),
    ...page.headings.slice(0, 5).flatMap((heading) =>
      heading.split(/[:|,—]/).slice(0, 1)
    ),
  ].filter((value): value is string => Boolean(value?.trim()));
  const technical = `${page.title} ${page.summary} ${page.minimalText}`
    .match(/\b[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)+\b/g) ?? [];
  const properIdentifiers =
    `${page.title} ${page.summary} ${page.headings.join(" ")}`
      .match(/\b[A-Z][A-Za-z0-9]{2,}\b/g)
      ?.filter((value) =>
        !["The", "This", "With", "Part", "Blog", "Google", "Developers"]
          .includes(value)
      ) ?? [];
  return [...new Set(
    [...candidates, ...technical, ...properIdentifiers]
      .map((value) => value.trim()),
  )]
    .slice(0, 30);
}

function bestEntityMatch(
  entities: readonly string[],
  pageEntities: readonly string[],
) {
  const priority: Record<EntityMatchMethod, number> = {
    EXACT_IDENTIFIER: 4,
    NORMALIZED_EXACT: 3,
    EXPLICIT_ALIAS: 2,
    PARTIAL_UNIQUE_MATCH: 1,
    NO_MATCH: 0,
  };
  return entities
    .map((entity) => matchEntity(entity, pageEntities))
    .sort((left, right) => priority[right.method] - priority[left.method])[0] ??
    { method: "NO_MATCH" as const, claim: "" };
}

function unsupportedType(type: VerificationClaim["type"]): boolean {
  return ["DATE_CLAIM", "GENERAL_FACT", "POLICY_CHANGE", "PRICE_CHANGE"]
    .includes(type);
}

function pageTypeEligible(
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
): boolean {
  if (page.pageType === "UNKNOWN_OFFICIAL_PAGE") {
    return claim.type === "PERFORMANCE_CLAIM";
  }
  if (claim.type === "API_CHANGE") {
    return ["OFFICIAL_DOCUMENTATION", "OFFICIAL_CHANGELOG", "OFFICIAL_RELEASE"]
      .includes(page.pageType);
  }
  if (claim.type === "VERSION_RELEASE" || claim.type === "MODEL_RELEASE") {
    return [
      "OFFICIAL_CHANGELOG", "OFFICIAL_RELEASE",
      "OFFICIAL_REPOSITORY_RELEASE", "OFFICIAL_BLOG_POST",
    ].includes(page.pageType);
  }
  if (claim.type === "SECURITY_ADVISORY") {
    return page.pageType === "OFFICIAL_SECURITY_ADVISORY";
  }
  return true;
}

function hasExplicitLanguage(
  claim: VerificationClaim,
  content: string,
): boolean {
  switch (claim.type) {
    case "PRODUCT_LAUNCH":
    case "FEATURE_RELEASE":
    case "MODEL_RELEASE":
    case "VERSION_RELEASE":
      return /\b(launch(?:ed|es|ing)?|introduc(?:e|es|ed|ing)|announce[ds]?|released?|now available|general availability|meet)\b/.test(
        content,
      );
    case "API_CHANGE":
      return /\b(api|endpoint|request|response|parameter|method|behavior|breaking change)\b/.test(
        content,
      ) &&
        /\b(add(?:ed)?|chang(?:e|ed)|remove[sd]?|support(?:ed|s)?|deprecat\w*)\b/.test(
          content,
        );
    case "DEPRECATION":
      return /\b(deprecat(?:e|ed|ion)|sunset|end of support|will be removed|removed in)\b/.test(
        content,
      );
    case "AVAILABILITY_CLAIM":
      return explicitAvailability(content);
    case "PERFORMANCE_CLAIM":
      return performanceProof(content);
    case "SECURITY_ADVISORY":
      return /\b(cve-\d{4}-\d+|vulnerability|security advisory|affected versions?)\b/.test(
        content,
      );
    case "DATE_CLAIM":
    case "GENERAL_FACT":
    case "POLICY_CHANGE":
    case "PRICE_CHANGE":
      return false;
  }
}

function associationDate(
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
  content: string,
): {
  readonly required: boolean;
  readonly value?: string | undefined;
  readonly code: "EVENT_DATE_AMBIGUOUS" | "PAGE_DATE_NOT_MATCHED";
  readonly reason: string;
} {
  const required = [
    "PRODUCT_LAUNCH", "MODEL_RELEASE", "VERSION_RELEASE",
    "AVAILABILITY_CLAIM", "DATE_CLAIM",
  ].includes(claim.type);
  if (!required) {
    return {
      required: false,
      value: claim.expectedDate,
      code: "EVENT_DATE_AMBIGUOUS",
      reason: "",
    };
  }
  if (claim.expectedDate !== undefined) {
    if (
      page.metadata.publishedAt !== undefined &&
      claim.expectedDate.slice(0, 10) !== page.metadata.publishedAt.slice(0, 10)
    ) {
      return {
        required: true,
        code: "PAGE_DATE_NOT_MATCHED",
        reason: "The explicit expected date does not match the official record.",
      };
    }
    return {
      required: true,
      value: claim.expectedDate,
      code: "PAGE_DATE_NOT_MATCHED",
      reason: "",
    };
  }
  if (
    page.metadata.publishedAt !== undefined &&
    /\b(launch(?:ed)?|introduc(?:e|es|ed|ing)|announce[ds]?|released?|now available|general availability)\b/.test(
      content,
    )
  ) {
    return {
      required: true,
      value: page.metadata.publishedAt,
      code: "EVENT_DATE_AMBIGUOUS",
      reason: "",
    };
  }
  return {
    required: true,
    code: "EVENT_DATE_AMBIGUOUS",
    reason:
      "Publication date cannot be used as event date without explicit event language.",
  };
}

function explicitContradiction(content: string): boolean {
  return /\b(not (?:yet )?available|unavailable|preview only|not generally available|removed|no longer supported|end of support)\b/.test(
    content,
  );
}

function explicitAvailability(content: string): boolean {
  return /\b(now available|generally available|general availability|available to|available in)\b/.test(
    content,
  );
}

function performanceProof(content: string): boolean {
  return /\b(benchmark|methodology|test setup|measured|sample size)\b/.test(
    content,
  ) && /(?:\b\d+(?:\.\d+)?(?:%|x|ms|s)\b)/.test(content);
}

function versionAppears(expected: string, value: string): boolean {
  const candidates = [
    ...value.matchAll(/\b(?:version\s*)?v?(\d+(?:\.\d+){0,2})\b/gi),
  ].map((match) => normalizeVersion(match[0]))
    .filter((version): version is string => version !== undefined);
  return candidates.includes(expected);
}

function promotional(content: string): boolean {
  return /\b(amazing|revolutionary|unmatched|fastest|incredible|game-changing)\b/.test(
    content,
  ) && !performanceProof(content);
}

function score(
  method: EntityMatchMethod,
  page: ExtractedOfficialPage,
  typeCompatible: boolean,
  explicitLanguage: boolean,
  penalties: AssociationScoreBreakdown["penalties"] = [],
): AssociationScoreBreakdown {
  const entity = {
    EXACT_IDENTIFIER: 35,
    NORMALIZED_EXACT: 32,
    EXPLICIT_ALIAS: 30,
    PARTIAL_UNIQUE_MATCH: 22,
    NO_MATCH: 0,
  }[method];
  const pageType = typeCompatible ? 15 : 0;
  const date = page.metadata.publishedAt === undefined ? 0 : 10;
  const language = explicitLanguage ? 20 : 0;
  const authority = authorityFor(page) === "UNKNOWN" ? 0 : 20;
  return {
    entity,
    pageType,
    date,
    explicitLanguage: language,
    authority,
    penalties,
    total: Math.max(
      0,
      Math.min(
        100,
        entity + pageType + date + language + authority +
          penalties.reduce((sum, penalty) => sum + penalty.value, 0),
      ),
    ),
  };
}

function associationRule(claim: VerificationClaim): string {
  switch (claim.type) {
    case "PRODUCT_LAUNCH":
    case "FEATURE_RELEASE":
      return "OFFICIAL_LAUNCH_LANGUAGE_WITH_DATE";
    case "MODEL_RELEASE":
    case "VERSION_RELEASE":
      return "OFFICIAL_MATCHING_VERSION_RELEASE";
    case "API_CHANGE":
      return "OFFICIAL_API_IDENTIFIER_MATCH";
    case "DEPRECATION":
      return "EXPLICIT_OFFICIAL_DEPRECATION";
    case "AVAILABILITY_CLAIM":
      return "EXPLICIT_OFFICIAL_AVAILABILITY";
    case "PERFORMANCE_CLAIM":
      return "STRUCTURED_PERFORMANCE_WITH_METHOD";
    case "SECURITY_ADVISORY":
      return "OFFICIAL_SECURITY_ADVISORY_MATCH";
    case "DATE_CLAIM":
    case "GENERAL_FACT":
    case "POLICY_CHANGE":
    case "PRICE_CHANGE":
      return "UNSUPPORTED_CLAIM_TYPE";
  }
}

function selectExcerpt(
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
  maximum: number,
): string {
  const fragments = page.minimalText.split("\n").filter(Boolean);
  const tokens = meaningfulTokens(normalize(claim.expectedSubject ?? claim.text));
  const selected = fragments.find((fragment) => {
    const normalized = normalize(fragment);
    return tokens.some((token) => normalized.includes(token));
  }) ?? page.summary ?? page.title;
  return selected.length <= maximum ? selected : selected.slice(0, maximum);
}

function authorityFor(page: ExtractedOfficialPage): EvidenceAuthority {
  switch (page.pageType) {
    case "OFFICIAL_DOCUMENTATION":
      return "OFFICIAL_DOCUMENTATION";
    case "OFFICIAL_CHANGELOG":
      return "OFFICIAL_CHANGELOG";
    case "OFFICIAL_REPOSITORY_RELEASE":
      return "OFFICIAL_REPOSITORY";
    case "OFFICIAL_BLOG_POST":
      return "OFFICIAL_BLOG";
    case "OFFICIAL_RELEASE":
    case "OFFICIAL_SECURITY_ADVISORY":
      return "PRIMARY_OFFICIAL";
    case "UNKNOWN_OFFICIAL_PAGE":
      return "UNKNOWN";
  }
}

function evidenceTypeFor(page: ExtractedOfficialPage): EvidenceType {
  switch (page.pageType) {
    case "OFFICIAL_DOCUMENTATION":
      return "DOCUMENTATION";
    case "OFFICIAL_CHANGELOG":
      return "CHANGELOG";
    case "OFFICIAL_REPOSITORY_RELEASE":
      return "REPOSITORY_RELEASE";
    case "OFFICIAL_BLOG_POST":
      return "BLOG_ANNOUNCEMENT";
    case "OFFICIAL_SECURITY_ADVISORY":
      return "SECURITY_ADVISORY";
    case "OFFICIAL_RELEASE":
      return "RELEASE_NOTE";
    case "UNKNOWN_OFFICIAL_PAGE":
      return "OTHER";
  }
}

function meaningfulTokens(value: string): string[] {
  const ignored = new Set([
    "about", "after", "available", "claim", "feature", "from", "general",
    "into", "launch", "model", "official", "product", "release", "that",
    "the", "this", "version", "with", "para", "como", "uma", "novo", "nova",
  ]);
  return [...new Set(
    value.split(/[^a-z0-9._/-]+/)
      .filter((token) => token.length >= 3 && !ignored.has(token)),
  )];
}

function normalize(value: string): string {
  return normalizeEntity(value).replace(/\s+/g, " ").trim();
}

function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex")
    .slice(0, 24);
}
