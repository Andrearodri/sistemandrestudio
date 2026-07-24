import type { EditorialCommand, EditorialState } from "./types.ts";

export const DOMAIN_ERROR_CODES = [
  "INVALID_TRANSITION",
  "ENTITY_NOT_FOUND",
  "DRAFT_VERSION_NOT_FOUND",
  "APPROVAL_REQUEST_NOT_FOUND",
  "APPROVAL_ALREADY_PROCESSED",
  "DUPLICATE_COMMAND",
  "REQUIRED_FIELD_MISSING",
  "STALE_APPROVAL_VERSION",
  "INVALID_RELEVANCE_SCORE",
  "LOW_RELEVANCE",
  "INVALID_ACTOR",
  "CONCURRENT_UPDATE",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(state: EditorialState, commandType: EditorialCommand["type"]) {
    super(
      "INVALID_TRANSITION",
      `Command ${commandType} is not allowed from state ${state}.`,
      { commandType, state },
    );
  }
}

export class EntityNotFoundError extends DomainError {
  constructor(entityId: string) {
    super("ENTITY_NOT_FOUND", `Editorial news ${entityId} was not found.`, {
      entityId,
    });
  }
}

export class DraftVersionNotFoundError extends DomainError {
  constructor(versionId: string) {
    super(
      "DRAFT_VERSION_NOT_FOUND",
      `Draft version ${versionId} was not found.`,
      { versionId },
    );
  }
}

export class ApprovalRequestNotFoundError extends DomainError {
  constructor(approvalRequestId: string) {
    super(
      "APPROVAL_REQUEST_NOT_FOUND",
      `Approval request ${approvalRequestId} was not found.`,
      { approvalRequestId },
    );
  }
}

export class ApprovalAlreadyProcessedError extends DomainError {
  constructor(approvalRequestId: string) {
    super(
      "APPROVAL_ALREADY_PROCESSED",
      `Approval request ${approvalRequestId} has already been processed.`,
      { approvalRequestId },
    );
  }
}

export class DuplicateCommandError extends DomainError {
  constructor(idempotencyKey: string) {
    super(
      "DUPLICATE_COMMAND",
      `Idempotency key ${idempotencyKey} was reused for another command.`,
      { idempotencyKey },
    );
  }
}

export class RequiredFieldMissingError extends DomainError {
  constructor(field: string) {
    super(
      "REQUIRED_FIELD_MISSING",
      `Required field ${field} is missing or invalid.`,
      { field },
    );
  }
}

export class StaleApprovalVersionError extends DomainError {
  constructor(expectedVersionId: string, receivedVersionId: string) {
    super(
      "STALE_APPROVAL_VERSION",
      `Approval targets ${receivedVersionId}, but current version is ${expectedVersionId}.`,
      { expectedVersionId, receivedVersionId },
    );
  }
}

export class InvalidRelevanceScoreError extends DomainError {
  constructor() {
    super(
      "INVALID_RELEVANCE_SCORE",
      "Relevance score and threshold must be between 0 and 100.",
    );
  }
}

export class LowRelevanceError extends DomainError {
  constructor(value: number, threshold: number) {
    super(
      "LOW_RELEVANCE",
      `Relevance score ${value} is below threshold ${threshold}.`,
      { threshold: String(threshold), value: String(value) },
    );
  }
}

export class InvalidActorError extends DomainError {
  constructor(expectedActorType: string, receivedActorType: string) {
    super(
      "INVALID_ACTOR",
      `This command requires actor ${expectedActorType}, received ${receivedActorType}.`,
      { expectedActorType, receivedActorType },
    );
  }
}

export class ConcurrentUpdateError extends DomainError {
  constructor(entityId: string, expectedVersion: number) {
    super(
      "CONCURRENT_UPDATE",
      `Editorial news ${entityId} changed after version ${expectedVersion}.`,
      { entityId, expectedVersion: String(expectedVersion) },
    );
  }
}
