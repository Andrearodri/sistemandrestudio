import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LocalPublicationExporter,
  LocalWebsitePublicationPackageReader,
  PublicationReconciliationService,
  reconciliationIdempotencyKey,
} from "../../../packages/application/src/index.ts";
import {
  PostgresPublicationPackageRepository,
  PostgresPublicationReconciliationRepository,
  createDatabasePool,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";
import { simulatedPublicVerifier } from "./publication-reconciliation-demo-support.ts";

const root = await mkdtemp(join(
  tmpdir(),
  "publication-reconciliation-pg-demo-",
));
let pool = createDatabasePool(loadDatabaseConfig());

try {
  let reconciliationRepository =
    new PostgresPublicationReconciliationRepository(pool);
  const previous = (await reconciliationRepository.list()).find((item) =>
    item.deploymentTargetLabel === "Local PostgreSQL demo fixture"
  );
  if (previous === undefined) {
    await pool.end();
    execFileSync("npm", ["run", "demo:publication:postgres"], {
      stdio: "ignore",
    });
    pool = createDatabasePool(loadDatabaseConfig());
    reconciliationRepository =
      new PostgresPublicationReconciliationRepository(pool);
  }
  const packages = await new PostgresPublicationPackageRepository(pool).list();
  const pkg = previous === undefined
    ? packages.find((item) =>
      item.destination === "WEBSITE_EXPORT" &&
      item.status === "READY_FOR_PUBLICATION" &&
      item.title.includes("Orbit 2.0") &&
      item.publicationId !== "publication-d8d1213c06e895458cb07531"
    )
    : packages.find((item) =>
      item.publicationId === previous.publicationPackageId
    );
  if (pkg === undefined) {
    throw new Error("Non-real website demo package was not found.");
  }
  await new LocalPublicationExporter(root).export(pkg);
  const url = `https://andrestudio.dev.br/blog/${pkg.slug}/`;
  const identity = {
    publicationId: pkg.publicationId,
    draftId: pkg.draftId,
    operatorId: "andre-local",
    origin: "MANUAL_SUPERVISED_DEPLOY" as const,
    publicUrl: url,
    canonicalUrl: url,
    websiteCommit: "7ea0d4a",
  };
  const key = reconciliationIdempotencyKey(identity);
  const request = {
    ...identity,
    deploymentTarget: "Local PostgreSQL demo fixture",
    idempotencyKey: key,
    commandId: key,
  };
  const first = await new PublicationReconciliationService(
    reconciliationRepository,
    simulatedPublicVerifier(),
    new LocalWebsitePublicationPackageReader(root),
    () => "2026-07-28T12:00:00.000Z",
  ).reconcileExternalPublication(request);
  const events = await eventCount(pkg.publicationId);
  await pool.end();
  pool = createDatabasePool(loadDatabaseConfig());
  const reconnected = new PostgresPublicationReconciliationRepository(pool);
  const recovered = await reconnected.get(
    first.reconciliation.reconciliationId,
  );
  const replay = await new PublicationReconciliationService(
    reconnected,
    simulatedPublicVerifier(),
    new LocalWebsitePublicationPackageReader(root),
    () => "2026-07-28T13:00:00.000Z",
  ).reconcileExternalPublication(request);
  console.log(JSON.stringify({
    publicationPackage: pkg.publicationId,
    reconciliationId: first.reconciliation.reconciliationId,
    initialReconciliationAlreadyPresent: previous !== undefined,
    firstCallReplay: first.replayed,
    finalState: recovered?.finalState,
    recoveredAfterReconnect: recovered !== undefined,
    replayAfterReconnect: replay.replayed,
    events,
    eventsAdditionalOnReplay: await eventCount(pkg.publicationId) - events,
    deploymentsExecuted: 0,
    remoteWrites: 0,
  }, null, 2));
} finally {
  await pool.end().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

async function eventCount(publicationId: string): Promise<number> {
  return Number((await pool.query<{ readonly count: string }>(
    `SELECT count(*)
     FROM audit_events
     WHERE technical_payload->>'publicationId' = $1
       AND technical_payload ? 'reconciliationId'`,
    [publicationId],
  )).rows[0]?.count ?? 0);
}
