import {
  DEFAULT_EVIDENCE_LIMITS,
  EvidenceAcquisitionError,
  OfficialEvidenceAcquisitionService,
} from "../../../packages/evidence/src/index.ts";
import {
  PostgresEvidenceAcquisitionRepository,
  checkDatabaseConnection,
  createDatabasePool,
  listOperationalEvidenceItems,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  await checkDatabaseConnection(pool);
  await runMigrations(pool);
  const before = await persistedCounts();
  const items = await listOperationalEvidenceItems(
    pool,
    DEFAULT_EVIDENCE_LIMITS.maxItemsPerRun,
  );
  const service = new OfficialEvidenceAcquisitionService(
    new PostgresEvidenceAcquisitionRepository(pool),
    undefined,
    DEFAULT_EVIDENCE_LIMITS,
  );
  const reports: Record<string, unknown>[] = [];
  for (const item of items) {
    const occurredAt = (
      item.updatedAt ??
      item.publishedAt ??
      item.collectedAt
    );
    const claim = inferClaim(item.editorialNewsId, item.title);
    try {
      const result = await service.acquire({
        acquisitionId: `official-acquisition-request-${safeId(item.id)}`,
        radarItemId: item.id,
        verificationId: `official-verification-${safeId(item.id)}`,
        commandId: `official-evidence-command-${safeId(item.id)}`,
        idempotencyKey: `official-evidence:${item.id}`,
        expectedVersion: item.currentVersion,
        actor: { type: "SYSTEM", id: "official-evidence-validation" },
        occurredAt,
        retrievedAt: new Date().toISOString(),
        identityMode: "CONTENT_VERSIONED",
        claims: [claim],
      });
      reports.push({
        fonte: item.sourceId,
        titulo: abbreviate(item.title, 68),
        url: abbreviate(item.canonicalUrl, 72),
        hashAnterior: shortHash(result.previousContentHash),
        hashAtual: shortHash(result.currentContentHash),
        aquisicao: result.acquisitionOutcome,
        anterior: result.previousStatus,
        novo: result.verificationStatus,
        confianca: result.confidence,
        eventosAdicionais: result.eventsAdditional,
      });
    } catch (error) {
      reports.push({
        fonte: item.sourceId,
        titulo: abbreviate(item.title, 68),
        url: abbreviate(item.canonicalUrl, 72),
        hashAnterior: "",
        hashAtual: "",
        aquisicao: "FAILED",
        anterior: "INSUFFICIENT_EVIDENCE",
        novo: "INSUFFICIENT_EVIDENCE",
        confianca: 0,
        eventosAdicionais: 0,
        erro: error instanceof EvidenceAcquisitionError
          ? error.code
          : "EVIDENCE_ACQUISITION_FAILED",
      });
    }
  }
  const after = await persistedCounts();
  console.table(reports);
  console.log(JSON.stringify({
    type: "OFFICIAL_EVIDENCE_SUMMARY",
    evaluated: reports.length,
    classifications: countBy(reports, "novo"),
    acquisitionsNew: after.acquisitions - before.acquisitions,
    snapshotsNew: after.snapshots - before.snapshots,
    evidenceNew: after.evidence - before.evidence,
    verificationResultsNew: after.verificationResults -
      before.verificationResults,
    editorialEventsAdditional: after.editorialEvents - before.editorialEvents,
    authenticatedRequests: 0,
    generatedContent: 0,
    publications: 0,
  }));
} finally {
  await pool.end();
}

async function persistedCounts() {
  const counts = await pool.query<{
    readonly acquisitions: number;
    readonly snapshots: number;
    readonly evidence: number;
    readonly verification_results: number;
    readonly editorial_events: number;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM evidence_acquisition_runs) acquisitions,
      (SELECT count(*)::integer FROM official_page_snapshots) snapshots,
      (SELECT count(*)::integer FROM evidence_candidates) evidence,
      (SELECT count(*)::integer FROM verification_results) verification_results,
      (SELECT count(*)::integer FROM audit_events) editorial_events
  `);
  const row = counts.rows[0]!;
  return {
    acquisitions: row.acquisitions,
    snapshots: row.snapshots,
    evidence: row.evidence,
    verificationResults: row.verification_results,
    editorialEvents: row.editorial_events,
  };
}

function inferClaim(newsId: string, title: string) {
  const normalized = title.toLowerCase();
  const version = normalized.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/)?.[1];
  const type =
    version !== undefined && /\b(release|released|version)\b/.test(normalized)
      ? "VERSION_RELEASE" as const
      : /\b(deprecat|sunset|end of support)\b/.test(normalized)
        ? "DEPRECATION" as const
        : /\b(available|availability|general availability)\b/.test(normalized)
          ? "AVAILABILITY_CLAIM" as const
          : /\b(launch|launched|introducing|announc|release)\b/.test(normalized)
            ? "PRODUCT_LAUNCH" as const
            : "GENERAL_FACT" as const;
  return {
    id: `${newsId}-official-page-claim`,
    text: title,
    type,
    importance: "PRIMARY" as const,
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
}

function abbreviate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function shortHash(value: string | undefined): string {
  return value === undefined ? "" : value.slice(0, 12);
}

function countBy(
  rows: readonly Record<string, unknown>[],
  key: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "UNKNOWN");
    result[value] = (result[value] ?? 0) + 1;
  }
  return result;
}
