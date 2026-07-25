import { createHash } from "node:crypto";

import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1,
  evaluateVerification,
} from "../../content-engine/src/index.ts";
import type {
  ClaimVerificationResult,
  FactualVerificationResult,
  VerificationClaim,
  VerificationEditorialDecision,
  VerificationEvidence,
  VerificationStatus,
} from "../../content-engine/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";

export interface VerificationWorkflowInput {
  readonly newsId: string;
  readonly verificationId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly claims: readonly VerificationClaim[];
  readonly evidence: readonly VerificationEvidence[];
  readonly allowedSourceIds?: readonly string[] | undefined;
  readonly allowedSources?: readonly {
    readonly id: string;
    readonly allowedHosts: readonly string[];
  }[] | undefined;
  readonly evaluationMode?:
    | "EDITORIAL_TRANSITION"
    | "HISTORICAL_REEVALUATION"
    | undefined;
}

export interface VerificationAtomicOperation {
  readonly input: VerificationWorkflowInput;
  readonly fingerprint: string;
  readonly result: FactualVerificationResult;
}

export interface VerificationAtomicResult {
  readonly previousState: string;
  readonly currentState: string;
  readonly replayed: boolean;
  readonly result: FactualVerificationResult;
}

export interface VerificationUnitOfWork {
  executeAtomic(
    operation: VerificationAtomicOperation,
  ): Promise<VerificationAtomicResult>;
}

export interface VerificationWorkflowResult {
  readonly verificationId: string;
  readonly newsId: string;
  readonly previousState: string;
  readonly currentState: string;
  readonly verificationStatus: VerificationStatus;
  readonly editorialDecision: VerificationEditorialDecision;
  readonly confidence: number;
  readonly claims: readonly ClaimVerificationResult[];
  readonly warnings: FactualVerificationResult["warnings"];
  readonly blockingReasons: FactualVerificationResult["blockingReasons"];
  readonly replayed: boolean;
  readonly policyId: string;
  readonly policyVersion: string;
}

export class VerificationWorkflowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VerificationWorkflowError";
    this.code = code;
  }
}

export class VerificationWorkflowService {
  readonly #unitOfWork: VerificationUnitOfWork;

  constructor(unitOfWork: VerificationUnitOfWork) {
    this.#unitOfWork = unitOfWork;
  }

  async evaluate(
    input: VerificationWorkflowInput,
  ): Promise<VerificationWorkflowResult> {
    const persisted = await this.#unitOfWork.executeAtomic(
      prepareVerificationOperation(input),
    );

    return {
      verificationId: persisted.result.verificationId,
      newsId: persisted.result.newsId,
      previousState: persisted.previousState,
      currentState: persisted.currentState,
      verificationStatus: persisted.result.status,
      editorialDecision: persisted.result.editorialDecision,
      confidence: persisted.result.confidence,
      claims: persisted.result.claims,
      warnings: persisted.result.warnings,
      blockingReasons: persisted.result.blockingReasons,
      replayed: persisted.replayed,
      policyId: persisted.result.policyId,
      policyVersion: persisted.result.policyVersion,
    };
  }
}

export function prepareVerificationOperation(
  input: VerificationWorkflowInput,
): VerificationAtomicOperation {
  validateWorkflowInput(input);
  return {
    input,
    fingerprint: verificationFingerprint(input),
    result: evaluateVerification({
      verificationId: input.verificationId,
      newsId: input.newsId,
      claims: input.claims,
      evidence: input.evidence,
      allowedSourceIds: input.allowedSourceIds,
      allowedSources: input.allowedSources,
      policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1,
      evaluatedAt: input.occurredAt,
    }),
  };
}

export function verificationFingerprint(
  input: VerificationWorkflowInput,
): string {
  const functionalInput = {
    newsId: input.newsId,
    verificationId: input.verificationId,
    expectedVersion: input.expectedVersion,
    occurredAt: input.occurredAt,
    actor: input.actor,
    claims: input.claims,
    evidence: input.evidence.map(({ retrievedAt: _retrievedAt, ...item }) =>
      item
    ),
    allowedSourceIds: input.allowedSourceIds === undefined
      ? undefined
      : [...input.allowedSourceIds].sort(),
    allowedSources: input.allowedSources === undefined
      ? undefined
      : [...input.allowedSources]
        .map((source) => ({
          id: source.id,
          allowedHosts: [...source.allowedHosts].sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    policyId: ANDRE_STUDIO_VERIFICATION_POLICY_V1.id,
    policyVersion: ANDRE_STUDIO_VERIFICATION_POLICY_V1.version,
    evaluationMode: input.evaluationMode ?? "EDITORIAL_TRANSITION",
  };
  return createHash("sha256")
    .update(stableJson(functionalInput))
    .digest("hex");
}

function validateWorkflowInput(input: VerificationWorkflowInput): void {
  if (
    !input.commandId ||
    !input.idempotencyKey ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0
  ) {
    throw new VerificationWorkflowError(
      "INVALID_VERIFICATION_COMMAND",
      "Verification command metadata is missing or invalid.",
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
