import { createHash } from "node:crypto";

import type {
  PublicationFile,
  PublicationPackage,
} from "./publication-package-service.ts";
import { LocalWebsitePublicationPackageReader } from "./website-publication-planning-service.ts";

export const PUBLICATION_RECONCILIATION_POLICY = {
  id: "andre-studio-publication-reconciliation-v1",
  version: "andre-studio-publication-reconciliation-v1",
  allowedHosts: ["andrestudio.dev.br", "www.andrestudio.dev.br"],
  canonicalHost: "andrestudio.dev.br",
  legacyTechnicalHost: "andrestudiodev.duckdns.org",
  requestTimeoutMs: 20_000,
  maxRedirects: 5,
  maxHtmlBytes: 1_000_000,
  maxTextBytes: 2_000_000,
} as const;

export const PUBLICATION_RECONCILIATION_AUDIT_ACTIONS = [
  "PUBLICATION_RECONCILIATION_REQUESTED",
  "PUBLICATION_PUBLIC_VERIFICATION_STARTED",
  "PUBLICATION_PUBLIC_VERIFICATION_COMPLETED",
  "PUBLICATION_EXTERNALLY_CONFIRMED",
  "PUBLICATION_MARKED_AS_PUBLISHED",
  "PUBLICATION_RECONCILIATION_REPLAYED",
  "PUBLICATION_RECONCILIATION_BLOCKED",
] as const;

export type PublicationExecutionOrigin =
  | "SYSTEM_EXECUTED"
  | "MANUAL_SUPERVISED_DEPLOY"
  | "EXTERNAL_CONFIRMED";

export type PublicPublicationVerificationStatus =
  | "VERIFIED"
  | "VERIFIED_WITH_WARNINGS"
  | "FAILED";

export type PublicationVerificationCheckStatus = "PASS" | "WARN" | "FAIL";

export interface ExternalPublicationConfirmation {
  readonly publicationPackageId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly destination: "WEBSITE";
  readonly executionOrigin: PublicationExecutionOrigin;
  readonly operatorId: string;
  readonly confirmedAt: string;
  readonly publicUrl: string;
  readonly canonicalUrl: string;
  readonly websiteCommit?: string;
  readonly deploymentTarget?: string;
  readonly verificationPolicyId: string;
  readonly verificationPolicyVersion: string;
  readonly notes?: string;
}

export interface PublicationVerificationCheck {
  readonly position: number;
  readonly code: string;
  readonly status: PublicationVerificationCheckStatus;
  readonly expectedValue?: string;
  readonly observedSummary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PublicPublicationVerification {
  readonly verificationId: string;
  readonly publicationPackageId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: PublicPublicationVerificationStatus;
  readonly httpStatus: number;
  readonly finalUrl: string;
  readonly canonicalUrl: string;
  readonly contentFingerprint: string;
  readonly warnings: readonly string[];
  readonly checks: readonly PublicationVerificationCheck[];
}

export interface PublicationReconciliation {
  readonly reconciliationId: string;
  readonly publicationPackageId: string;
  readonly newsId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly destination: "WEBSITE";
  readonly executionOrigin: PublicationExecutionOrigin;
  readonly operatorId: string;
  readonly confirmedAt: string;
  readonly publicUrl: string;
  readonly canonicalUrl: string;
  readonly websiteCommit?: string;
  readonly deploymentTargetLabel?: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly verificationStatus: PublicPublicationVerificationStatus;
  readonly reconciliationStatus: "COMPLETED";
  readonly functionalFingerprint: string;
  readonly previousState: "READY_FOR_PUBLICATION";
  readonly finalState: "PUBLISHED";
  readonly warnings: readonly string[];
  readonly verification: PublicPublicationVerification;
  readonly createdAt: string;
}

export interface ReconciliationSource {
  readonly pkg: PublicationPackage;
  readonly files: readonly Omit<PublicationFile, "content">[];
}

export interface PublicationReconciliationRepository {
  listReadyForReconciliation(): Promise<readonly ReconciliationSource[]>;
  loadSource(publicationId: string): Promise<ReconciliationSource | undefined>;
  findByIdempotency(
    idempotencyKey: string,
  ): Promise<PublicationReconciliation | undefined>;
  saveAtomic(input: {
    readonly reconciliation: PublicationReconciliation;
    readonly idempotencyKey: string;
    readonly commandId: string;
  }): Promise<{ reconciliation: PublicationReconciliation; replayed: boolean }>;
  get(id: string): Promise<PublicationReconciliation | undefined>;
  list(): Promise<readonly PublicationReconciliation[]>;
}

export interface PublicPublicationVerifier {
  verify(input: {
    readonly source: ReconciliationSource;
    readonly publicUrl: string;
    readonly canonicalUrl: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }): Promise<PublicPublicationVerification>;
}

export class PublicationReconciliationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicationReconciliationError";
    this.code = code;
  }
}

