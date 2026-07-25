import { createHash } from "node:crypto";

import {
  prepareVerificationOperation,
} from "../../application/src/index.ts";
import { getOfficialSource } from "../../sources/src/index.ts";
import { EvidenceAcquisitionError } from "./errors.ts";
import {
  deriveContentVersionedInput,
  deriveEvidenceContentIdentity,
} from "./acquisition-identity.ts";
import { buildEvidenceCandidates } from "./evidence-builder.ts";
import { extractOfficialPage } from "./html-extractor.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  OFFICIAL_EVIDENCE_POLICY_VERSION,
} from "./official-page-policy.ts";
import { OfficialPageClient } from "./official-page-client.ts";
import type {
  EvidenceAcquisitionInput,
  EvidenceAcquisitionRepository,
  EvidenceAcquisitionResult,
  EvidenceLimits,
  ExtractedOfficialPage,
} from "./types.ts";

export class OfficialEvidenceAcquisitionService {
  readonly #repository: EvidenceAcquisitionRepository;
  readonly #client: OfficialPageClient;
  readonly #limits: EvidenceLimits;

  constructor(
    repository: EvidenceAcquisitionRepository,
    client: OfficialPageClient = new OfficialPageClient(),
    limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
  ) {
    this.#repository = repository;
    this.#client = client;
    this.#limits = limits;
  }

