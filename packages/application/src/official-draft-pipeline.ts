import { createHash } from "node:crypto";
import type { EditorialState, VerificationStatus } from "../../content-engine/src/index.ts";

export const OFFICIAL_DRAFT_PIPELINE_POLICY = {
  id: "andre-studio-official-draft-pipeline",
  version: "andre-studio-official-draft-pipeline-v1",
  maximumItems: 10,
} as const;

export type OfficialDraftIneligibilityCode =
  | "EDITORIAL_STATE_NOT_VERIFIED"
  | "VERIFICATION_HISTORICAL_ONLY"
  | "AGGREGATE_TERMINAL"
  | "CURRENT_VERIFICATION_MISSING"
  | "CONFIRMED_CLAIMS_MISSING"
  | "DRAFT_ALREADY_EXISTS";

export interface OfficialItemLogicalIdentityInput {
  readonly sourceId: string;
  readonly externalId?: string | undefined;
  readonly canonicalUrl: string;
  readonly contentHash: string;
  readonly eventIdentity?: string | undefined;
}

export function officialItemLogicalIdentity(input: OfficialItemLogicalIdentityInput): string {
  const normalized = {
    sourceId: input.sourceId.trim().toLowerCase(),
    externalId: input.externalId?.trim() ?? "",
    canonicalUrl: canonicalUrl(input.canonicalUrl),
    contentHash: input.contentHash.trim().toLowerCase(),
    eventIdentity: input.eventIdentity?.trim() ?? "",
    policyVersion: OFFICIAL_DRAFT_PIPELINE_POLICY.version,
  };
  return `official-item-${createHash("sha256").update(stableJson(normalized)).digest("hex").slice(0, 24)}`;
}

export function diagnoseOfficialDraftEligibility(input: {
  readonly state: EditorialState;
  readonly latestVerificationStatus?: VerificationStatus | undefined;
  readonly latestVerificationIsCurrent: boolean;
  readonly confirmedClaims: number;
  readonly draftExists: boolean;
}): OfficialDraftIneligibilityCode | "ELIGIBLE" {
  if (input.draftExists) return "DRAFT_ALREADY_EXISTS";
  if (input.latestVerificationStatus === undefined) return "CURRENT_VERIFICATION_MISSING";
  if (!input.latestVerificationIsCurrent && input.latestVerificationStatus === "CONFIRMED") return "VERIFICATION_HISTORICAL_ONLY";
  if (["DUPLICATE", "DISCARDED_LOW_RELEVANCE", "VERIFICATION_REJECTED", "REJECTED", "READY_FOR_PUBLICATION"].includes(input.state)) return "AGGREGATE_TERMINAL";
  if (input.state !== "VERIFIED") return "EDITORIAL_STATE_NOT_VERIFIED";
  if (input.latestVerificationStatus !== "CONFIRMED" || input.confirmedClaims === 0) return "CONFIRMED_CLAIMS_MISSING";
  return "ELIGIBLE";
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
function stableJson(value: Readonly<Record<string, string>>): string {
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`).join(",")}}`;
}
