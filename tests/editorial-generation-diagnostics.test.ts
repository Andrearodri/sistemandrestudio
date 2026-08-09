import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  EditorialGenerationDiagnosticError,
  sanitizeDiagnostic,
} from "../packages/content-engine/src/index.ts";

describe("editorial generation diagnostics", () => {
  test("preserves allow-listed initial and repair codes with safe metrics", () => {
    const error = new EditorialGenerationDiagnosticError([
      { stage: "INITIAL_GENERATION", attempt: 1, codes: ["INITIAL_CONTENT_REJECTED", "WORD_COUNT_BELOW_MINIMUM"], wordCount: 174, fields: ["body"], parseResult: "SCHEMA_VALID", durationMs: 91.9, callCount: 1, promptTokenCount: 220, completionTokenCount: 380, effectiveOutputLimit: 768, terminationReason: "STOP" },
      { stage: "DIRECTED_REPAIR", attempt: 2, codes: ["REPAIR_CONTENT_REJECTED", "WORD_COUNT_ABOVE_MAXIMUM"], wordCount: 301, fields: ["body"], parseResult: "SCHEMA_VALID", durationMs: 102.4, callCount: 2, promptTokenCount: 250, completionTokenCount: 401, effectiveOutputLimit: 768, terminationReason: "OUTPUT_LIMIT" },
    ]);
    assert.deepEqual(error.diagnostics, [
      { stage: "INITIAL_GENERATION", attempt: 1, codes: ["INITIAL_CONTENT_REJECTED", "WORD_COUNT_BELOW_MINIMUM"], wordCount: 174, fields: ["body"], parseResult: "SCHEMA_VALID", durationMs: 91, callCount: 1, promptTokenCount: 220, completionTokenCount: 380, effectiveOutputLimit: 768, terminationReason: "STOP" },
      { stage: "DIRECTED_REPAIR", attempt: 2, codes: ["REPAIR_CONTENT_REJECTED", "WORD_COUNT_ABOVE_MAXIMUM"], wordCount: 301, fields: ["body"], parseResult: "SCHEMA_VALID", durationMs: 102, callCount: 2, promptTokenCount: 250, completionTokenCount: 401, effectiveOutputLimit: 768, terminationReason: "OUTPUT_LIMIT" },
    ]);
  });

  test("never serializes prompts, model output, evidence or secrets", () => {
    const diagnostic = sanitizeDiagnostic({ stage: "FINAL_VALIDATION", attempt: 2, codes: ["FINAL_VALIDATION_FAILED", "NOT_A_REAL_CODE" as never], parseResult: "SCHEMA_INVALID", durationMs: 12, callCount: 2, fields: ["subtitle"] });
    const serialized = JSON.stringify(diagnostic);
    assert.doesNotMatch(serialized, /prompt|token|secret|evidence|TELEGRAM|sk-|ghp_/iu);
    assert.doesNotMatch(serialized, /modelo integral|conteúdo integral/iu);
    assert.match(serialized, /FINAL_VALIDATION_FAILED/);
  });

  test("keeps word count available when final validation fails", () => {
    const error = new EditorialGenerationDiagnosticError([{ stage: "FINAL_VALIDATION", attempt: 2, codes: ["FINAL_VALIDATION_FAILED", "WORD_COUNT_BELOW_MINIMUM"], wordCount: 179, parseResult: "SCHEMA_VALID", durationMs: 33, callCount: 2 }]);
    assert.equal(error.diagnostics[0]?.wordCount, 179);
    assert.equal(error.diagnostics[0]?.attempt, 2);
    assert.deepEqual(error.diagnostics[0]?.codes, ["FINAL_VALIDATION_FAILED", "WORD_COUNT_BELOW_MINIMUM"]);
  });
});
