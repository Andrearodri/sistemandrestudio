import {
  EditorialDraftWorkflowService,
  EditorialWorkflowService,
  OfficialSourceRadarService,
  diagnoseOfficialDraftEligibility,
  officialItemLogicalIdentity,
} from "../../../packages/application/src/index.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  EvidenceAcquisitionError,
  OfficialEvidenceAcquisitionService,
  buildDeterministicClaims,
} from "../../../packages/evidence/src/index.ts";
import { createEditorialBrief, generateEditorialDraft } from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialDraftRepository,
  PostgresEditorialNewsRepository,
  PostgresEvidenceAcquisitionRepository,
  PostgresSourceRadarRepository,
  checkDatabaseConnection,
  createDatabasePool,
  listOperationalEvidenceItems,
  loadDatabaseConfig,
  runMigrations,
} from "../../../packages/database/src/index.ts";
import {
  OfficialFeedSourceAdapter,
  listEnabledOfficialSources,
} from "../../../packages/sources/src/index.ts";
import type { EditorialState, VerificationStatus } from "../../../packages/content-engine/src/index.ts";

const pool = createDatabasePool(loadDatabaseConfig());
const maximum = 10;
try {
  await checkDatabaseConnection(pool);
  await runMigrations(pool);
  const before = await counts();
  const historical = await diagnosticRows();
  console.log("Diagnóstico somente leitura dos itens oficiais recentes:");
  console.table(historical.map((row) => ({
    item: abbreviate(row.title, 48), fonte: row.source_id,
    estado: row.state, verificacao: row.verification_status ?? "MISSING",
    versao: row.lock_version,
    motivo: row.draft_exists ? "DRAFT_ALREADY_EXISTS" : row.historical_confirmed && row.state !== "VERIFIED" ? "VERIFICATION_HISTORICAL_ONLY" : diagnoseOfficialDraftEligibility({
      state: row.state, latestVerificationStatus: row.verification_status ?? undefined,
      latestVerificationIsCurrent: row.verification_current,
      confirmedClaims: row.confirmed_claims, draftExists: row.draft_exists,
    }),
  })));

  let items = await currentItems();
  const candidatesBeforeCollection = items.filter((item) => item.state === "PENDING_VERIFICATION" || item.state === "VERIFIED");
  const collectionReports: unknown[] = [];
  if (candidatesBeforeCollection.length === 0) {
    const workflow = new EditorialWorkflowService(new PostgresEditorialNewsRepository(pool));
    const radar = new OfficialSourceRadarService(new PostgresSourceRadarRepository(pool), workflow, new OfficialFeedSourceAdapter());
    const collectedAt = new Date().toISOString();
    for (const source of listEnabledOfficialSources()) {
      collectionReports.push(await radar.run(source, { mode: "READ_ONLY_EXTERNAL", collectedAt, actorId: "official-draft-pipeline" }));
    }
    items = await currentItems();
  }

  const evidenceService = new OfficialEvidenceAcquisitionService(
    new PostgresEvidenceAcquisitionRepository(pool), undefined,
    { ...DEFAULT_EVIDENCE_LIMITS, maxItemsPerRun: maximum },
  );
  const draftRepository = new PostgresEditorialDraftRepository(pool);
  const draftService = new EditorialDraftWorkflowService(draftRepository);
  const reports: Record<string, unknown>[] = [];

  for (const item of items.slice(0, maximum)) {
    const identity = officialItemLogicalIdentity({ sourceId: item.source_id, externalId: item.external_id ?? undefined, canonicalUrl: item.canonical_url, contentHash: item.content_hash, eventIdentity: item.updated_at ?? item.published_at ?? undefined });
    if (item.draft_exists) {
      reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "DRAFT", resultado: "REPLAY", estadoFinal: item.state, eventosAdicionais: 0 });
      continue;
    }
    if (item.state !== "PENDING_VERIFICATION" && item.state !== "VERIFIED") {
      reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "ELIGIBILITY", resultado: item.verification_historical ? "VERIFICATION_HISTORICAL_ONLY" : "EDITORIAL_STATE_NOT_VERIFIED", estadoFinal: item.state, eventosAdicionais: 0 });
      continue;
    }
    let verificationId = item.verification_id;
    let factualStatus = item.verification_status;
    let evidenceCount = 0;
    let claimsCount = item.confirmed_claims;
    let acquisitionReplay = true;
    if (item.state === "PENDING_VERIFICATION") {
      const claimResult = buildDeterministicClaims({ newsId: item.editorial_news_id, title: item.title, summary: item.summary ?? undefined, publishedAt: item.published_at ?? undefined });
      claimsCount = claimResult.claims.length;
      if (claimResult.claims.length === 0) {
        reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "CLAIMS", resultado: claimResult.codes.join(","), claims: 0, evidencias: 0, estadoFinal: item.state });
        continue;
      }
      try {
        const acquired = await evidenceService.acquire({
          acquisitionId: `pipeline-acquisition-${identity}`,
          radarItemId: item.id,
          verificationId: `pipeline-verification-${identity}`,
          commandId: `pipeline-verification-command-${identity}`,
          idempotencyKey: `pipeline-evidence:${identity}`,
          expectedVersion: item.lock_version,
          actor: { type: "SYSTEM", id: "official-draft-pipeline" },
          occurredAt: item.updated_at ?? item.published_at ?? item.collected_at,
          retrievedAt: new Date().toISOString(),
          identityMode: "CONTENT_VERSIONED",
          claims: claimResult.claims,
        });
        factualStatus = acquired.verificationStatus;
        evidenceCount = acquired.evidence;
        acquisitionReplay = acquired.replayed;
        verificationId = (await latestVerification(item.editorial_news_id))?.verification_id ?? null;
      } catch (error) {
        reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "EVIDENCE", resultado: error instanceof EvidenceAcquisitionError ? error.code : "EVIDENCE_ACQUISITION_FAILED", claims: claimsCount, evidencias: 0, estadoFinal: item.state });
        continue;
      }
    }
    if (factualStatus !== "CONFIRMED" || verificationId === null) {
      reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "VERIFICATION", resultado: factualStatus ?? "CURRENT_VERIFICATION_MISSING", claims: claimsCount, evidencias: evidenceCount, estadoFinal: (await currentState(item.editorial_news_id)).state });
      continue;
    }
    const context = await draftRepository.loadContext(item.editorial_news_id, verificationId);
    if (context === undefined || context.news.state !== "VERIFIED") {
      reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "DRAFT", resultado: "VERIFICATION_HISTORICAL_ONLY", claims: claimsCount, evidencias: evidenceCount, estadoFinal: context?.news.state ?? item.state });
      continue;
    }
    const occurredAt = context.verification.evaluatedAt;
    const brief = createEditorialBrief({ ...context, createdAt: occurredAt });
    const linkedinPreview = await generateEditorialDraft({ brief, format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 1500, editorialIdentityVersion: "andrestudio-dev-v1" });
    const website = await draftService.createDraft({ newsId: item.editorial_news_id, verificationId, format: "WEBSITE_NEWS_BRIEF", idempotencyKey: `pipeline-draft:${identity}:website`, commandId: `pipeline-draft-command:${identity}`, approvalRequestId: `pipeline-approval:${identity}`, expectedVersion: context.news.auditEvents.length, actor: { type: "SYSTEM", id: "official-draft-pipeline" }, occurredAt });
    reports.push({ item: abbreviate(item.title, 56), fonte: item.source_id, identidade: identity, etapa: "PENDING_APPROVAL", resultado: website.replayed ? "REPLAY" : "CREATED", relevancia: brief.relevanceScore, statusFactual: factualStatus, claims: brief.confirmedClaims.length, fatos: brief.allowedFacts.length, evidencias: brief.evidenceReferences.length, claimsProibidas: brief.prohibitedClaims.length, warnings: brief.warnings.length, citacoes: website.draft.sourceCitations.length, linkedin: linkedinPreview.validationStatus, website: website.draft.validationStatus, titulo: abbreviate(website.draft.title, 90), corpo: abbreviate(website.draft.body, 180), estadoFinal: website.currentState, evidenciaReplay: acquisitionReplay });
  }

  console.log("Fluxo oficial limitado:");
  console.table(reports);
  const after = await counts();
  console.log(JSON.stringify({ type: "OFFICIAL_DRAFT_PIPELINE_SUMMARY", policy: "andre-studio-official-draft-pipeline-v1", limit: maximum, collectionExecuted: collectionReports.length > 0, sourcesCollected: collectionReports.length, itemsEvaluated: reports.length, aggregatesAdditional: after.aggregates - before.aggregates, verificationsAdditional: after.verifications - before.verifications, draftsAdditional: after.drafts - before.drafts, approvalsAdditional: after.approvals - before.approvals, eventsAdditional: after.events - before.events, publications: 0, telegramMessages: 0, llmCalls: 0 }));
} finally { await pool.end(); }

