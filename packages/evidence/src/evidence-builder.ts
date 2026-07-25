import { createHash } from "node:crypto";

import type {
  EvidenceAuthority,
  EvidenceType,
  VerificationClaim,
} from "../../content-engine/src/index.ts";
import type {
  EvidenceCandidate,
  EvidenceLimits,
  ExtractedOfficialPage,
} from "./types.ts";

export function buildEvidenceCandidates(
  sourceId: string,
  claims: readonly VerificationClaim[],
  pages: readonly ExtractedOfficialPage[],
  limits: EvidenceLimits,
): readonly EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const claim of claims) {
    for (const page of pages) {
      const association = associateClaim(claim, page);
      if (association === undefined) continue;
      const excerpt = selectExcerpt(claim, page, limits.maxExcerptLength);
      if (!excerpt) continue;
      const id = `evidence-${shortHash([
        claim.id,
        page.contentHash,
        association.rule,
      ])}`;
      const authority = authorityFor(page);
      const evidenceType = evidenceTypeFor(page);
      candidates.push({
        id: `candidate-${shortHash([id, page.relationship])}`,
        pageHash: page.contentHash,
        relationship: page.relationship,
        extractionMethod: "STATIC_HTML_METADATA_AND_BOUNDED_TEXT",
        associationRule: association.rule,
        associationConfidence: association.confidence,
        evidence: {
          id,
          claimId: claim.id,
          sourceId,
          canonicalUrl: page.canonicalUrl,
          sourceAuthority: authority,
          evidenceType,
          publishedAt: page.metadata.publishedAt,
          eventDate: page.metadata.publishedAt,
          updatedAt: page.metadata.updatedAt,
          availableAt: association.availableAt,
          retrievedAt: page.fetchedAt,
          excerpt,
          structuredFacts: {
            extractionMethod: "STATIC_HTML_METADATA_AND_BOUNDED_TEXT",
            associationRule: association.rule,
            associationConfidence: association.confidence,
            pageType: page.pageType,
            relationship: page.relationship,
            pageHash: page.contentHash,
            version: page.metadata.version,
            product: page.metadata.product,
            availability: page.metadata.availability,
          },
          supportsClaim: association.supports,
          contradictsClaim: association.contradicts,
        },
      });
      if (candidates.length >= limits.maxCandidateEvidence) {
        return candidates;
      }
    }
  }
  return candidates;
}

