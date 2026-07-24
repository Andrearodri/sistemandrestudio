import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryEditorialNewsRepository,
} from "../../content-engine/src/index.ts";
import {
  DEFAULT_RADAR_LIMITS,
  StaticSourceAdapter,
  getOfficialSource,
} from "../../sources/src/index.ts";
import type {
  NormalizedSourceItem,
  SourceDefinition,
  SourceExecutionMode,
} from "../../sources/src/index.ts";
import {
  EditorialWorkflowService,
  OfficialSourceRadarService,
} from "../src/index.ts";

const source = getOfficialSource("github-blog")!;
const collectedAt = "2026-07-24T12:00:00.000Z";
const item = {
  sourceId: source.id,
  externalId: "official-item-1",
  url: "https://github.blog/example/official-item",
  title: "Official API automation update",
  summary: "A deterministic official update about APIs and automation.",
  publishedAt: "2026-07-24T10:00:00.000Z",
  categories: ["apis"],
  rawFormat: "RSS" as const,
};

test("a second collection records an exact duplicate before editorial scoring", async () => {
  const radarRepository = new MemoryRadarRepository();
  const editorialRepository = new InMemoryEditorialNewsRepository();
  const service = createService(radarRepository, editorialRepository, source, [item]);

  const first = await service.run(source, { mode: "FIXTURES", collectedAt });
  const second = await service.run(source, {
    mode: "FIXTURES",
    collectedAt: "2026-07-24T12:00:01.000Z",
  });

  assert.equal(first.fresh, 1);
  assert.equal(first.classified, 1);
  assert.equal(second.fresh, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(radarRepository.items.length, 1);
  assert.equal(radarRepository.duplicates.length, 1);
  const aggregate = await editorialRepository.findById(radarRepository.items[0]!.editorialNewsId);
  assert.equal(aggregate?.auditEvents.length, 3);
});

test("similar content is classified and is not converted into an exact duplicate", async () => {
  const radarRepository = new MemoryRadarRepository();
  const editorialRepository = new InMemoryEditorialNewsRepository();
  const similarItem = {
    ...item,
    externalId: "official-item-2",
    url: "https://github.blog/example/official-item-2",
    title: "Official automation API update",
  };
  const service = createService(radarRepository, editorialRepository, source, [item, similarItem]);
  const report = await service.run(source, { mode: "FIXTURES", collectedAt });

  assert.equal(report.fresh, 2);
  assert.equal(report.duplicates, 0);
  assert.equal(report.similar, 1);
  assert.equal(report.classified, 2);
});

test("a disabled source returns a structured skipped report", async () => {
  const disabled = { ...source, enabled: false };
  const report = await createService(
    new MemoryRadarRepository(),
    new InMemoryEditorialNewsRepository(),
    disabled,
    [],
  ).run(disabled, { mode: "FIXTURES", collectedAt });
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.classified, 0);
});

test("one source adapter failure does not prevent the next source report", async () => {
  const secondSource = getOfficialSource("cloudflare-blog")!;
  const radarRepository = new MemoryRadarRepository();
  const editorialRepository = new InMemoryEditorialNewsRepository();
  const adapter = {
    async collect(candidate: SourceDefinition) {
      if (candidate.id === source.id) throw new Error("controlled failure");
      return [{
        ...item,
        sourceId: candidate.id,
        externalId: "cloudflare-item-1",
        url: "https://blog.cloudflare.com/example-item",
      }];
    },
  };
  const service = new OfficialSourceRadarService(
    radarRepository,
    new EditorialWorkflowService(editorialRepository),
    adapter,
    DEFAULT_RADAR_LIMITS,
  );
  const reports = await service.runAll([source, secondSource], {
    mode: "FIXTURES",
    collectedAt,
  });
  assert.deepEqual(reports.map((report) => report.status), ["FAILED", "SUCCEEDED"]);
});

function createService(
  radarRepository: MemoryRadarRepository,
  editorialRepository: InMemoryEditorialNewsRepository,
  definition: SourceDefinition,
  items: readonly typeof item[],
): OfficialSourceRadarService {
  return new OfficialSourceRadarService(
    radarRepository,
    new EditorialWorkflowService(editorialRepository),
    new StaticSourceAdapter(new Map([[definition.id, items]])),
    DEFAULT_RADAR_LIMITS,
  );
}

class MemoryRadarRepository {
  readonly items: Array<{
    readonly item: NormalizedSourceItem;
    readonly editorialNewsId: string;
  }> = [];
  readonly duplicates: NormalizedSourceItem[] = [];

  async upsertSourceDefinition(): Promise<void> {}
  async startRun(
    _id: string,
    _sourceId: string,
    _mode: SourceExecutionMode,
    _startedAt: string,
  ): Promise<void> {}
  async finishRun(): Promise<void> {}
  async findExact(candidate: NormalizedSourceItem) {
    const stored = this.items.find(({ item: existing }) =>
      existing.sourceId === candidate.sourceId &&
      (
        existing.canonicalUrl === candidate.canonicalUrl ||
        existing.externalId === candidate.externalId ||
        existing.contentHash === candidate.contentHash
      ),
    );
    return stored === undefined
      ? undefined
      : { item: { id: stored.item.contentHash }, kind: "CANONICAL_URL" as const };
  }
  async recordDuplicate(candidate: NormalizedSourceItem): Promise<void> {
    this.duplicates.push(candidate);
  }
  async listBySource(sourceId: string) {
    return this.items
      .filter(({ item: candidate }) => candidate.sourceId === sourceId)
      .map(({ item: candidate }) => ({ normalizedTitle: candidate.normalizedTitle }));
  }
  async saveItem(
    candidate: NormalizedSourceItem,
    _collectedAt: string,
    editorialNewsId: string,
  ): Promise<void> {
    this.items.push({ item: candidate, editorialNewsId });
  }
}
