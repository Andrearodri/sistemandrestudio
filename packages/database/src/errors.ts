export const DATABASE_ERROR_CODES = [
  "DATABASE_CONFIG_ERROR",
  "MIGRATION_ERROR",
  "PERSISTENCE_IDEMPOTENCY_CONFLICT",
  "UNSAFE_TEST_DATABASE",
  "PERSISTENCE_CONSTRAINT_ERROR",
] as const;

export type DatabaseErrorCode = (typeof DATABASE_ERROR_CODES)[number];

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: DatabaseErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class DatabaseConfigError extends DatabaseError {
  constructor(field: string) {
    super(
      "DATABASE_CONFIG_ERROR",
      `Database configuration field ${field} is missing or invalid.`,
      { field },
    );
  }
}
export class MigrationError extends DatabaseError {
  constructor(migration: string, reason: string) {
    super("MIGRATION_ERROR", `Migration ${migration} failed: ${reason}`, {
      migration,
      reason,
    });
  }
}

export class PersistenceIdempotencyConflictError extends DatabaseError {
  constructor(idempotencyKey: string) {
    super(
      "PERSISTENCE_IDEMPOTENCY_CONFLICT",
      "The idempotency key is already associated with another command.",
      { idempotencyKey },
    );
  }
}

export class UnsafeTestDatabaseError extends DatabaseError {
  constructor(database: string) {
    super(
      "UNSAFE_TEST_DATABASE",
      "Destructive test reset requires a database name ending with _test.",
      { database },
    );
  }
}

export class PersistenceConstraintError extends DatabaseError {
  constructor(constraint: string) {
    super(
      "PERSISTENCE_CONSTRAINT_ERROR",
      `PostgreSQL rejected data for constraint ${constraint}.`,
      { constraint },
    );
  }
}
