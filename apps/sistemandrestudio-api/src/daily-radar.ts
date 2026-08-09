import { createHash } from "node:crypto";

import { EditorialWorkflowService, OfficialSourceRadarService, type EditorialOrchestrationRun, type EditorialOrchestrationStepType } from "../../../packages/application/src/index.ts";
import { OllamaEditorialTextGenerator } from "../../../packages/content-engine/src/index.ts";
import { DEFAULT_EVIDENCE_LIMITS, OfficialEvidenceAcquisitionService, buildDeterministicClaims } from "../../../packages/evidence/src/index.ts";
import {
  PostgresEditorialNewsRepository, PostgresEditorialOrchestrationRepository, PostgresEvidenceAcquisitionRepository,
  PostgresSourceRadarRepository, checkDatabaseConnection, createDatabasePool, loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";
import { OfficialFeedSourceAdapter, getOfficialSource, listEnabledOfficialSources } from "../../../packages/sources/src/index.ts";
import {
  DAILY_RADAR_SOURCE_IDS, formatDailyRadarMessage, selectDailyRadarCandidates, signDailyRadarCallback,
  validateRadarSummary, type DailyRadarCandidate,
} from "./daily-radar-domain.ts";

guardEnvironment();
const pool = createDatabasePool(loadDatabaseConfig());
const startedAt = new Date();
try {
  await checkDatabaseConnection(pool);
  const roundKey = `daily-radar:${localDate(startedAt)}`;
  const prior = await pool.query<{ id: string; status: string }>("SELECT id,status FROM editorial_orchestration_runs WHERE trigger_key=$1", [roundKey]);
  if (prior.rows[0]) {
    console.log(JSON.stringify({ ok: true, replayed: true, runId: prior.rows[0].id, status: prior.rows[0].status, llmCalls: 0, telegramMessages: 0, publicationEnabled: false }));
    process.exit(0);
  }

  const sources = listEnabledOfficialSources().filter((source) => DAILY_RADAR_SOURCE_IDS.includes(source.id));
  const radar = new OfficialSourceRadarService(
    new PostgresSourceRadarRepository(pool),
    new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool)),
    new OfficialFeedSourceAdapter(),
  );
  const collectedAt = startedAt.toISOString();
  const reports = await radar.runAll(sources, { mode: "READ_ONLY_EXTERNAL", collectedAt, actorId: "daily-radar-manual" });
  const recent = await recentEvidenceCandidates(startedAt);
  const evidenceService = new OfficialEvidenceAcquisitionService(
    new PostgresEvidenceAcquisitionRepository(pool), undefined, DEFAULT_EVIDENCE_LIMITS,
  );
  const evidenceReports: { id: string; result: string }[] = [];
  for (const item of recent.filter((candidate) => candidate.state === "PENDING_VERIFICATION")) {
    const claims = buildDeterministicClaims({ newsId: item.newsId, title: item.title, summary: item.summary ?? undefined, publishedAt: item.publishedAt });
    if (claims.claims.length === 0) { evidenceReports.push({ id: item.id, result: "NO_VERIFIABLE_CLAIM" }); continue; }
    try {
      const result = await evidenceService.acquire({
        acquisitionId: `daily-radar-acquisition-${safe(item.id)}`, radarItemId: item.id,
        verificationId: `daily-radar-verification-${safe(item.id)}`, commandId: `daily-radar-evidence-${safe(item.id)}`,
        idempotencyKey: `daily-radar-evidence:${item.id}`, expectedVersion: item.newsVersion,
        actor: { type: "SYSTEM", id: "daily-radar-manual" }, occurredAt: item.publishedAt,
        retrievedAt: new Date().toISOString(), identityMode: "CONTENT_VERSIONED", claims: claims.claims,
      });
      evidenceReports.push({ id: item.id, result: result.verificationStatus });
    } catch (error) {
      evidenceReports.push({ id: item.id, result: error instanceof Error && "code" in error ? String(error.code) : "EVIDENCE_FAILED" });
    }
  }

  const eligible = selectDailyRadarCandidates(await verifiedCandidates(startedAt), 5);
  const generator = OllamaEditorialTextGenerator.fromEnvironment();
  const summarized: (DailyRadarCandidate & { summary: string })[] = [];
  let llmCalls = 0;
  const generationTimes: number[] = [];
  for (const item of eligible) {
    const before = performance.now();
    const summary = await generator.generateRadarSummary({
      title: item.title, sourceName: item.sourceName, officialLink: item.officialLink, supportedFacts: item.supportedFacts,
    });
    llmCalls += 1;
    generationTimes.push(Math.round(performance.now() - before));
    summarized.push({ ...item, summary: validateRadarSummary(summary) });
  }
  const message = formatDailyRadarMessage(summarized);
  if (message.length > 3_900) throw new Error("DAILY_RADAR_TELEGRAM_MESSAGE_TOO_LARGE");
  const runId = `daily-radar-${digest({ roundKey, items: summarized.map((item) => item.newsId) }).slice(0, 20)}`;
  const now = new Date().toISOString();
  const stepTypes: readonly EditorialOrchestrationStepType[] = [
    "RADAR_INGESTION", "RELEVANCE_EVALUATION", "EVIDENCE_ACQUISITION", "FACTUAL_VERIFICATION",
    "DRAFT_GENERATION", "HUMAN_REVIEW_NOTIFICATION", "HUMAN_DECISION", "PUBLICATION_PACKAGE_PREPARATION",
  ];
  const completed = new Set(stepTypes.slice(0, 5));
  const run: EditorialOrchestrationRun = {
    id: runId, policyId: "andre-studio-daily-radar", policyVersion: "andre-studio-daily-radar-v1",
    triggerType: "MANUAL", triggerKey: roundKey, triggeredBy: "daily-radar-manual", status: "RUNNING",
    startedAt: now, functionalFingerprint: digest({ roundKey, candidates: summarized }), createdAt: now, updatedAt: now,
    steps: stepTypes.map((stepType, position) => ({
      id: `${runId}:step:${position}`, runId, position, stepType,
      status: stepType === "PUBLICATION_PACKAGE_PREPARATION" ? "SKIPPED" : completed.has(stepType) ? "COMPLETED" : "PENDING",
      attemptCount: 0,
      ...(stepType === "DRAFT_GENERATION" ? { outputReference: { items: summarized, llmCalls, generationTimes } } : {}),
      ...(stepType === "RADAR_INGESTION" ? { outputReference: { reports } } : {}),
      ...(stepType === "EVIDENCE_ACQUISITION" ? { outputReference: { evidenceReports } } : {}),
      metadata: { scope: "daily-radar-manual", automaticPublication: false },
    })),
  };
  const repository = new PostgresEditorialOrchestrationRepository(pool);
  await repository.createRun(run, { id: `${runId}:started`, runId, eventType: "EDITORIAL_ORCHESTRATION_STARTED", metadata: { automaticPublication: false }, occurredAt: now });
  const sent = await telegram("sendMessage", {
    chat_id: required("TELEGRAM_APPROVER_CHAT_ID"), text: message,
    reply_markup: { inline_keyboard: [
      ...summarized.map((_, index) => [{ text: `Gerar rascunho #${index + 1}`, callback_data: signDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"), runId, `select-${index + 1}`) }]),
      [{ text: "Encerrar pauta", callback_data: signDailyRadarCallback(required("TELEGRAM_WEBHOOK_SECRET"), runId, "end") }],
    ] },
  }) as { result?: { message_id?: number } };
  const messageId = sent.result?.message_id;
  if (!Number.isSafeInteger(messageId)) throw new Error("DAILY_RADAR_TELEGRAM_RESPONSE_INVALID");
  await repository.completeStep({ runId, stepType: "HUMAN_REVIEW_NOTIFICATION", outputReference: { telegramMessageId: messageId, itemCount: summarized.length }, occurredAt: new Date().toISOString() });
  await repository.updateRunStatus({ runId, status: "WAITING_HUMAN_DECISION", occurredAt: new Date().toISOString() });
  console.log(JSON.stringify({ ok: true, replayed: false, runId, sources: reports.map((r) => ({ sourceId: r.sourceId, status: r.status, fresh: r.fresh, duplicates: r.duplicates })), recentCandidates: recent.length, verifiedItems: summarized.length, titles: summarized.map((item) => item.title), llmCalls, generationTimes, telegramMessages: 1, publicationEnabled: false }));
} finally { await pool.end(); }

async function recentEvidenceCandidates(since: Date) {
  const rows = await pool.query<{ id:string; news_id:string; state:string; news_version:number; title:string; summary:string|null; published_at:string }>(`
    SELECT item.id,item.editorial_news_id news_id,news.state,news.lock_version news_version,item.title,item.summary,
           COALESCE(item.published_at,item.collected_at)::text published_at
    FROM collected_source_items item JOIN editorial_news news ON news.id=item.editorial_news_id
    WHERE item.source_id=ANY($1) AND COALESCE(item.published_at,item.collected_at)>=$2
      AND news.state IN ('PENDING_VERIFICATION','VERIFIED')
    ORDER BY COALESCE(item.published_at,item.collected_at) DESC LIMIT 25`, [DAILY_RADAR_SOURCE_IDS, new Date(since.getTime()-72*60*60*1000).toISOString()]);
  return rows.rows.map((row) => ({ id:row.id, newsId:row.news_id, state:row.state, newsVersion:row.news_version, title:row.title, summary:row.summary, publishedAt:new Date(row.published_at).toISOString() }));
}

async function verifiedCandidates(since: Date): Promise<DailyRadarCandidate[]> {
  const rows = await pool.query<any>(`
    SELECT item.editorial_news_id news_id,item.source_id,source.name source_name,item.title,item.canonical_url,
           COALESCE(item.published_at,item.collected_at)::text published_at,news.lock_version news_version,
           latest.id verification_id,COALESCE((relevance.result->>'value')::integer,0) relevance,
           COALESCE((SELECT jsonb_agg(DISTINCT claim.claim_text ORDER BY claim.claim_text)
             FROM verification_claim_results cr JOIN verification_claims claim ON claim.id=cr.claim_id
             WHERE cr.result_id=latest.id AND cr.status='SUPPORTED'),'[]') supported_facts
    FROM collected_source_items item JOIN editorial_news news ON news.id=item.editorial_news_id
    JOIN source_definitions source ON source.id=item.source_id
    JOIN LATERAL (SELECT id,status FROM verification_results WHERE news_id=news.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) latest ON true
    LEFT JOIN editorial_relevance_results relevance ON relevance.news_id=news.id
    WHERE item.source_id=ANY($1) AND COALESCE(item.published_at,item.collected_at)>=$2
      AND news.state='VERIFIED' AND latest.status='CONFIRMED'
      AND NOT EXISTS (SELECT 1 FROM editorial_drafts draft WHERE draft.news_id=news.id)
    ORDER BY relevance DESC,COALESCE(item.published_at,item.collected_at) DESC`, [DAILY_RADAR_SOURCE_IDS, new Date(since.getTime()-72*60*60*1000).toISOString()]);
  return rows.rows.map((row:any)=>({ newsId:row.news_id,verificationId:row.verification_id,newsVersion:row.news_version,sourceId:row.source_id,sourceName:row.source_name,title:row.title,officialLink:row.canonical_url,publishedAt:new Date(row.published_at).toISOString(),relevance:row.relevance,supportedFacts:row.supported_facts }));
}

async function telegram(method:string, body:Record<string,unknown>) { const response=await fetch(`https://api.telegram.org/bot${required("TELEGRAM_BOT_TOKEN")}/${method}`,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(8_000)});const payload=await response.json() as {ok?:boolean};if(!response.ok||payload.ok!==true)throw new Error(`Telegram ${method} failed.`);return payload; }
function guardEnvironment(){if(process.env.DRY_RUN_ORCHESTRATION!=="true"||process.env.PUBLICATION_ENABLED!=="false"||process.env.HUMAN_DECISION_CHANNEL!=="TELEGRAM")throw new Error("Daily radar requires dry run, blocked publication and Telegram.");if(process.env.LLM_MODEL!=="gemma4:e2b-it-qat")throw new Error("Authorized Gemma model is required.");}
function required(name:string){const value=process.env[name]?.trim();if(!value)throw new Error(`${name} is required.`);return value;}
function digest(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function safe(value:string){return value.replace(/[^A-Za-z0-9_-]/g,"-").slice(0,100);}
function localDate(date:Date){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/Fortaleza",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);const get=(type:string)=>parts.find((part)=>part.type===type)!.value;return `${get("year")}-${get("month")}-${get("day")}`;}