export interface ReconcileExternalPublicationInput {
  readonly publicationId: string;
  readonly draftId: string;
  readonly operatorId: string;
  readonly origin: PublicationExecutionOrigin;
  readonly publicUrl: string;
  readonly canonicalUrl: string;
  readonly websiteCommit?: string;
  readonly deploymentTarget?: string;
  readonly confirmedAt?: string;
  readonly notes?: string;
  readonly idempotencyKey: string;
  readonly commandId: string;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reconciliationIdentity(input: {
  readonly publicationId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly operatorId: string;
  readonly origin: PublicationExecutionOrigin;
  readonly publicUrl: string;
  readonly canonicalUrl: string;
  readonly websiteCommit?: string;
}): string {
  return sha256(
    canonical({
      ...input,
      destination: "WEBSITE",
      policyId: PUBLICATION_RECONCILIATION_POLICY.id,
      policyVersion: PUBLICATION_RECONCILIATION_POLICY.version,
    }),
  );
}

export function reconciliationIdempotencyKey(input: {
  readonly publicationId: string;
  readonly draftId: string;
  readonly operatorId: string;
  readonly origin: PublicationExecutionOrigin;
  readonly publicUrl: string;
  readonly canonicalUrl: string;
  readonly websiteCommit?: string;
}): string {
  return `publication-reconciliation:${sha256(canonical(input)).slice(0, 32)}`;
}

function validateHttpsUrl(value: string, canonicalRequired: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_URL_INVALID",
      "Publication URL is invalid.",
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !PUBLICATION_RECONCILIATION_POLICY.allowedHosts.includes(
      host as (typeof PUBLICATION_RECONCILIATION_POLICY.allowedHosts)[number],
    ) ||
    (canonicalRequired &&
      host !== PUBLICATION_RECONCILIATION_POLICY.canonicalHost)
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_URL_NOT_ALLOWED",
      "Publication URL must use an allowed credential-free HTTPS domain.",
    );
  }
  if (host === PUBLICATION_RECONCILIATION_POLICY.legacyTechnicalHost) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_URL_NOT_ALLOWED",
      "The legacy technical domain cannot be canonical.",
    );
  }
  return url;
}

function assertInput(
  source: ReconciliationSource,
  input: ReconcileExternalPublicationInput,
): void {
  if (
    source.pkg.status !== "READY_FOR_PUBLICATION" ||
    source.pkg.destination !== "WEBSITE_EXPORT"
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_PACKAGE_NOT_READY",
      "A ready website package is required.",
    );
  }
  if (
    source.pkg.draftId !== input.draftId ||
    source.pkg.draftVersion < 1 ||
    source.pkg.reviewerId.length === 0 ||
    source.pkg.approvalDecisionId.length === 0
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_PACKAGE_INVALID",
      "Approved draft identity does not match the package.",
    );
  }
  if (input.origin !== "MANUAL_SUPERVISED_DEPLOY") {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_ORIGIN_INVALID",
      "This reconciliation requires a supervised manual deployment origin.",
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(input.operatorId)) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_OPERATOR_INVALID",
      "A bounded operator identifier is required.",
    );
  }
  const publicUrl = validateHttpsUrl(input.publicUrl, false);
  const canonicalUrl = validateHttpsUrl(input.canonicalUrl, true);
  if (
    publicUrl.pathname !== canonicalUrl.pathname ||
    canonicalUrl.pathname !== `/blog/${source.pkg.slug}/`
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_URL_INVALID",
      "Public and canonical article routes do not match the approved slug.",
    );
  }
  if (
    input.websiteCommit !== undefined &&
    !/^[0-9a-f]{7,40}$/i.test(input.websiteCommit)
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_COMMIT_INVALID",
      "Website commit must be an abbreviated or complete Git hash.",
    );
  }
  if (
    input.deploymentTarget !== undefined &&
    (input.deploymentTarget.length > 120 ||
      input.deploymentTarget.includes("/") ||
      input.deploymentTarget.includes("\\"))
  ) {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_TARGET_INVALID",
      "Deployment target must be a safe descriptive label.",
    );
  }
}

export class PublicationReconciliationService {
  readonly #repository: PublicationReconciliationRepository;
  readonly #verifier: PublicPublicationVerifier;
  readonly #packageReader: LocalWebsitePublicationPackageReader;
  readonly #clock: () => string;

