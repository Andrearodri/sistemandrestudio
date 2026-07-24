export const APPLICATION_ERROR_CODES = [
  "INVALID_COMMAND_ENVELOPE",
  "EDITORIAL_NEWS_NOT_FOUND",
  "EDITORIAL_NEWS_ALREADY_EXISTS",
  "IDEMPOTENCY_CONFLICT",
  "CONCURRENCY_CONFLICT",
  "COMMAND_PERSISTENCE_FAILED",
  "UNSUPPORTED_COMMAND",
] as const;

export type ApplicationErrorCode =
  (typeof APPLICATION_ERROR_CODES)[number];

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidCommandEnvelopeError extends ApplicationError {
  constructor(field: string) {
    super(
      "INVALID_COMMAND_ENVELOPE",
      `Command envelope field ${field} is missing or invalid.`,
      { field },
    );
  }
}

export class EditorialNewsNotFoundError extends ApplicationError {
  constructor(newsId: string) {
    super(
      "EDITORIAL_NEWS_NOT_FOUND",
      `Editorial news ${newsId} was not found.`,
      { newsId },
    );
  }
}

export class EditorialNewsAlreadyExistsError extends ApplicationError {
  constructor(newsId: string) {
    super(
      "EDITORIAL_NEWS_ALREADY_EXISTS",
      `Editorial news ${newsId} already exists.`,
      { newsId },
    );
  }
}

export class IdempotencyConflictError extends ApplicationError {
  constructor(idempotencyKey: string) {
    super(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key is associated with different command content.",
      { idempotencyKey },
    );
  }
}

export class ConcurrencyConflictError extends ApplicationError {
  constructor(newsId: string, expectedVersion: number) {
    super(
      "CONCURRENCY_CONFLICT",
      `Editorial news ${newsId} no longer has expected version ${expectedVersion}.`,
      { expectedVersion: String(expectedVersion), newsId },
    );
  }
}

export class CommandPersistenceFailedError extends ApplicationError {
  constructor(commandId: string, cause: unknown) {
    super(
      "COMMAND_PERSISTENCE_FAILED",
      `Command ${commandId} could not be persisted.`,
      { commandId },
      { cause },
    );
  }
}

export class UnsupportedCommandError extends ApplicationError {
  constructor(commandType: string) {
    super(
      "UNSUPPORTED_COMMAND",
      `Command type ${commandType} is not supported by the editorial workflow.`,
      { commandType },
    );
  }
}
