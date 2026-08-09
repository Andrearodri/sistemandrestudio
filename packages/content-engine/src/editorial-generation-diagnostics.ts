export const EDITORIAL_GENERATION_DIAGNOSTIC_CODES = [
  "INITIAL_PARSE_FAILED",
  "INITIAL_SCHEMA_FAILED",
  "INITIAL_CONTENT_REJECTED",
  "REPAIR_SCHEMA_FAILED",
  "REPAIR_CONTENT_REJECTED",
  "WORD_COUNT_BELOW_MINIMUM",
  "WORD_COUNT_ABOVE_MAXIMUM",
  "UNSUPPORTED_QUALIFIER",
  "REQUIRED_FIELD_MISSING",
  "FINAL_VALIDATION_FAILED",
] as const;

export type EditorialGenerationDiagnosticCode = typeof EDITORIAL_GENERATION_DIAGNOSTIC_CODES[number];
export type EditorialGenerationDiagnosticStage = "INITIAL_GENERATION" | "DIRECTED_REPAIR" | "FINAL_VALIDATION";
export type EditorialGenerationParseResult = "NOT_RUN" | "VALID_JSON" | "INVALID_JSON" | "SCHEMA_VALID" | "SCHEMA_INVALID";
export type EditorialGenerationField = "title" | "subtitle" | "body";
export type EditorialGenerationTerminationReason = "STOP" | "OUTPUT_LIMIT" | "ERROR" | "UNKNOWN";

export interface EditorialGenerationDiagnostic {
  readonly stage: EditorialGenerationDiagnosticStage;
  readonly attempt: 1 | 2;
  readonly codes: readonly EditorialGenerationDiagnosticCode[];
  readonly wordCount?: number;
  readonly fields?: readonly EditorialGenerationField[];
  readonly parseResult: EditorialGenerationParseResult;
  readonly durationMs: number;
  readonly callCount: number;
  readonly promptTokenCount?: number;
  readonly completionTokenCount?: number;
  readonly effectiveOutputLimit?: number;
  readonly terminationReason?: EditorialGenerationTerminationReason;
}

export class EditorialGenerationDiagnosticError extends Error {
  readonly code = "EDITORIAL_GENERATION_DIAGNOSTIC";
  readonly diagnostics: readonly EditorialGenerationDiagnostic[];

  constructor(diagnostics: readonly EditorialGenerationDiagnostic[]) {
    super("Editorial generation failed.");
    this.name = "EditorialGenerationDiagnosticError";
    this.diagnostics = diagnostics.map(sanitizeDiagnostic);
  }
}

export function isEditorialGenerationDiagnosticError(value: unknown): value is EditorialGenerationDiagnosticError {
  return value instanceof EditorialGenerationDiagnosticError;
}

export function sanitizeDiagnostic(input: EditorialGenerationDiagnostic): EditorialGenerationDiagnostic {
  const codes = [...new Set(input.codes)].filter((code): code is EditorialGenerationDiagnosticCode => (EDITORIAL_GENERATION_DIAGNOSTIC_CODES as readonly string[]).includes(code));
  const fields = input.fields === undefined ? undefined : [...new Set(input.fields)].filter((field): field is EditorialGenerationField => field === "title" || field === "subtitle" || field === "body");
  return {
    stage: input.stage,
    attempt: input.attempt,
    codes: codes.length > 0 ? codes : ["FINAL_VALIDATION_FAILED"],
    ...(input.wordCount === undefined ? {} : { wordCount: Math.max(0, Math.floor(input.wordCount)) }),
    ...(fields === undefined || fields.length === 0 ? {} : { fields }),
    parseResult: input.parseResult,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    callCount: Math.max(0, Math.floor(input.callCount)),
    ...(input.promptTokenCount === undefined ? {} : { promptTokenCount: Math.max(0, Math.floor(input.promptTokenCount)) }),
    ...(input.completionTokenCount === undefined ? {} : { completionTokenCount: Math.max(0, Math.floor(input.completionTokenCount)) }),
    ...(input.effectiveOutputLimit === undefined ? {} : { effectiveOutputLimit: Math.max(0, Math.floor(input.effectiveOutputLimit)) }),
    ...(input.terminationReason === undefined ? {} : { terminationReason: input.terminationReason }),
  };
}
