export class SourceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

export class SourceFetchError extends SourceError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SourceFetchError";
  }
}

export class FeedParseError extends SourceError {
  constructor(message: string) {
    super("FEED_PARSE_FAILED", message);
    this.name = "FeedParseError";
  }
}
