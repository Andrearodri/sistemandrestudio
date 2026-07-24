import type { VerificationPolicy } from "./types.ts";

export const ANDRE_STUDIO_VERIFICATION_POLICY_V1 = {
  id: "andre-studio-verification",
  version: "andre-studio-verification-v1",
  authorityWeights: {
    PRIMARY_OFFICIAL: 100,
    OFFICIAL_DOCUMENTATION: 90,
    OFFICIAL_CHANGELOG: 85,
    OFFICIAL_REPOSITORY: 80,
    OFFICIAL_BLOG: 75,
    SECONDARY_REPUTABLE: 50,
    COMMUNITY: 25,
    UNKNOWN: 0,
  },
  thresholds: {
    confirmed: 75,
    partial: 50,
    outdatedDays: 90,
    maximumInsufficientConfidence: 25,
  },
} as const satisfies VerificationPolicy;
