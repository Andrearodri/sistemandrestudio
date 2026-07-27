export type LocalizedFactRejectionCode =
  | "EDITORIAL_REVIEW_LOCALIZED_FACT_NOT_EQUIVALENT"
  | "EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH"
  | "EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED";

export interface LocalizedFactPredicate {
  readonly id: string;
  readonly sourceLanguage: "en";
  readonly targetLanguage: "pt-BR";
  readonly sourcePredicate: string;
  readonly targetPredicates: readonly string[];
  readonly certaintyLevel: "OFFICIAL_ANNOUNCEMENT";
  readonly semanticType: "ANNOUNCEMENT";
}

export interface LocalizedFactMatchResult {
  readonly matched: boolean;
  readonly equivalenceId?: string;
  readonly entity?: string;
  readonly sourcePredicate?: string;
  readonly targetPredicate?: string;
  readonly targetStatement?: string;
  readonly sourceLanguage?: "en";
  readonly targetLanguage?: "pt-BR";
  readonly rejectionCode?: LocalizedFactRejectionCode;
}

export interface LocalizedFactEquivalentInput {
  readonly allowedFact: string;
  readonly revisedText: string;
  readonly sourceLanguage: "en";
  readonly targetLanguage: "pt-BR";
}

export const LOCALIZED_FACT_PREDICATES: readonly LocalizedFactPredicate[] = [
  {
    id: "official-announcement-en-to-pt-br-v1",
    sourceLanguage: "en",
    targetLanguage: "pt-BR",
    sourcePredicate: "was officially announced",
    targetPredicates: ["foi anunciado oficialmente"],
    certaintyLevel: "OFFICIAL_ANNOUNCEMENT",
    semanticType: "ANNOUNCEMENT",
  },
] as const;

export function isAllowedLocalizedFactEquivalent(
  input: LocalizedFactEquivalentInput,
): LocalizedFactMatchResult {
  const entry = LOCALIZED_FACT_PREDICATES.find(
    (candidate) =>
      candidate.sourceLanguage === input.sourceLanguage &&
      candidate.targetLanguage === input.targetLanguage,
  );
  if (entry === undefined) {
    return {
      matched: false,
      rejectionCode: "EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED",
    };
  }

  const source = stripTerminalPunctuation(normalizeSpacing(input.allowedFact));
  const sourceSuffix = ` ${entry.sourcePredicate}`;
  if (!source.toLocaleLowerCase("en").endsWith(sourceSuffix)) {
    return {
      matched: false,
      equivalenceId: entry.id,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      rejectionCode: "EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED",
    };
  }

  const entity = source.slice(0, -sourceSuffix.length).trim();
  if (entity.length === 0) {
    return {
      matched: false,
      equivalenceId: entry.id,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      rejectionCode: "EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH",
    };
  }

  for (const targetPredicate of entry.targetPredicates) {
    const targetStatement = `${entity} ${targetPredicate}`;
    if (containsStatement(input.revisedText, targetStatement)) {
      return {
        matched: true,
        equivalenceId: entry.id,
        entity,
        sourcePredicate: entry.sourcePredicate,
        targetPredicate,
        targetStatement: `${targetStatement}.`,
        sourceLanguage: entry.sourceLanguage,
        targetLanguage: entry.targetLanguage,
      };
    }
  }

  const normalizedText = normalizeComparable(input.revisedText);
  const normalizedEntity = normalizeComparable(entity);
  const hasSupportedTargetPredicate = entry.targetPredicates.some((predicate) =>
    normalizedText.includes(normalizeComparable(predicate)),
  );
  return {
    matched: false,
    equivalenceId: entry.id,
    entity,
    sourcePredicate: entry.sourcePredicate,
    sourceLanguage: entry.sourceLanguage,
    targetLanguage: entry.targetLanguage,
    rejectionCode: hasSupportedTargetPredicate
      ? "EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH"
      : normalizedText.includes(normalizedEntity)
        ? "EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED"
        : "EDITORIAL_REVIEW_LOCALIZED_FACT_NOT_EQUIVALENT",
  };
}

function containsStatement(text: string, statement: string): boolean {
  const pattern = normalizeSpacing(statement)
    .split(" ")
    .map(escapeRegularExpression)
    .join("\\s+");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${pattern}(?=$|[\\s.!?;,])`,
    "iu",
  ).test(text);
}

function normalizeComparable(value: string): string {
  return stripTerminalPunctuation(normalizeSpacing(value))
    .toLocaleLowerCase("pt-BR");
}

function normalizeSpacing(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?]+\s*$/u, "").trim();
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
