import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  StaticSourceAdapter,
  getOfficialSource,
} from "../../sources/src/index.ts";
import {
  PostgresEditorialNewsRepository,
  PostgresSourceRadarRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../database/src/index.ts";
import {
  EditorialWorkflowService,
  OfficialSourceRadarService,
} from "../src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
let pool: Pool;

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
});

after(async () => {
  await pool.end();
});

test("two PostgreSQL collections persist one aggregate and two fetch runs", async () => {
  const source = getOfficialSource("github-blog")!;
  const adapter = new StaticSourceAdapter(new Map([[source.id, [{
    sourceId: source.id,
    externalId: "postgres-idempotency-1",
    url: "https://github.blog/example/postgres-idempotency",
    title: "Official API automation update",
    summary: "Official update used only by the PostgreSQL integration test.",
    publishedAt: "2026-07-24T10:00:00.000Z",
    categories: ["apis"],
    rawFormat: "RSS" as const,
  }]]]));
  const radar = new OfficialSourceRadarService(
    new PostgresSourceRadarRepository(pool),
    new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool)),
    adapter,
  );

  const first = await radar.run(source, {
    mode: "FIXTURES",
    collectedAt: "2026-07-24T12:00:00.000Z",
  });
  const second = await radar.run(source, {
    mode: "FIXTURES",
    collectedAt: "2026-07-24T12:00:01.000Z",
  });

  assert.equal(first.fresh, 1);
  assert.equal(second.duplicates, 1);
  const evidence = await pool.query<{
    readonly news: string;
    readonly events: string;
    readonly items: string;
    readonly duplicates: string;
    readonly runs: string;
  }>(`
    SELECT
      (SELECT count(*) FROM editorial_news) AS news,
      (SELECT count(*) FROM audit_events) AS events,
      (SELECT count(*) FROM collected_source_items) AS items,
      (SELECT count(*) FROM source_item_duplicates) AS duplicates,
      (SELECT count(*) FROM source_fetch_runs) AS runs
  `);
  assert.deepEqual(evidence.rows[0], {
    news: "1",
    events: "3",
    items: "1",
    duplicates: "1",
    runs: "2",
  });
});
