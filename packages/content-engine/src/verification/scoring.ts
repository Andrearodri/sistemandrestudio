import { VerificationError } from "./errors.ts";
import type {
  ClaimVerificationResult, EvidenceAuthority, FactualVerificationResult,
  VerificationClaim, VerificationEvidence, VerificationPolicy,
  VerificationStatus,
} from "./types.ts";

export interface EvaluateVerificationInput {
  readonly verificationId: string;
  readonly newsId: string;
  readonly claims: readonly VerificationClaim[];
  readonly evidence: readonly VerificationEvidence[];
  readonly allowedSourceIds?: readonly string[] | undefined;
  readonly allowedSources?: readonly {
    readonly id: string;
    readonly allowedHosts: readonly string[];
  }[] | undefined;
  readonly policy: VerificationPolicy;
  readonly evaluatedAt: string;
}

export function evaluateVerification(
  input: EvaluateVerificationInput,
): FactualVerificationResult {
  validateInput(input);
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const claims = input.claims.map((claim) =>
    evaluateClaim(
      claim,
      input.evidence.filter((item) => item.claimId === claim.id),
      input.policy,
      evaluatedAt,
    ),
  );
  const primaryIds = new Set(
    input.claims.filter((claim) => claim.importance === "PRIMARY")
      .map((claim) => claim.id),
  );
  const primary = claims.filter((claim) => primaryIds.has(claim.claimId));
  const secondary = claims.filter((claim) => !primaryIds.has(claim.claimId));
  const contradiction = primary.some((claim) => claim.status === "CONTRADICTED");
  const outdated = primary.some((claim) => claim.status === "OUTDATED");
  const allPrimarySupported = primary.length > 0 &&
    primary.every((claim) => claim.status === "SUPPORTED");
  const secondaryMissing = secondary.some((claim) => claim.status !== "SUPPORTED");
  const noEvidence = input.evidence.length === 0;
  const anyPrimarySupport = primary.some((claim) =>
    claim.status === "SUPPORTED" || claim.status === "PARTIALLY_SUPPORTED"
  );
  const authority = Math.max(
    0,
    ...input.evidence
      .filter((item) => item.supportsClaim && !item.contradictsClaim)
      .map((item) => input.policy.authorityWeights[item.sourceAuthority]),
  );
  const claimCoverage = Math.round(
    claims.filter((claim) => claim.status === "SUPPORTED").length /
      Math.max(1, claims.length) * 100,
  );
  const datedEvidence = input.evidence.filter((item) =>
    item.eventDate !== undefined || item.publishedAt !== undefined
  ).length;
  const dateQuality = Math.round(
    datedEvidence / Math.max(1, input.evidence.length) * 100,
  );
  const contradictionPenalty = contradiction ? 100 : 0;
  let confidence = clamp(Math.round(
    claimCoverage * 0.5 + authority * 0.35 + dateQuality * 0.15 -
    contradictionPenalty,
  ));
  const status: VerificationStatus =
    contradiction ? "CONTRADICTED" :
    outdated ? "OUTDATED" :
    noEvidence ? "INSUFFICIENT_EVIDENCE" :
    allPrimarySupported && !secondaryMissing &&
      confidence >= input.policy.thresholds.confirmed ? "CONFIRMED" :
    anyPrimarySupport ? "PARTIALLY_CONFIRMED" : "UNCONFIRMED";
  if (status === "INSUFFICIENT_EVIDENCE") {
    confidence = Math.min(
      confidence,
      input.policy.thresholds.maximumInsufficientConfidence,
    );
  }
  if (status === "CONTRADICTED") confidence = 0;
  const editorialDecision =
    status === "CONFIRMED" ? "ALLOW_DRAFT_GENERATION" :
    status === "PARTIALLY_CONFIRMED" ? "REQUIRE_HUMAN_REVIEW" :
    status === "UNCONFIRMED" ? "BLOCK_UNCONFIRMED" :
    status === "CONTRADICTED" ? "BLOCK_CONTRADICTED" :
    status === "OUTDATED" ? "BLOCK_OUTDATED" :
    "BLOCK_INSUFFICIENT_EVIDENCE";
  const warnings = [
    ...(secondaryMissing ? [{
      code: "SECONDARY_CLAIM_UNSUPPORTED",
      message: "A secondary claim lacks sufficient official evidence.",
    }] : []),
    ...(input.evidence.some((item) => item.availableAt !== undefined &&
      Date.parse(item.availableAt) > evaluatedAt) ? [{
      code: "AVAILABILITY_IN_FUTURE",
      message: "Availability is announced for a future date.",
    }] : []),
  ];
  const blockingReasons = editorialDecision.startsWith("BLOCK_") ? [{
    code: `VERIFICATION_${status}`,
    message: `Verification status ${status} blocks editorial progression.`,
  }] : [];
  const orderedEvidence = [...input.evidence].sort((left, right) =>
    input.policy.authorityWeights[right.sourceAuthority] -
    input.policy.authorityWeights[left.sourceAuthority]
  );
  return {
    verificationId: input.verificationId,
    newsId: input.newsId,
    status,
    editorialDecision,
    confidence,
    confidenceBreakdown: {
      claimCoverage, authority, dateQuality, contradictionPenalty,
    },
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    evaluatedAt: input.evaluatedAt,
    claims,
    evidenceSummary: {
      total: input.evidence.length,
      supporting: input.evidence.filter((item) =>
        item.supportsClaim && !item.contradictsClaim
      ).length,
      contradicting: input.evidence.filter((item) =>
        item.contradictsClaim
      ).length,
      highestAuthority: orderedEvidence[0]?.sourceAuthority,
    },
    warnings,
    blockingReasons,
  };
}