  async acquire(
    input: EvidenceAcquisitionInput,
  ): Promise<EvidenceAcquisitionResult> {
    const itemController = new AbortController();
    const timeout = setTimeout(
      () => itemController.abort(
        new EvidenceAcquisitionError(
          "OFFICIAL_PAGE_TIMEOUT",
          "Official page acquisition exceeded the per-item limit.",
        ),
      ),
      this.#limits.itemTimeoutMs,
    );
    try {
      return await this.acquireWithinLimit(input, itemController.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async acquireWithinLimit(
    input: EvidenceAcquisitionInput,
    itemSignal: AbortSignal,
  ): Promise<EvidenceAcquisitionResult> {
    validateInput(input);
    const item = await this.#repository.findRadarItem(input.radarItemId);
    if (item === undefined) {
      throw new EvidenceAcquisitionError(
        "INVALID_EVIDENCE_ACQUISITION_INPUT",
        "The requested radar item does not exist.",
      );
    }
    const source = getOfficialSource(item.sourceId);
    if (source === undefined || !source.enabled) {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_NOT_ALLOWED",
        "The radar item does not belong to an enabled official source.",
      );
    }
    const policy = source.officialPagePolicy;
    const maxPages = Math.min(
      this.#limits.maxPagesPerItem,
      policy.maxPagesPerItem,
    );
    const retrievedAt = input.retrievedAt ?? input.occurredAt;
    const fetchedPrimary = await this.#client.fetchPage(
      item.canonicalUrl,
      policy,
      this.#limits,
      retrievedAt,
      "PRIMARY",
      itemSignal,
    );
    const primary = extractOfficialPage(
      fetchedPrimary,
      "PRIMARY_ARTICLE",
      this.#limits,
    );
    const pages: ExtractedOfficialPage[] = [primary];

    if (policy.maxDepth > 0 && this.#limits.maxDepth > 0) {
      const maximumRelated = Math.min(
        policy.maxRelatedPages,
        this.#limits.maxRelatedPages,
        maxPages - 1,
      );
      for (const related of primary.relatedLinks.slice(0, maximumRelated)) {
        try {
          const fetched = await this.#client.fetchPage(
            related.url,
            policy,
            this.#limits,
            retrievedAt,
            "RELATED",
            itemSignal,
          );
          pages.push(
            extractOfficialPage(fetched, related.relationship, this.#limits),
          );
        } catch (error) {
          if (
            error instanceof EvidenceAcquisitionError &&
            (
              error.code === "OFFICIAL_RELATED_LINK_NOT_ALLOWED" ||
              error.code === "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED" ||
              error.code === "OFFICIAL_PAGE_CONTENT_TYPE_NOT_ALLOWED" ||
              error.code === "OFFICIAL_PAGE_JAVASCRIPT_REQUIRED"
            )
          ) {
            continue;
          }
          throw error;
        }
      }
    }

    const identity = deriveEvidenceContentIdentity({
      itemId: item.id,
      canonicalUrl: item.canonicalUrl,
      pages,
      acquisitionPolicyVersion: OFFICIAL_EVIDENCE_POLICY_VERSION,
      sourcePolicyVersion: policy.version,
    });
    const identityMode = input.identityMode ?? "EXPLICIT";
    const effectiveInput = identityMode === "CONTENT_VERSIONED"
      ? deriveContentVersionedInput(input, identity, item.currentVersion)
      : input;
    const candidates = buildEvidenceCandidates(
      source.id,
      effectiveInput.claims,
      pages,
      this.#limits,
    );
    const verification = prepareVerificationOperation({
      newsId: item.editorialNewsId,
      verificationId: effectiveInput.verificationId,
      commandId: effectiveInput.commandId,
      idempotencyKey: `verification:${effectiveInput.idempotencyKey}`,
      expectedVersion: effectiveInput.expectedVersion,
      actor: effectiveInput.actor,
      occurredAt: effectiveInput.occurredAt,
      claims: effectiveInput.claims,
      evidence: candidates.map((candidate) => candidate.evidence),
      allowedSourceIds: [source.id],
      allowedSources: [{
        id: source.id,
        allowedHosts: [
          ...policy.entryHosts,
          ...policy.redirectHosts,
          ...policy.additionalOfficialHosts,
        ],
      }],
      evaluationMode: identityMode === "CONTENT_VERSIONED" &&
          item.currentState !== "PENDING_VERIFICATION"
        ? "HISTORICAL_REEVALUATION"
        : "EDITORIAL_TRANSITION",
    });
    const acquisitionFingerprint = hashCanonical({
      radarItemId: item.id,
      newsId: item.editorialNewsId,
      expectedVersion: effectiveInput.expectedVersion,
      sourceId: source.id,
      sourcePolicyVersion: policy.version,
      acquisitionPolicyVersion: OFFICIAL_EVIDENCE_POLICY_VERSION,
      claims: effectiveInput.claims,
      pages: pages.map((page) => ({
        canonicalUrl: page.canonicalUrl,
        contentHash: page.contentHash,
        relationship: page.relationship,
      })),
      verificationFingerprint: verification.fingerprint,
    });

    if (itemSignal.aborted) {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_TIMEOUT",
        "Official page acquisition exceeded the per-item limit.",
      );
    }
    try {
      return await this.#repository.executeAtomic({
        input: effectiveInput,
        item,
        source,
        policy,
        pages,
        candidates,
        externalIdempotencyKey: input.idempotencyKey,
        identityMode,
        contentIdentityHash: identity.hash,
        identityVersion: identity.version,
        retrievedAt,
        acquisitionFingerprint,
        verification,
      });
    } catch (error) {
      if (error instanceof EvidenceAcquisitionError) throw error;
      throw new EvidenceAcquisitionError(
        "EVIDENCE_ACQUISITION_PERSISTENCE_FAILED",
        "Evidence acquisition could not be persisted atomically.",
      );
    }
  }
}

function validateInput(input: EvidenceAcquisitionInput): void {
  if (
    !input.acquisitionId ||
    !input.radarItemId ||
    !input.verificationId ||
    !input.commandId ||
    !input.idempotencyKey ||
    input.claims.length === 0 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new EvidenceAcquisitionError(
      "INVALID_EVIDENCE_ACQUISITION_INPUT",
      "Evidence acquisition input is missing required fields.",
    );
  }
  try {
    if (new Date(input.occurredAt).toISOString() !== input.occurredAt) {
      throw new Error("non-canonical");
    }
    if (
      input.retrievedAt !== undefined &&
      new Date(input.retrievedAt).toISOString() !== input.retrievedAt
    ) {
      throw new Error("non-canonical retrieval");
    }
  } catch {
    throw new EvidenceAcquisitionError(
      "INVALID_EVIDENCE_ACQUISITION_INPUT",
      "Evidence acquisition requires an explicit ISO timestamp.",
    );
  }
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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
