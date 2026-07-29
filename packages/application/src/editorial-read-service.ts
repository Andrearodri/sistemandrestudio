import {
  EDITORIAL_STATES,
  type EditorialNews,
  type EditorialState,
} from "../../content-engine/src/index.ts";

export const EDITORIAL_READ_SCOPE = "editorial:read";
export const EDITORIAL_READ_DEFAULT_LIMIT = 25;
export const EDITORIAL_READ_MAX_LIMIT = 100;

export interface EditorialItemSummary {
  readonly newsId: string;
  readonly state: EditorialState;
  readonly source: {
    readonly id: string;
    readonly name: string;
    readonly isOfficial: boolean;
  };
  readonly title: string;
  readonly canonicalUrl: string | null;
  readonly publishedAt: string;
  readonly receivedAt: string;
  readonly relevanceScore: number | null;
  readonly currentDraftVersionId: string | null;
  readonly updatedAt: string;
}

export interface EditorialEvidenceView {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly claim: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly authority: string;
  readonly evidenceType: string;
  readonly publishedAt?: string;
  readonly eventDate?: string;
  readonly retrievedAt: string;
  readonly excerpt?: string;
  readonly supportsClaim: boolean;
  readonly contradictsClaim: boolean;
}

export interface EditorialDraftView {
  readonly draftId: string;
  readonly newsId: string;
  readonly version: number;
  readonly sourceDraftId: string | null;
  readonly format: string;
  readonly language: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly validationStatus: string;
  readonly warnings: readonly string[];
  readonly citations: readonly {
    readonly evidenceId: string;
    readonly claimId: string;
    readonly sourceId: string;
    readonly canonicalUrl: string;
    readonly title: string;
    readonly publishedAt?: string;
  }[];
  readonly createdAt: string;
}

export interface EditorialReadRepository {
  health(): Promise<{ readonly database: "available" }>;
  systemStatus(): Promise<{
    readonly database: "available";
    readonly itemsByState: Readonly<Partial<Record<EditorialState, number>>>;
    readonly pendingHumanDecisions: number;
  }>;
  listItems(input: {
    readonly state?: EditorialState;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly EditorialItemSummary[]>;
  findItem(newsId: string): Promise<EditorialNews | undefined>;
  listEvidence(input: {
    readonly newsId: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly EditorialEvidenceView[] | undefined>;
  findDraft(input: {
    readonly draftId: string;
    readonly version?: number;
  }): Promise<EditorialDraftView | undefined>;
}

export class EditorialReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EditorialReadError";
    this.code = code;
  }
}

export class EditorialReadService {
  private readonly repository: EditorialReadRepository;

  constructor(repository: EditorialReadRepository) {
    this.repository = repository;
  }

  health() {
    return this.repository.health();
  }

  systemStatus() {
    return this.repository.systemStatus();
  }

  async listItems(input: {
    readonly state?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) {
    const state = validateState(input.state);
    const limit = validateLimit(input.limit);
    const offset = validateCursor(input.cursor);
    const rows = await this.repository.listItems({
      ...(state === undefined ? {} : { state }),
      limit: limit + 1,
      offset,
    });
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit),
      page: {
        limit,
        nextCursor: hasMore ? String(offset + limit) : null,
      },
    };
  }

  async getItem(newsId: string) {
    validateIdentifier(newsId, "newsId");
    const item = await this.repository.findItem(newsId);
    if (item === undefined) {
      throw new EditorialReadError(
        "EDITORIAL_READ_ITEM_NOT_FOUND",
        "Editorial item not found.",
      );
    }
    return safeItem(item);
  }

  async getEvidence(input: {
    readonly newsId: string;
    readonly limit?: number;
    readonly cursor?: string;
  }) {
    validateIdentifier(input.newsId, "newsId");
    const limit = validateLimit(input.limit);
    const offset = validateCursor(input.cursor);
    const rows = await this.repository.listEvidence({
      newsId: input.newsId,
      limit: limit + 1,
      offset,
    });
    if (rows === undefined) {
      throw new EditorialReadError(
        "EDITORIAL_READ_ITEM_NOT_FOUND",
        "Editorial item not found.",
      );
    }
    const hasMore = rows.length > limit;
    return {
      newsId: input.newsId,
      evidence: rows.slice(0, limit),
      page: {
        limit,
        nextCursor: hasMore ? String(offset + limit) : null,
      },
    };
  }

  async getDraft(draftId: string, version?: number) {
    validateIdentifier(draftId, "draftId");
    if (version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1 || version > 10_000)) {
      throw new EditorialReadError(
        "EDITORIAL_READ_VERSION_INVALID",
        "Draft version must be an integer between 1 and 10000.",
      );
    }
    const draft = await this.repository.findDraft({
      draftId,
      ...(version === undefined ? {} : { version }),
    });
    if (draft === undefined) {
      throw new EditorialReadError(
        "EDITORIAL_READ_DRAFT_NOT_FOUND",
        "Editorial draft not found.",
      );
    }
    return draft;
  }
}

function validateState(value: string | undefined): EditorialState | undefined {
  if (value === undefined) return undefined;
  if (!(EDITORIAL_STATES as readonly string[]).includes(value)) {
    throw new EditorialReadError(
      "EDITORIAL_READ_STATE_INVALID",
      "Editorial state is invalid.",
    );
  }
  return value as EditorialState;
}

function validateLimit(value: number | undefined) {
  const limit = value ?? EDITORIAL_READ_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 ||
    limit > EDITORIAL_READ_MAX_LIMIT) {
    throw new EditorialReadError(
      "EDITORIAL_READ_LIMIT_INVALID",
      `Limit must be an integer between 1 and ${EDITORIAL_READ_MAX_LIMIT}.`,
    );
  }
  return limit;
}

function validateCursor(value: string | undefined) {
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d{0,6})$/.test(value)) {
    throw new EditorialReadError(
      "EDITORIAL_READ_CURSOR_INVALID",
      "Pagination cursor is invalid.",
    );
  }
  return Number(value);
}

function validateIdentifier(value: string, field: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new EditorialReadError(
      "EDITORIAL_READ_IDENTIFIER_INVALID",
      `${field} is invalid.`,
    );
  }
}

function safeItem(item: EditorialNews) {
  return {
    newsId: item.id,
    state: item.state,
    source: {
      id: item.source.id,
      name: item.source.name,
      isOfficial: item.source.isOfficial,
    },
    title: item.title,
    originalUrl: item.originalUrl,
    canonicalUrl: item.canonicalUrl,
    publishedAt: item.publishedAt,
    eventAt: item.eventAt,
    receivedAt: item.receivedAt,
    duplicateOfNewsId: item.duplicateOfNewsId,
    relevance: item.relevance,
    verification: item.verification,
    currentDraftVersionId: item.currentDraftVersionId,
    currentApprovalRequestId: item.currentApprovalRequestId,
    draftVersionCount: item.draftVersions.length,
    auditEventCount: item.auditEvents.length,
  };
}
