import { createHash } from "node:crypto";

import {
  getOfficialSource,
} from "../../sources/src/index.ts";
import type {
  EvidenceAcquisitionInput,
  ExtractedOfficialPage,
} from "./types.ts";
import type { VerificationClaim } from "../../content-engine/src/index.ts";

export const EVIDENCE_IDENTITY_VERSION = "evidence-content-identity-v1";

export interface EvidenceContentIdentity {
  readonly version: typeof EVIDENCE_IDENTITY_VERSION;
  readonly hash: string;
}

export function deriveEvidenceContentIdentity(input: {
  readonly itemId: string;
  readonly canonicalUrl: string;
  readonly pages: readonly ExtractedOfficialPage[];
  readonly acquisitionPolicyVersion: string;
  readonly sourcePolicyVersion: string;
  readonly claims?: readonly VerificationClaim[];
}): EvidenceContentIdentity {
  const pages = input.pages
    .map((page) => ({
      canonicalUrl: canonicalUrl(page.canonicalUrl),
      relationship: page.relationship,
      contentHash: page.contentHash,
    }))
    .sort((left, right) =>
      `${left.relationship}:${left.canonicalUrl}`.localeCompare(
        `${right.relationship}:${right.canonicalUrl}`,
      )
    );
  return {
    version: EVIDENCE_IDENTITY_VERSION,
    hash: sha256(stableJson({
      identityVersion: EVIDENCE_IDENTITY_VERSION,
      itemId: input.itemId,
      canonicalUrl: canonicalUrl(input.canonicalUrl),
      acquisitionPolicyVersion: input.acquisitionPolicyVersion,
      sourcePolicyVersion: input.sourcePolicyVersion,
      claims: (input.claims ?? []).map((claim) => ({
        text: claim.text,
        type: claim.type,
        expectedSubject: claim.expectedSubject,
      })),
      pages,
    })),
  };
}

export function deriveContentVersionedInput(
  input: EvidenceAcquisitionInput,
  identity: EvidenceContentIdentity,
  currentVersion: number,
): EvidenceAcquisitionInput {
  const suffix = identity.hash.slice(0, 24);
  return {
    ...input,
    acquisitionId: `acquisition-${suffix}`,
    verificationId: `verification-${suffix}`,
    commandId: `evidence-command-${suffix}`,
    idempotencyKey: `evidence-content:${identity.hash}`,
    expectedVersion: currentVersion,
    identityMode: "CONTENT_VERSIONED",
    claims: input.claims.map((claim) => ({
      ...claim,
      id: `${claim.id}-v-${suffix}`,
    })),
  };
}

export interface OperationalEvidenceItem {
  readonly id: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly contentHash: string;
  readonly externalId?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly collectedAt: string;
  readonly sourceEnabled: boolean;
}

export function selectOperationalEvidenceItems(
  candidates: readonly OperationalEvidenceItem[],
  maximum: number,
): readonly OperationalEvidenceItem[] {
  const unique = new Map<string, OperationalEvidenceItem>();
  for (const candidate of candidates) {
    if (isOperationalEvidenceItem(candidate) && !unique.has(candidate.id)) {
      unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()]
    .sort((left, right) =>
      (right.publishedAt ?? right.collectedAt).localeCompare(
        left.publishedAt ?? left.collectedAt,
      ) ||
      right.collectedAt.localeCompare(left.collectedAt) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, Math.min(5, maximum)));
}

export function isOperationalEvidenceItem(
  item: OperationalEvidenceItem,
): boolean {
  const source = getOfficialSource(item.sourceId);
  if (source === undefined || !source.enabled || !item.sourceEnabled) {
    return false;
  }
  if (isSynthetic(item)) return false;
  let url: URL;
  try {
    url = new URL(item.canonicalUrl);
  } catch {
    return false;
  }
  const policy = source.officialPagePolicy;
  return url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    (url.port === "" || url.port === "443") &&
    policy.entryHosts.includes(url.hostname.toLowerCase()) &&
    policy.allowedPathPrefixes.some((prefix) =>
      url.pathname.startsWith(prefix)
    ) &&
    !policy.blockedPathPrefixes.some((prefix) =>
      url.pathname.startsWith(prefix)
    );
}

function isSynthetic(item: OperationalEvidenceItem): boolean {
  const marker = /\b(fixture|fictitious|synthetic|demo|test data)\b/i;
  return marker.test(item.id) ||
    marker.test(item.title) ||
    marker.test(item.summary ?? "") ||
    marker.test(item.contentHash) ||
    marker.test(item.externalId ?? "") ||
    /^content-hash-/i.test(item.contentHash) ||
    /^acme launches orbit 2\.0$/i.test(item.title.trim());
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