type DiagnosticRow = { readonly title:string; readonly source_id:string; readonly state:EditorialState; readonly lock_version:number; readonly verification_status:VerificationStatus|null; readonly verification_current:boolean; readonly confirmed_claims:number; readonly draft_exists:boolean; readonly historical_confirmed:boolean };
async function diagnosticRows(): Promise<readonly DiagnosticRow[]> { const result=await pool.query<DiagnosticRow>(`SELECT item.title,item.source_id,news.state,news.lock_version,latest.status verification_status,(latest.status IS NOT NULL AND (latest.current_state='VERIFIED' OR news.state='VERIFIED')) verification_current,COALESCE(latest.confirmed_claims,0)::integer confirmed_claims,EXISTS(SELECT 1 FROM editorial_drafts draft WHERE draft.news_id=news.id) draft_exists,EXISTS(SELECT 1 FROM verification_results historical WHERE historical.news_id=news.id AND historical.status='CONFIRMED') historical_confirmed FROM collected_source_items item JOIN editorial_news news ON news.id=item.editorial_news_id LEFT JOIN LATERAL (SELECT result.status,run.current_state,(SELECT count(*) FROM verification_claim_results cr WHERE cr.result_id=result.id AND cr.status='SUPPORTED')::integer confirmed_claims FROM verification_results result JOIN verification_runs run ON run.id=result.run_id WHERE result.news_id=news.id ORDER BY result.evaluated_at DESC,result.id DESC LIMIT 1) latest ON true WHERE (news.source->>'isOfficial')::boolean=true AND lower(item.id)!~'(fixture|fictional|demo|test)' ORDER BY COALESCE(item.published_at,item.collected_at) DESC,item.id LIMIT 10`); return result.rows; }
type CurrentItem = { readonly id:string; readonly source_id:string; readonly external_id:string|null; readonly canonical_url:string; readonly content_hash:string; readonly title:string; readonly summary:string|null; readonly published_at:string|null; readonly updated_at:string|null; readonly collected_at:string; readonly editorial_news_id:string; readonly state:EditorialState; readonly lock_version:number; readonly verification_id:string|null; readonly verification_status:VerificationStatus|null; readonly confirmed_claims:number; readonly draft_exists:boolean; readonly verification_historical:boolean };
async function currentItems(): Promise<readonly CurrentItem[]> { const result=await pool.query<CurrentItem>(`SELECT item.id,item.source_id,item.external_id,item.canonical_url,item.content_hash,item.title,item.summary,item.published_at::text,item.updated_at_source::text updated_at,item.collected_at::text,item.editorial_news_id,news.state,news.lock_version,latest.id verification_id,latest.status verification_status,COALESCE(latest.confirmed_claims,0)::integer confirmed_claims,EXISTS(SELECT 1 FROM editorial_drafts draft WHERE draft.news_id=news.id) draft_exists,(news.state<>'VERIFIED' AND EXISTS(SELECT 1 FROM verification_results historical WHERE historical.news_id=news.id AND historical.status='CONFIRMED')) verification_historical FROM collected_source_items item JOIN editorial_news news ON news.id=item.editorial_news_id LEFT JOIN LATERAL (SELECT result.id,result.status,run.current_state,(SELECT count(*) FROM verification_claim_results cr WHERE cr.result_id=result.id AND cr.status='SUPPORTED')::integer confirmed_claims FROM verification_results result JOIN verification_runs run ON run.id=result.run_id WHERE result.news_id=news.id ORDER BY result.evaluated_at DESC,result.id DESC LIMIT 1) latest ON true WHERE (news.source->>'isOfficial')::boolean=true AND lower(item.id)!~'(fixture|fictional|demo|test)' ORDER BY COALESCE(item.published_at,item.collected_at) DESC,item.id LIMIT 10`); return result.rows.map((row)=>({...row,published_at:isoOrNull(row.published_at),updated_at:isoOrNull(row.updated_at),collected_at:new Date(row.collected_at).toISOString()})); }
async function latestVerification(newsId:string){const result=await pool.query<{verification_id:string}>(`SELECT id verification_id FROM verification_results WHERE news_id=$1 ORDER BY evaluated_at DESC,id DESC LIMIT 1`,[newsId]);return result.rows[0];}
async function currentState(newsId:string){const result=await pool.query<{state:EditorialState}>(`SELECT state FROM editorial_news WHERE id=$1`,[newsId]);return result.rows[0]!;}
async function counts(){const result=await pool.query<{aggregates:number;verifications:number;drafts:number;approvals:number;events:number}>(`SELECT (SELECT count(*)::integer FROM editorial_news) aggregates,(SELECT count(*)::integer FROM verification_results) verifications,(SELECT count(*)::integer FROM editorial_drafts) drafts,(SELECT count(*)::integer FROM approval_requests) approvals,(SELECT count(*)::integer FROM audit_events) events`);return result.rows[0]!;}
function isoOrNull(value:string|null):string|null{return value===null?null:new Date(value).toISOString();}
function abbreviate(value:string,maximum:number):string{return value.length<=maximum?value:`${value.slice(0,maximum-1)}…`;}