  constructor(
    repository: PublicationReconciliationRepository,
    verifier: PublicPublicationVerifier,
    packageReader: LocalWebsitePublicationPackageReader,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.#repository = repository;
    this.#verifier = verifier;
    this.#packageReader = packageReader;
    this.#clock = clock;
  }

  listReadyForReconciliation() {
    return this.#repository.listReadyForReconciliation();
  }

  getReconciliation(id: string) {
    return this.#repository.get(id);
  }

  listReconciliations() {
    return this.#repository.list();
  }

  async verifyPublicPublication(input: {
    readonly publicationId: string;
    readonly publicUrl: string;
    readonly canonicalUrl?: string;
  }): Promise<PublicPublicationVerification> {
    const source = await this.#repository.loadSource(input.publicationId);
    if (source === undefined) {
      throw new PublicationReconciliationError(
        "PUBLICATION_RECONCILIATION_PACKAGE_NOT_READY",
        "Ready publication package was not found.",
      );
    }
    await this.#packageReader.validate(source);
    const canonicalUrl = input.canonicalUrl ?? input.publicUrl;
    validateHttpsUrl(input.publicUrl, false);
    validateHttpsUrl(canonicalUrl, true);
    const startedAt = this.#clock();
    return this.#verifier.verify({
      source,
      publicUrl: input.publicUrl,
      canonicalUrl,
      startedAt,
      completedAt: this.#clock(),
    });
  }

  async reconcileExternalPublication(
    input: ReconcileExternalPublicationInput,
  ): Promise<{ reconciliation: PublicationReconciliation; replayed: boolean }> {
    const prior = await this.#repository.findByIdempotency(input.idempotencyKey);
    if (prior !== undefined) {
      const expected = reconciliationIdentity({
        publicationId: input.publicationId,
        draftId: input.draftId,
        draftVersion: prior.draftVersion,
        operatorId: input.operatorId,
        origin: input.origin,
        publicUrl: input.publicUrl,
        canonicalUrl: input.canonicalUrl,
        ...(input.websiteCommit === undefined
          ? {}
          : { websiteCommit: input.websiteCommit }),
      });
      if (prior.functionalFingerprint !== expected) {
        throw new PublicationReconciliationError(
          "PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT",
          "Idempotency key was used with incompatible publication data.",
        );
      }
      return { reconciliation: prior, replayed: true };
    }

    const source = await this.#repository.loadSource(input.publicationId);
    if (source === undefined) {
      throw new PublicationReconciliationError(
        "PUBLICATION_RECONCILIATION_PACKAGE_NOT_READY",
        "Ready publication package was not found.",
      );
    }
    assertInput(source, input);
    await this.#packageReader.validate(source);

    const confirmationTimeWasSupplied = input.confirmedAt !== undefined;
    const confirmedAt = input.confirmedAt ?? this.#clock();
    if (Number.isNaN(Date.parse(confirmedAt))) {
      throw new PublicationReconciliationError(
        "PUBLICATION_RECONCILIATION_TIME_INVALID",
        "Confirmation time must be ISO-8601.",
      );
    }
    const startedAt = this.#clock();
    const verification = await this.#verifier.verify({
      source,
      publicUrl: input.publicUrl,
      canonicalUrl: input.canonicalUrl,
      startedAt,
      completedAt: this.#clock(),
    });
    if (verification.status === "FAILED") {
      throw new PublicationReconciliationError(
        "PUBLICATION_PUBLIC_VERIFICATION_FAILED",
        "Critical public publication verification failed.",
      );
    }

    const warnings = [
      ...verification.warnings,
      ...(confirmationTimeWasSupplied
        ? []
        : ["CONFIRMATION_TIME_NOT_ORIGINAL_DEPLOY_TIME"]),
    ];
    const fingerprint = reconciliationIdentity({
      publicationId: input.publicationId,
      draftId: input.draftId,
      draftVersion: source.pkg.draftVersion,
      operatorId: input.operatorId,
      origin: input.origin,
      publicUrl: input.publicUrl,
      canonicalUrl: input.canonicalUrl,
      ...(input.websiteCommit === undefined
        ? {}
        : { websiteCommit: input.websiteCommit }),
    });
    const confirmation: ExternalPublicationConfirmation = {
      publicationPackageId: source.pkg.publicationId,
      draftId: source.pkg.draftId,
      draftVersion: source.pkg.draftVersion,
      destination: "WEBSITE",
      executionOrigin: input.origin,
      operatorId: input.operatorId,
      confirmedAt,
      publicUrl: input.publicUrl,
      canonicalUrl: input.canonicalUrl,
      ...(input.websiteCommit === undefined
        ? {}
        : { websiteCommit: input.websiteCommit }),
      ...(input.deploymentTarget === undefined
        ? {}
        : { deploymentTarget: input.deploymentTarget }),
      verificationPolicyId: PUBLICATION_RECONCILIATION_POLICY.id,
      verificationPolicyVersion: PUBLICATION_RECONCILIATION_POLICY.version,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
    const reconciliation: PublicationReconciliation = {
      reconciliationId: `publication-reconciliation-${fingerprint.slice(0, 24)}`,
      publicationPackageId: source.pkg.publicationId,
      newsId: source.pkg.newsId,
      draftId: confirmation.draftId,
      draftVersion: confirmation.draftVersion,
      destination: confirmation.destination,
      executionOrigin: confirmation.executionOrigin,
      operatorId: confirmation.operatorId,
      confirmedAt: confirmation.confirmedAt,
      publicUrl: confirmation.publicUrl,
      canonicalUrl: confirmation.canonicalUrl,
      ...(confirmation.websiteCommit === undefined
        ? {}
        : { websiteCommit: confirmation.websiteCommit }),
      ...(confirmation.deploymentTarget === undefined
        ? {}
        : { deploymentTargetLabel: confirmation.deploymentTarget }),
      policyId: confirmation.verificationPolicyId,
      policyVersion: confirmation.verificationPolicyVersion,
      verificationStatus: verification.status,
      reconciliationStatus: "COMPLETED",
      functionalFingerprint: fingerprint,
      previousState: "READY_FOR_PUBLICATION",
      finalState: "PUBLISHED",
      warnings,
      verification,
      createdAt: this.#clock(),
    };
    return this.#repository.saveAtomic({
      reconciliation,
      idempotencyKey: input.idempotencyKey,
      commandId: input.commandId,
    });
  }
}