function associateClaim(
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
): {
  readonly rule: string;
  readonly confidence: number;
  readonly supports: boolean;
  readonly contradicts: boolean;
  readonly availableAt?: string | undefined;
} | undefined {
  const content = normalize(
    [
      page.title,
      page.metadata.heading,
      page.headings.join(" "),
      page.minimalText,
      page.metadata.product,
      page.metadata.version,
      page.metadata.availability,
    ].filter(Boolean).join(" "),
  );
  const claimText = normalize(claim.text);
  if (!hasSubjectOverlap(claim, claimText, content)) return undefined;

  const contradiction =
    /\b(not (?:yet )?available|unavailable|preview only|not generally available|removed|no longer supported|end of support)\b/.test(
      content,
    );
  if (contradiction) {
    return {
      rule: "EXPLICIT_OFFICIAL_CONTRADICTION",
      confidence: 95,
      supports: false,
      contradicts: true,
    };
  }

  switch (claim.type) {
    case "PRODUCT_LAUNCH":
    case "FEATURE_RELEASE": {
      if (
        /\b(launch(?:ed|es|ing)?|introduc(?:e|ed|ing)|announce[ds]?|released?|now available|general availability)\b/.test(
          content,
        ) &&
        page.metadata.publishedAt !== undefined &&
        page.pageType !== "UNKNOWN_OFFICIAL_PAGE"
      ) {
        return {
          rule: "OFFICIAL_LAUNCH_LANGUAGE_WITH_DATE",
          confidence: 90,
          supports: true,
          contradicts: false,
          availableAt: page.metadata.publishedAt,
        };
      }
      return undefined;
    }
    case "MODEL_RELEASE":
    case "VERSION_RELEASE": {
      const claimVersion = extractVersion(claim.text);
      const pageVersion = page.metadata.version ?? extractVersion(content);
      if (
        claimVersion !== undefined &&
        claimVersion === pageVersion &&
        [
          "OFFICIAL_CHANGELOG",
          "OFFICIAL_RELEASE",
          "OFFICIAL_REPOSITORY_RELEASE",
          "OFFICIAL_BLOG_POST",
        ].includes(page.pageType) &&
        page.metadata.publishedAt !== undefined
      ) {
        return {
          rule: "OFFICIAL_MATCHING_VERSION_RELEASE",
          confidence: 95,
          supports: true,
          contradicts: false,
        };
      }
      if (
        claimVersion !== undefined &&
        pageVersion !== undefined &&
        claimVersion !== pageVersion &&
        /\b(latest|current|released?)\b/.test(content)
      ) {
        return {
          rule: "OFFICIAL_VERSION_CONTRADICTION",
          confidence: 90,
          supports: false,
          contradicts: true,
        };
      }
      return undefined;
    }
    case "API_CHANGE": {
      const identifiers = technicalIdentifiers(claim.text);
      if (
        identifiers.length > 0 &&
        identifiers.some((identifier) => content.includes(identifier)) &&
        /\b(api|endpoint|request|response|parameter|method|behavior|breaking change)\b/.test(
          content,
        ) &&
        [
          "OFFICIAL_DOCUMENTATION",
          "OFFICIAL_CHANGELOG",
          "OFFICIAL_RELEASE",
        ].includes(page.pageType)
      ) {
        return {
          rule: "OFFICIAL_API_IDENTIFIER_MATCH",
          confidence: 85,
          supports: true,
          contradicts: false,
        };
      }
      return undefined;
    }
    case "DEPRECATION": {
      if (
        /\b(deprecat(?:e|ed|ion)|sunset|end of support|will be removed|removed in)\b/.test(
          content,
        )
      ) {
        return {
          rule: "EXPLICIT_OFFICIAL_DEPRECATION",
          confidence: 95,
          supports: true,
          contradicts: false,
        };
      }
      return undefined;
    }
    case "AVAILABILITY_CLAIM": {
      if (
        /\b(now available|generally available|general availability|available to|available in)\b/.test(
          content,
        ) ||
        page.metadata.availability !== undefined
      ) {
        return {
          rule: "EXPLICIT_OFFICIAL_AVAILABILITY",
          confidence: 90,
          supports: true,
          contradicts: false,
          availableAt: page.metadata.publishedAt,
        };
      }
      return undefined;
    }
    case "PERFORMANCE_CLAIM": {
      if (
        /\b(benchmark|methodology|test setup|measured|sample size)\b/.test(
          content,
        ) &&
        /(?:\b\d+(?:\.\d+)?(?:%|x|ms|s)\b)/.test(content)
      ) {
        return {
          rule: "STRUCTURED_PERFORMANCE_WITH_METHOD",
          confidence: 80,
          supports: true,
          contradicts: false,
        };
      }
      return undefined;
    }
    case "SECURITY_ADVISORY": {
      if (
        page.pageType === "OFFICIAL_SECURITY_ADVISORY" &&
        /\b(cve-\d{4}-\d+|vulnerability|security advisory|affected versions?)\b/.test(
          content,
        )
      ) {
        return {
          rule: "OFFICIAL_SECURITY_ADVISORY_MATCH",
          confidence: 95,
          supports: true,
          contradicts: false,
        };
      }
      return undefined;
    }
    case "DATE_CLAIM":
    case "GENERAL_FACT":
    case "POLICY_CHANGE":
    case "PRICE_CHANGE":
      return undefined;
  }
}

function hasSubjectOverlap(
  claim: VerificationClaim,
  claimText: string,
  content: string,
): boolean {
  const expected = claim.expectedSubject === undefined
    ? []
    : meaningfulTokens(normalize(claim.expectedSubject));
  const tokens = expected.length > 0
    ? expected
    : meaningfulTokens(claimText);
  if (tokens.length === 0) return false;
  const minimum = Math.min(2, tokens.length);
  return tokens.filter((token) => content.includes(token)).length >= minimum;
}

function selectExcerpt(
  claim: VerificationClaim,
  page: ExtractedOfficialPage,
  maximum: number,
): string {
  const fragments = page.minimalText.split("\n").filter(Boolean);
  const tokens = meaningfulTokens(
    normalize(claim.expectedSubject ?? claim.text),
  );
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

function technicalIdentifiers(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((token) =>
      token.startsWith("/") ||
      token.includes(".") ||
      token.includes("_") ||
      token.includes("-")
    )
    .filter((token) => token.length >= 3);
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

function extractVersion(value: string): string | undefined {
  return normalize(value).match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/)?.[1];
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function shortHash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex")
    .slice(0, 24);
}
