import {
  DEFAULT_EVIDENCE_LIMITS,
  diagnoseEvidenceAssociations,
} from "../../../packages/evidence/src/index.ts";
import type {
  EvidenceAssociationDiagnosticReport,
  EvidenceDiagnosticCode,
} from "../../../packages/evidence/src/index.ts";
import {
  checkDatabaseConnection,
  createDatabasePool,
  listStoredEvidenceDiagnosticItems,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";

const mode = process.argv.includes("--apply-validated-improvements")
  ? "APPLY_VALIDATED_IMPROVEMENTS" as const
  : "DIAGNOSE_ONLY" as const;

if (mode !== "DIAGNOSE_ONLY") {
  throw new Error(
    "APPLY_VALIDATED_IMPROVEMENTS is executed only by the normal acquisition command.",
  );
}

const pool = createDatabasePool(loadDatabaseConfig());
try {
  await checkDatabaseConnection(pool);
  const before = await readOnlyCounts();
  const items = await listStoredEvidenceDiagnosticItems(
    pool,
    DEFAULT_EVIDENCE_LIMITS.maxItemsPerRun,
  );
  const reports = items.map((item) => ({
    item,
    diagnostic: diagnoseEvidenceAssociations(
      item.sourceId,
      item.claims,
      item.pages,
      DEFAULT_EVIDENCE_LIMITS,
      mode,
    ),
  }));
  for (const { item, diagnostic } of reports) {
    console.log(JSON.stringify({
      type: "EVIDENCE_DIAGNOSTIC_ITEM",
      mode,
      fonte: item.sourceId,
      titulo: bounded(item.title, 120),
      url: bounded(item.canonicalUrl, 300),
      tipoPagina: item.pages.map((page) => page.pageType),
      statusFactualAtual: item.factualStatus,
      claims: diagnostic.claims.map((claim) => ({
        id: claim.id,
        texto: bounded(claim.text, 300),
        tipo: claim.type,
        importancia: claim.importance,
        entidades: claim.entities,
        versao: claim.version,
        codigos: claim.codes,
      })),
      paginas: item.pages.map((page) => ({
        relacionamento: page.relationship,
        tipo: page.pageType,
        titulo: bounded(page.title, 300),
        headings: page.headings.slice(0, 10).map((value) => bounded(value, 300)),
        datas: {
          publicacao: page.metadata.publishedAt,
          atualizacao: page.metadata.updatedAt,
        },
        metadados: {
          organizacao: boundedOptional(page.metadata.organization),
          produto: boundedOptional(page.metadata.product),
          versao: boundedOptional(page.metadata.version),
          disponibilidade: boundedOptional(page.metadata.availability),
        },
      })),
      candidatos: diagnostic.candidates.map((candidate) => ({
        claimId: candidate.claimId,
        pagina: bounded(candidate.pageUrl, 300),
        regra: candidate.rule,
        resultado: candidate.accepted ? "ACCEPTED" : "REJECTED",
        codigo: candidate.code,
        motivo: bounded(candidate.reason, 300),
        entidade: {
          metodo: candidate.entityMatch,
          claim: candidate.claimEntities,
          pagina: candidate.pageEntities.slice(0, 10),
          correspondentes: candidate.matchedEntities,
        },
        datas: candidate.dates,
        ausentes: candidate.missingFields,
        score: candidate.score,
      })),
      paginasRelacionadas: {
        aceitas: item.pages
          .filter((page) => page.relationship !== "PRIMARY_ARTICLE")
          .map((page) => ({
            url: bounded(page.canonicalUrl, 300),
            tipo: page.pageType,
            relacionamento: page.relationship,
          })),
        rejeitadas: [],
        observacao: item.pages.some((page) =>
            page.relationship !== "PRIMARY_ARTICLE"
          )
          ? "Only fetched related pages are recoverable from existing snapshots."
          : "No fetched related page is recoverable for this acquisition.",
      },
      funil: diagnostic.funnel,
      bloqueioFinal: diagnostic.primaryBlocker,
    }));
  }
  const after = await readOnlyCounts();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("DIAGNOSE_ONLY altered persistent state.");
  }
  console.log(JSON.stringify({
    type: "EVIDENCE_DIAGNOSTIC_SUMMARY",
    mode,
    items: reports.length,
    ...aggregate(reports.map((report) => report.diagnostic)),
    stateChanged: false,
  }));
} finally {
  await pool.end();
}

async function readOnlyCounts() {
  const result = await pool.query<{
    readonly acquisitions: number;
    readonly snapshots: number;
    readonly candidates: number;
    readonly results: number;
    readonly events: number;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM evidence_acquisition_runs) acquisitions,
      (SELECT count(*)::integer FROM official_page_snapshots) snapshots,
      (SELECT count(*)::integer FROM evidence_candidates) candidates,
      (SELECT count(*)::integer FROM verification_results) results,
      (SELECT count(*)::integer FROM audit_events) events
  `);
  return result.rows[0]!;
}

function aggregate(reports: readonly EvidenceAssociationDiagnosticReport[]) {
  const rejected: Record<string, number> = {};
  let claims = 0;
  let candidates = 0;
  let accepted = 0;
  for (const report of reports) {
    claims += report.funnel.claimsCreated;
    candidates += report.funnel.candidatesExtracted;
    accepted += report.funnel.accepted;
    for (const candidate of report.candidates) {
      if (!candidate.accepted) {
        rejected[candidate.code] = (rejected[candidate.code] ?? 0) + 1;
      }
    }
  }
  const count = (codes: readonly EvidenceDiagnosticCode[]) =>
    Object.entries(rejected)
      .filter(([code]) => codes.includes(code as EvidenceDiagnosticCode))
      .reduce((sum, [, value]) => sum + value, 0);
  return {
    totalClaims: claims,
    totalCandidates: candidates,
    rejectedByType: count([
      "CLAIM_TYPE_UNSUPPORTED",
      "PAGE_TYPE_NOT_ELIGIBLE",
    ]),
    rejectedByEntity: count([
      "CLAIM_ENTITY_MISSING",
      "PAGE_ENTITY_NOT_MATCHED",
      "PAGE_TITLE_NOT_MATCHED",
    ]),
    rejectedByDate: count([
      "CLAIM_DATE_MISSING",
      "PAGE_DATE_NOT_MATCHED",
      "EVENT_DATE_AMBIGUOUS",
    ]),
    rejectedByAuthority: count(["EVIDENCE_AUTHORITY_INSUFFICIENT"]),
    rejectedBySpecificity: count([
      "CLAIM_TOO_GENERIC",
      "EVIDENCE_TEXT_NOT_SPECIFIC",
      "PERFORMANCE_PROOF_MISSING",
      "AVAILABILITY_PROOF_MISSING",
      "CONTENT_PROMOTIONAL_ONLY",
      "NO_VERIFIABLE_CLAIM",
    ]),
    accepted,
    rejectionCodes: rejected,
  };
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function boundedOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : bounded(value, 300);
}
