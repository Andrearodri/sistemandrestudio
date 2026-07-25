import type { EvidenceLimits } from "./types.ts";

export const OFFICIAL_EVIDENCE_POLICY_VERSION =
  "official-evidence-acquisition-v3";

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  maxItemsPerRun: 5,
  maxPagesPerItem: 3,
  maxRelatedPages: 2,
  maxDepth: 1,
  maxResponseBytes: 1_000_000,
  requestTimeoutMs: 20_000,
  itemTimeoutMs: 60_000,
  maxRedirects: 2,
  maxRetries: 1,
  maxTitleLength: 300,
  maxSummaryLength: 1_500,
  maxExcerptLength: 500,
  maxCandidateEvidence: 20,
  maxHeadings: 20,
  maxMinimalTextLength: 6_000,
};
