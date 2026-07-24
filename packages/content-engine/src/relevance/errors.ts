import { DomainError } from "../errors.ts";

export class InvalidRelevanceInputError extends DomainError {
  constructor(field: string) {
    super(
      "INVALID_RELEVANCE_INPUT",
      `Relevance input field ${field} is missing or invalid.`,
      { field },
    );
  }
}

export class InvalidRelevancePolicyError extends DomainError {
  constructor(field: string) {
    super(
      "INVALID_RELEVANCE_POLICY",
      `Relevance policy field ${field} is missing or invalid.`,
      { field },
    );
  }
}

export class InvalidDateRangeError extends DomainError {
  constructor(field: string) {
    super(
      "INVALID_DATE_RANGE",
      `Relevance date field ${field} is outside the accepted range.`,
      { field },
    );
  }
}

export class UnsupportedSourceTypeError extends DomainError {
  constructor(sourceType: string) {
    super(
      "UNSUPPORTED_SOURCE_TYPE",
      `Relevance source type ${sourceType} is not supported.`,
      { sourceType },
    );
  }
}

export class UnsupportedNoveltyTypeError extends DomainError {
  constructor(noveltyType: string) {
    super(
      "UNSUPPORTED_NOVELTY_TYPE",
      `Relevance novelty type ${noveltyType} is not supported.`,
      { noveltyType },
    );
  }
}
