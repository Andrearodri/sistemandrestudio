import { OfficialFeedClient } from "./feed-client.ts";
import { parseOfficialFeed } from "./feed-parser.ts";
import type { CollectedSourceItem, RadarLimits, SourceAdapter, SourceDefinition } from "./types.ts";

export class OfficialFeedSourceAdapter implements SourceAdapter {
  readonly #client: OfficialFeedClient;
  constructor(client = new OfficialFeedClient()) { this.#client = client; }
  async collect(source: SourceDefinition, limits: RadarLimits): Promise<readonly CollectedSourceItem[]> {
    const feed = await this.#client.fetch(source, limits);
    return parseOfficialFeed(source, feed.body, limits);
  }
}

export class StaticSourceAdapter implements SourceAdapter {
  readonly #items: ReadonlyMap<string, readonly CollectedSourceItem[]>;
  constructor(items: ReadonlyMap<string, readonly CollectedSourceItem[]>) { this.#items = items; }
  async collect(source: SourceDefinition, limits: RadarLimits): Promise<readonly CollectedSourceItem[]> { return (this.#items.get(source.id) ?? []).slice(0, limits.maxItemsPerSource); }
}