export class InMemoryPublicationReconciliationRepository
  implements PublicationReconciliationRepository
{
  readonly #sources = new Map<string, ReconciliationSource>();
  readonly #records = new Map<string, PublicationReconciliation>();
  readonly #keys = new Map<string, string>();

  constructor(sources: readonly ReconciliationSource[]) {
    for (const source of sources) {
      this.#sources.set(source.pkg.publicationId, source);
    }
  }

  async listReadyForReconciliation() {
    return [...this.#sources.values()].filter(
      (source) =>
        source.pkg.status === "READY_FOR_PUBLICATION" &&
        source.pkg.destination === "WEBSITE_EXPORT",
    );
  }

  async loadSource(publicationId: string) {
    const source = this.#sources.get(publicationId);
    return source?.pkg.status === "READY_FOR_PUBLICATION" ? source : undefined;
  }

  async findByIdempotency(key: string) {
    const id = this.#keys.get(key);
    return id === undefined ? undefined : this.#records.get(id);
  }

  async saveAtomic(input: {
    readonly reconciliation: PublicationReconciliation;
    readonly idempotencyKey: string;
    readonly commandId: string;
  }) {
    const keyed = await this.findByIdempotency(input.idempotencyKey);
    if (keyed !== undefined) {
      if (
        keyed.functionalFingerprint !==
        input.reconciliation.functionalFingerprint
      ) {
        throw new PublicationReconciliationError(
          "PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT",
          "Idempotency conflict.",
        );
      }
      return { reconciliation: keyed, replayed: true };
    }
    const identity = [...this.#records.values()].find(
      (record) =>
        record.functionalFingerprint ===
        input.reconciliation.functionalFingerprint,
    );
    if (identity !== undefined) {
      return { reconciliation: identity, replayed: true };
    }
    const source = this.#sources.get(
      input.reconciliation.publicationPackageId,
    );
    if (
      source === undefined ||
      source.pkg.status !== "READY_FOR_PUBLICATION"
    ) {
      throw new PublicationReconciliationError(
        "PUBLICATION_RECONCILIATION_PACKAGE_NOT_READY",
        "Package is not ready.",
      );
    }
    this.#records.set(
      input.reconciliation.reconciliationId,
      input.reconciliation,
    );
    this.#keys.set(
      input.idempotencyKey,
      input.reconciliation.reconciliationId,
    );
    this.#sources.set(source.pkg.publicationId, {
      ...source,
      pkg: { ...source.pkg, status: "PUBLISHED" },
    });
    return { reconciliation: input.reconciliation, replayed: false };
  }

  async get(id: string) {
    return this.#records.get(id);
  }

  async list() {
    return [...this.#records.values()];
  }
}
