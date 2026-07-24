import { performance } from "node:perf_hooks";

import {
  EditorialWorkflowService,
  OfficialSourceRadarService,
} from "../../../packages/application/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresSourceRadarRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../../packages/database/src/index.ts";
import {
  DEFAULT_RADAR_LIMITS,
  OFFICIAL_SOURCE_CATALOG,
  OfficialFeedClient,
  StaticSourceAdapter,
  parseOfficialFeed,
} from "../../../packages/sources/src/index.ts";
import type {
  CollectedSourceItem,
  SourceAdapter,
  SourceDefinition,
} from "../../../packages/sources/src/index.ts";

const VALIDATION_LIMITS = {
  ...DEFAULT_RADAR_LIMITS,
  maxItemsPerSource: 3,
};
const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  await checkDatabaseConnection(pool);
  await resetTestDatabase(pool, config);

  const snapshots = new Map<string, readonly CollectedSourceItem[]>();
  const diagnostics = new Map<string, Record<string, unknown>>();
  const client = new OfficialFeedClient();

  for (const source of OFFICIAL_SOURCE_CATALOG) {
    if (!source.enabled) {
      diagnostics.set(source.id, {
        sourceId: source.id,
        organization: source.organization,
        configuredUrl: source.feedUrl,
        expectedFormat: source.feedFormat,
        status: "DISABLED_NO_OFFICIAL_FEED",
      });
      continue;
    }
    try {
      const fetched = await client.fetch(source, VALIDATION_LIMITS);
      const items = parseOfficialFeed(source, fetched.body, VALIDATION_LIMITS);
      snapshots.set(source.id, items);
      diagnostics.set(source.id, {
        sourceId: source.id,
        organization: source.organization,
        configuredUrl: source.feedUrl,
        expectedFormat: source.feedFormat,
        receivedFormat: items[0]?.rawFormat ?? "EMPTY",
        finalHost: new URL(fetched.finalUrl).hostname,
        contentType: fetched.contentType,
        httpStatus: fetched.statusCode,
        responseBytes: fetched.responseBytes,
        redirects: fetched.redirectCount,
        items: items.length,
        parser: "SUCCEEDED",
        status: "ENABLED_VALIDATED",
      });
    } catch (error) {
      diagnostics.set(source.id, {
        sourceId: source.id,
        organization: source.organization,
        configuredUrl: source.feedUrl,
        expectedFormat: source.feedFormat,
        parser: "FAILED",
        status: "FAILED_TEMPORARILY",
        errorCode: safeErrorCode(error),
      });
    }
  }

  console.log(JSON.stringify({ type: "SOURCE_DIAGNOSTICS", sources: [...diagnostics.values()] }));

  const editorialRepository = new PostgresEditorialNewsRepository(pool);
  const radarRepository = new PostgresSourceRadarRepository(pool);
  const workflow = new EditorialWorkflowService(editorialRepository);
  const firstRoundAt = new Date();
  const rounds = [
    firstRoundAt.toISOString(),
    new Date(firstRoundAt.getTime() + 1_000).toISOString(),
  ] as const;

  for (const [index, collectedAt] of rounds.entries()) {
    const reports: Record<string, unknown>[] = [];
    for (const source of OFFICIAL_SOURCE_CATALOG) {
      const started = performance.now();
      const adapter = adapterFor(source, snapshots);
      const radar = new OfficialSourceRadarService(
        radarRepository,
        workflow,
        adapter,
        VALIDATION_LIMITS,
      );
      const report = await radar.run(source, {
        mode: "READ_ONLY_EXTERNAL",
        collectedAt,
        actorId: "radar-validation",
      });
      reports.push({
        sourceId: source.id,
        status: report.status,
        received: report.found,
        normalized: report.normalized,
        fresh: report.fresh,
        exactDuplicates: report.duplicates,
        similar: report.similar,
        classified: report.classified,
        controlledErrors: report.errorCode === undefined ? [] : [report.errorCode],
        durationMs: Math.round(performance.now() - started),
      });
    }
    console.log(JSON.stringify({
      type: "RADAR_VALIDATION_ROUND",
      round: index + 1,
      reports,
      database: await databaseEvidence(),
    }));
  }
} finally {
  await pool.end();
}

function adapterFor(
  source: SourceDefinition,
  snapshots: ReadonlyMap<string, readonly CollectedSourceItem[]>,
): SourceAdapter {
  const items = snapshots.get(source.id);
  if (items !== undefined) {
    return new StaticSourceAdapter(new Map([[source.id, items]]));
  }
  return {
    async collect(): Promise<never> {
      throw new Error("SOURCE_DIAGNOSTIC_FAILED");
    },
  };
}

async function databaseEvidence(): Promise<Record<string, number>> {
  const result = await pool.query<{
    readonly news_count: string;
    readonly event_count: string;
    readonly item_count: string;
    readonly run_count: string;
  }>(`
    SELECT
      (SELECT count(*) FROM editorial_news WHERE source->>'id' IN (
        SELECT id FROM source_definitions
      )) AS news_count,
      (SELECT count(*) FROM audit_events WHERE news_id IN (
        SELECT id FROM editorial_news WHERE source->>'id' IN (
          SELECT id FROM source_definitions
        )
      )) AS event_count,
      (SELECT count(*) FROM collected_source_items) AS item_count,
      (SELECT count(*) FROM source_fetch_runs) AS run_count
  `);
  const row = result.rows[0]!;
  return {
    editorialAggregates: Number(row.news_count),
    editorialEvents: Number(row.event_count),
    collectedItems: Number(row.item_count),
    fetchRuns: Number(row.run_count),
  };
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error
      ? error.name
      : "UNKNOWN_ERROR";
}
