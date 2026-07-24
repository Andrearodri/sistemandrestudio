import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1,
  evaluateVerification,
} from "../../../packages/content-engine/src/index.ts";
import {
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import {
  getOfficialSource,
} from "../../../packages/sources/src/index.ts";

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);
const evaluatedAt = new Date().toISOString();

try {
  await checkDatabaseConnection(pool);
  await runMigrations(pool);
  const items = await pool.query<{
    readonly id: string;
    readonly source_id: string;
    readonly title: string;
    readonly canonical_url: string;
    readonly editorial_news_id: string;
    readonly relevance: {
      readonly value?: number | undefined;
    } | null;
  }>(
    `SELECT item.id, item.source_id, item.title, item.canonical_url,
            item.editorial_news_id, relevance.result AS relevance
     FROM collected_source_items item
     JOIN source_definitions source ON source.id = item.source_id
     LEFT JOIN editorial_relevance_results relevance
       ON relevance.news_id = item.editorial_news_id
     WHERE source.enabled = true
       AND item.editorial_news_id IS NOT NULL
     ORDER BY item.collected_at DESC, item.id
     LIMIT 5`,
  );

  const reports = [];
  const counts = new Map<string, number>();
  for (const item of items.rows) {
    const source = getOfficialSource(item.source_id);
    if (source === undefined || !isAllowedItemUrl(item.canonical_url, source.allowedHosts)) {
      continue;
    }
    const claimId = `${item.id}-deterministic-title-claim`;
    // A title is a claim candidate, not evidence of its own truth. No network
    // lookup is made, so the honest result is insufficient evidence.
    const result = evaluateVerification({
      verificationId: `official-readonly-${item.id}`,
      newsId: item.editorial_news_id,
      claims: [{
        id: claimId,
        text: item.title,
        type: inferClaimType(item.title),
        importance: "PRIMARY",
      }],
      evidence: [],
      allowedSourceIds: [source.id],
      policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1,
      evaluatedAt,
    });
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
    reports.push({
      fonte: source.id,
      titulo: abbreviate(item.title, 72),
      relevancia: item.relevance?.value ?? null,
      claims: 1,
      evidencias: 0,
      status: result.status,
      confianca: result.confidence,
      decisao: result.editorialDecision,
      replay: "read-only/deterministic",
    });
  }

  console.table(reports);
  console.log(JSON.stringify({
    type: "OFFICIAL_VERIFICATION_SUMMARY",
    evaluated: reports.length,
    classifications: Object.fromEntries([...counts].sort()),
    networkRequests: 0,
    mutations: 0,
  }));
} finally {
  await pool.end();
}

function inferClaimType(title: string) {
  const normalized = title.toLocaleLowerCase("en");
  if (/\b(v?\d+\.\d+|release|released)\b/.test(normalized)) {
    return "VERSION_RELEASE" as const;
  }
  if (/\b(security|vulnerability|cve)\b/.test(normalized)) {
    return "SECURITY_ADVISORY" as const;
  }
  if (/\b(api|deprecat)\b/.test(normalized)) {
    return "API_CHANGE" as const;
  }
  return "GENERAL_FACT" as const;
}

function isAllowedItemUrl(
  value: string,
  allowedHosts: readonly string[],
): boolean {
  const url = new URL(value);
  return url.protocol === "https:" &&
    allowedHosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    );
}

function abbreviate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