function evaluateClaim(
  claim: VerificationClaim,
  evidence: readonly VerificationEvidence[],
  policy: VerificationPolicy,
  evaluatedAt: number,
): ClaimVerificationResult {
  const dateRequired = claim.type === "DATE_CLAIM" ||
    claim.type === "AVAILABILITY_CLAIM" ||
    claim.type === "PRODUCT_LAUNCH" ||
    claim.type === "MODEL_RELEASE" ||
    claim.type === "VERSION_RELEASE";
  const supporting = evidence.filter((item) =>
    item.supportsClaim && !item.contradictsClaim
      && (!dateRequired ||
        item.eventDate !== undefined ||
        item.availableAt !== undefined)
  );
  const contradicting = evidence.filter((item) => item.contradictsClaim);
  const outdated = supporting.some((item) =>
    item.supersededAt !== undefined &&
      Date.parse(item.supersededAt) <= evaluatedAt ||
    item.eventDate !== undefined &&
      Math.floor((evaluatedAt - Date.parse(item.eventDate)) / 86_400_000) >
        policy.thresholds.outdatedDays
  );
  const authority = Math.max(
    0,
    ...supporting.map((item) => policy.authorityWeights[item.sourceAuthority]),
  );
  const status =
    contradicting.length > 0 ? "CONTRADICTED" :
    outdated ? "OUTDATED" :
    supporting.length === 0 ? "UNSUPPORTED" :
    authority >= policy.thresholds.confirmed ? "SUPPORTED" :
    authority >= policy.thresholds.partial ? "PARTIALLY_SUPPORTED" :
    "UNSUPPORTED";
  return {
    claimId: claim.id,
    status,
    confidence:
      status === "CONTRADICTED" ? 0 :
      status === "OUTDATED" ? 20 :
      status === "UNSUPPORTED" ? 0 : clamp(authority),
    supportingEvidenceIds: supporting.map((item) => item.id).sort(),
    contradictingEvidenceIds: contradicting.map((item) => item.id).sort(),
    reasons: [`CLAIM_${status}`],
  };
}

