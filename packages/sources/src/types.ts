export type SourceFeedFormat = "RSS" | "ATOM" | "AUTO";
export type SourceExecutionMode = "READ_ONLY_EXTERNAL" | "FIXTURES";

export interface SourceDefinition {
  readonly id: string;
  readonly name: string;
  readonly organization: string;
  readonly feedUrl: string;
  readonly feedFormat: SourceFeedFormat;
  readonly authority: "OFFICIAL";
  readonly topics: readonly string[];
  readonly enabled: boolean;
  readonly minimumIntervalMinutes: number;
  readonly retentionDays: number;
  readonly allowedHosts: readonly string[];
  readonly notes: string;
}

export interface RadarLimits {
  readonly maxSources: number;
  readonly maxItemsPerSource: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxTitleLength: number;
  readonly maxSummaryLength: number;
  readonly maxRedirects: number;
  readonly maxRetries: number;
}

export const DEFAULT_RADAR_LIMITS: RadarLimits = {
  maxSources: 5,
  maxItemsPerSource: 10,
  timeoutMs: 8_000,
  maxResponseBytes: 1_000_000,
  maxTitleLength: 240,
  maxSummaryLength: 2_000,
  maxRedirects: 2,
  maxRetries: 1,
};

export interface CollectedSourceItem {
  readonly sourceId: string;
  readonly externalId?: string | undefined;
  readonly url: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly categories: readonly string[];
  readonly rawFormat: "RSS" | "ATOM";
}

export interface NormalizedSourceItem extends CollectedSourceItem {
  readonly canonicalUrl: string;
  readonly normalizedTitle: string;
  readonly normalizedSummary?: string | undefined;
  readonly contentHash: string;
}

export interface FetchedFeed {
  readonly body: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly statusCode: number;
  readonly responseBytes: number;
  readonly redirectCount: number;
}

export interface SourceAdapter {
  collect(
    source: SourceDefinition,
    limits: RadarLimits,
  ): Promise<readonly CollectedSourceItem[]>;
}