function validateInput(input: EvaluateVerificationInput): void {
  requireIso("evaluatedAt", input.evaluatedAt);
  if (!input.verificationId || !input.newsId || input.claims.length === 0) {
    throw new VerificationError(
      "INVALID_VERIFICATION_INPUT",
      "Verification identity, news and claims are required.",
    );
  }
  if (
    input.policy.id !== "andre-studio-verification" ||
    input.policy.version !== "andre-studio-verification-v1" ||
    JSON.stringify(input.policy.authorityWeights) !== JSON.stringify({
      PRIMARY_OFFICIAL: 100,
      OFFICIAL_DOCUMENTATION: 90,
      OFFICIAL_CHANGELOG: 85,
      OFFICIAL_REPOSITORY: 80,
      OFFICIAL_BLOG: 75,
      SECONDARY_REPUTABLE: 50,
      COMMUNITY: 25,
      UNKNOWN: 0,
    }) ||
    JSON.stringify(input.policy.thresholds) !== JSON.stringify({
      confirmed: 75,
      partial: 50,
      outdatedDays: 90,
      maximumInsufficientConfidence: 25,
    })
  ) {
    throw new VerificationError(
      "INVALID_VERIFICATION_POLICY",
      "Unsupported or silently altered verification policy.",
    );
  }
  const claimIds = new Set<string>();
  for (const claim of input.claims) {
    if (!claim.id || !claim.text.trim() || claimIds.has(claim.id)) {
      throw new VerificationError("INVALID_CLAIM", "Claim is invalid.");
    }
    claimIds.add(claim.id);
    if (claim.expectedDate !== undefined) requireIso("expectedDate", claim.expectedDate);
  }
  for (const evidence of input.evidence) {
    if (!claimIds.has(evidence.claimId)) {
      throw new VerificationError(
        "CLAIM_EVIDENCE_MISMATCH",
        "Evidence references another claim.",
      );
    }
    const url = new URL(evidence.canonicalUrl);
    if (url.protocol !== "https:" || isPrivateHost(url.hostname)) {
      throw new VerificationError(
        "EVIDENCE_SOURCE_NOT_ALLOWED",
        "Evidence URL is outside the safe HTTPS boundary.",
      );
    }
    if (input.allowedSourceIds !== undefined &&
      !input.allowedSourceIds.includes(evidence.sourceId)) {
      throw new VerificationError(
        "EVIDENCE_SOURCE_NOT_ALLOWED",
        "Evidence source is outside the allow-list.",
      );
    }
    if (input.allowedSources !== undefined) {
      const source = input.allowedSources.find((item) =>
        item.id === evidence.sourceId
      );
      if (
        source === undefined ||
        !source.allowedHosts.some((host) =>
          url.hostname === host || url.hostname.endsWith(`.${host}`)
        )
      ) {
        throw new VerificationError(
          "EVIDENCE_SOURCE_NOT_ALLOWED",
          "Evidence URL host is outside its source allow-list.",
        );
      }
    }
    if (evidence.excerpt !== undefined && evidence.excerpt.length > 500) {
      throw new VerificationError("INVALID_EVIDENCE", "Excerpt is too long.");
    }
    if (JSON.stringify(evidence.structuredFacts).length > 10_000) {
      throw new VerificationError(
        "INVALID_EVIDENCE",
        "Structured facts exceed the size limit.",
      );
    }
    for (const date of [
      evidence.publishedAt, evidence.eventDate, evidence.updatedAt,
      evidence.supersededAt, evidence.availableAt, evidence.retrievedAt,
    ]) if (date !== undefined) requireIso("evidenceDate", date);
  }
}

function requireIso(field: string, value: string): void {
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    throw new VerificationError(
      "INVALID_VERIFICATION_DATE",
      `${field} must be an ISO UTC timestamp.`,
    );
  }
  if (canonical !== value) {
    throw new VerificationError(
      "INVALID_VERIFICATION_DATE",
      `${field} must be an ISO UTC timestamp.`,
    );
  }
}

function isPrivateHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]" || /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^fc/i.test(hostname) || /^fd/i.test(hostname) ||
    /^fe[89ab]/i.test(hostname);
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}
