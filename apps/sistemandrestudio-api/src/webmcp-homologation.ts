import { createHash } from "node:crypto";

import {
  EDITORIAL_ORCHESTRATION_POLICY_V1,
  EditorialDraftWorkflowService,
  TelegramHumanDecisionChannel,
  type EditorialDraftContext,
  type EditorialDraftUnitOfWork,
  type EditorialOrchestrationEvent,
  type EditorialOrchestrationRepository,
  type EditorialOrchestrationRun,
  type EditorialOrchestrationStepType,
  type HumanDecisionChannel,
  type HumanDecisionMessage,
  type HumanDecisionRequest,
} from "../../../packages/application/src/index.ts";
import {
  EditorialGenerationDiagnosticError,
  createEditorialFactPacket,
  findProhibitedEditorialQualifiers,
  inspectWebsiteBriefOutput,
  OllamaEditorialTextGenerator,
  type EditorialFactPacket,
  type EditorialGeneratedText,
  type EditorialGenerationDiagnostic,
  type EditorialGenerationDiagnosticCode,
  type EditorialGenerationParseResult,
  type OllamaCallMetrics,
  type OllamaEditorialRepairInput,
} from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialDraftRepository,
  PostgresEditorialOrchestrationRepository,
  PostgresExistingEditorialOrchestrationPipeline,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";
import type { Pool } from "pg";

export interface WebmcpHomologationItem {
  readonly itemId: string;
  readonly officialUrl: string;
}

export interface WebmcpVerifiedContext {
  readonly newsId: string;
  readonly verificationId: string;
  readonly newsVersion: number;
  readonly context: EditorialDraftContext;
}

export interface WebmcpHomologationDependencies {
  readonly loadVerifiedContext: (item: WebmcpHomologationItem) => Promise<WebmcpVerifiedContext | undefined>;
  readonly draftRepository: EditorialDraftUnitOfWork;
  readonly orchestrationRepository: Pick<EditorialOrchestrationRepository, "createRun" | "createDecisionRequest" | "markDecisionDelivered">;
  readonly getDecisionMessage: (input: { readonly id: string; readonly draftId: string; readonly newsId: string; readonly draftVersion: number; readonly newsVersion: number }) => Promise<HumanDecisionMessage>;
  readonly decisionChannel: HumanDecisionChannel;
  readonly now: () => string;
}

export interface WebmcpHomologationResult {
  readonly ok: boolean;
  readonly title?: string;
  readonly wordCount?: number;
  readonly gemmaCalls: number;
  readonly generationMilliseconds: number;
  readonly callMetrics: readonly OllamaCallMetrics[];
  readonly diagnostics: readonly EditorialGenerationDiagnostic[];
  readonly telegramDelivered: boolean;
  readonly persistence: "CREATED" | "SKIPPED";
  readonly publication: "SKIPPED";
}

export interface WebmcpModelGenerator {
  readonly generatorVersion: string;
  readonly lastCallMetrics: OllamaCallMetrics | undefined;
  generate(input: Parameters<OllamaEditorialTextGenerator["generate"]>[0]): Promise<EditorialGeneratedText>;
  repairWebsiteBrief(input: OllamaEditorialRepairInput): Promise<EditorialGeneratedText>;
}

export class WebmcpTwoCallGenerator implements WebmcpModelGenerator {
  readonly generatorId = "ollama";
  readonly generatorVersion: string;
  calls = 0;
  elapsedMs = 0;
  wordCount = 0;
  validation: Record<string, boolean> = {};
  diagnostics: EditorialGenerationDiagnostic[] = [];
  callMetrics: OllamaCallMetrics[] = [];
  private readonly delegate: WebmcpModelGenerator;
  private readonly officialUrl: string;

  constructor(delegate: WebmcpModelGenerator, officialUrl: string) {
    this.delegate = delegate;
    this.generatorVersion = delegate.generatorVersion;
    this.officialUrl = officialUrl;
  }

  get lastCallMetrics() {
    return this.delegate.lastCallMetrics;
  }

  async generate(input: Parameters<OllamaEditorialTextGenerator["generate"]>[0]): Promise<EditorialGeneratedText> {
    const started = performance.now();
    this.calls += 1;
    let result: EditorialGeneratedText;
    try {
      result = await this.delegate.generate(input);
    } catch (error) {
      const metrics = this.captureMetrics();
      throw new EditorialGenerationDiagnosticError([
        this.diagnosticForModelError(1, "INITIAL_GENERATION", error, Math.round(performance.now() - started), metrics),
      ]);
    }
    const firstElapsedMs = Math.round(performance.now() - started);
    const firstMetrics = this.captureMetrics();
    const first = this.validate(result, input);
    if (first.valid) return result;

    const repairStarted = performance.now();
    this.calls += 1;
    const targetWordDelta = first.wordCount < 220 ? 220 - first.wordCount : first.wordCount > 240 ? 240 - first.wordCount : 0;
    let repaired: EditorialGeneratedText;
    try {
      const packet = createEditorialFactPacket(input.brief, this.officialUrl);
      repaired = await this.delegate.repairWebsiteBrief({
        original: input,
        previous: result,
        failureCodes: first.failureCodes,
        wordCount: first.wordCount,
        wordDelta: targetWordDelta,
        factPacket: packet,
      });
    } catch (error) {
      const metrics = this.captureMetrics();
      throw new EditorialGenerationDiagnosticError([
        this.recordContentFailure(1, "INITIAL_GENERATION", first, false, firstElapsedMs, firstMetrics),
        this.diagnosticForModelError(2, "DIRECTED_REPAIR", error, Math.round(performance.now() - repairStarted), metrics),
      ]);
    }
    const repairElapsedMs = Math.round(performance.now() - repairStarted);
    const repairMetrics = this.captureMetrics();
    const second = this.validate(repaired, input);
    if (!second.valid) {
      throw new EditorialGenerationDiagnosticError([
        this.recordContentFailure(1, "INITIAL_GENERATION", first, false, firstElapsedMs, firstMetrics),
        this.recordContentFailure(2, "DIRECTED_REPAIR", second, true, repairElapsedMs, repairMetrics),
      ]);
    }
    return repaired;
  }

  private captureMetrics(): OllamaCallMetrics | undefined {
    const metrics = this.delegate.lastCallMetrics;
    if (metrics !== undefined && this.callMetrics.at(-1) !== metrics) this.callMetrics.push(metrics);
    return metrics;
  }

  private diagnosticForModelError(attempt: 1 | 2, stage: "INITIAL_GENERATION" | "DIRECTED_REPAIR", error: unknown, durationMs: number, metrics: OllamaCallMetrics | undefined): EditorialGenerationDiagnostic {
    const code = attempt === 1 ? "INITIAL_SCHEMA_FAILED" : "REPAIR_SCHEMA_FAILED";
    const parseResult: EditorialGenerationParseResult = error instanceof Error && /JSON object without surrounding text/iu.test(error.message) ? "INVALID_JSON" : "SCHEMA_INVALID";
    const diagnostic: EditorialGenerationDiagnostic = { stage, attempt, codes: [code], parseResult, durationMs, callCount: attempt, ...(metrics ?? {}) };
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }

  private recordContentFailure(attempt: 1 | 2, stage: "INITIAL_GENERATION" | "DIRECTED_REPAIR", result: { readonly failureCodes: readonly string[]; readonly wordCount: number }, final: boolean, durationMs: number, metrics: OllamaCallMetrics | undefined): EditorialGenerationDiagnostic {
    const codes: EditorialGenerationDiagnosticCode[] = [];
    if (result.wordCount < 220) codes.push("WORD_COUNT_BELOW_MINIMUM");
    if (result.wordCount > 240) codes.push("WORD_COUNT_ABOVE_MAXIMUM");
    if (result.failureCodes.some((code) => /QUALIFIER|QUALIFICADOR/iu.test(code))) codes.push("UNSUPPORTED_QUALIFIER");
    if (result.failureCodes.some((code) => /SUBTITLE|REQUIRED_FIELD/iu.test(code))) codes.push("REQUIRED_FIELD_MISSING");
    if (final) codes.push("FINAL_VALIDATION_FAILED");
    if (codes.length === 0) codes.push(attempt === 1 ? "INITIAL_CONTENT_REJECTED" : "REPAIR_CONTENT_REJECTED");
    const diagnostic: EditorialGenerationDiagnostic = { stage, attempt, codes: [...new Set(codes)], wordCount: result.wordCount, fields: ["body"], parseResult: "SCHEMA_VALID", durationMs, callCount: attempt, ...(metrics ?? {}) };
    this.diagnostics.push(diagnostic);
    return diagnostic;
  }

  private validate(result: EditorialGeneratedText, input: Parameters<OllamaEditorialTextGenerator["generate"]>[0]) {
    const combined = `${result.title}\n${result.subtitle ?? ""}\n${result.body}`;
    const factPacket = createEditorialFactPacket(input.brief, this.officialUrl);
    const structural = inspectWebsiteBriefOutput(result, [this.officialUrl]);
    this.wordCount = structural.wordCount;
    const subtitleSentences = (result.subtitle?.match(/[.!?](?=\s|$)/gu) ?? []).length;
    this.validation = {
      words220to240: this.wordCount >= 220 && this.wordCount <= 240,
      officialUrl: !structural.failureCodes.includes("OLLAMA_EDITORIAL_SOURCE_MISSING"),
      titleSubject: /WebMCP/iu.test(result.title),
      sourceName: /Cloudflare/iu.test(combined),
      twoSentenceSummary: subtitleSentences === 2,
      practicalAudience: /desenvolvedores|empresas/iu.test(combined),
      noUnsupportedQualifier: findProhibitedEditorialQualifiers(combined.replace(this.officialUrl, ""), factPacket).length === 0,
      noInventedSpecifics: !/\b\d+(?:[.,]\d+)?\b/iu.test(combined.replace(this.officialUrl, "")),
      noSecrets: !/(?:TELEGRAM_BOT_TOKEN|ghp_[A-Za-z0-9]|sk-[A-Za-z0-9]{10,})/u.test(combined),
    };
    const failureCodes = [
      ...structural.failureCodes,
      ...Object.entries(this.validation).filter(([, passed]) => !passed).map(([name]) => `WEBMCP_${name.toUpperCase()}_INVALID`),
    ];
    return { valid: failureCodes.length === 0, failureCodes, wordCount: structural.wordCount };
  }

  async repairWebsiteBrief(input: OllamaEditorialRepairInput): Promise<EditorialGeneratedText> {
    return this.delegate.repairWebsiteBrief(input);
  }
}

export async function runWebmcpHomologation(item: WebmcpHomologationItem, dependencies: WebmcpHomologationDependencies, model: WebmcpModelGenerator): Promise<WebmcpHomologationResult> {
  const verified = await dependencies.loadVerifiedContext(item);
  if (verified === undefined || verified.context.news.state !== "VERIFIED" || verified.context.verification.status !== "CONFIRMED") throw new Error("WebMCP is not currently VERIFIED/CONFIRMED.");
  if (verified.context.evidence.length === 0) throw new Error("Current WebMCP verification has no supporting evidence.");
  const generator = new WebmcpTwoCallGenerator(model, item.officialUrl);
  const service = new EditorialDraftWorkflowService(dependencies.draftRepository, generator);
  const draftKey = `ollama-local-webmcp-tracked-homologation:${item.itemId}`;
  const created = await service.createDraft({
    newsId: verified.newsId,
    verificationId: verified.verificationId,
    format: "WEBSITE_NEWS_BRIEF",
    idempotencyKey: draftKey,
    commandId: draftKey,
    approvalRequestId: `${draftKey}:approval`,
    expectedVersion: verified.newsVersion,
    actor: { type: "SYSTEM", id: "webmcp-tracked-homologation" },
    occurredAt: verified.context.verification.evaluatedAt,
  });
  const draft = created.draft;
  const now = dependencies.now();
  const runFingerprint = digest({ item, draftId: draft.draftId });
  const runId = `editorial-run-${runFingerprint.slice(0, 24)}`;
  const stepTypes: readonly EditorialOrchestrationStepType[] = ["RADAR_INGESTION", "RELEVANCE_EVALUATION", "EVIDENCE_ACQUISITION", "FACTUAL_VERIFICATION", "DRAFT_GENERATION", "HUMAN_REVIEW_NOTIFICATION", "HUMAN_DECISION", "PUBLICATION_PACKAGE_PREPARATION"];
  const completed = new Set<EditorialOrchestrationStepType>(["DRAFT_GENERATION", "HUMAN_REVIEW_NOTIFICATION"]);
  const run: EditorialOrchestrationRun = { id: runId, policyId: EDITORIAL_ORCHESTRATION_POLICY_V1.id, policyVersion: EDITORIAL_ORCHESTRATION_POLICY_V1.version, triggerType: "MANUAL", triggerKey: `tracked-webmcp:${item.itemId}`, triggeredBy: "webmcp-tracked-homologation", status: "WAITING_HUMAN_DECISION", startedAt: now, functionalFingerprint: runFingerprint, steps: stepTypes.map((stepType, position) => ({ id: `${runId}:step:${position}`, runId, position, stepType, status: stepType === "HUMAN_DECISION" ? "PENDING" : completed.has(stepType) ? "COMPLETED" : "SKIPPED", attemptCount: 0, metadata: { scope: "webmcp-tracked-homologation", publication: "SKIPPED" } })), createdAt: now, updatedAt: now };
  const createdRun = await dependencies.orchestrationRepository.createRun(run, event(`${runId}:started`, runId, "EDITORIAL_ORCHESTRATION_STARTED", now));
  const messageContext = await dependencies.getDecisionMessage({ id: draft.draftId, draftId: draft.draftId, newsId: draft.newsId, draftVersion: 1, newsVersion: verified.newsVersion });
  const requestId = `decision-request-${runFingerprint.slice(0, 20)}`;
  const request: HumanDecisionRequest = { id: requestId, runId: createdRun.run.id, draftId: draft.draftId, draftVersion: 1, newsVersion: verified.newsVersion, channel: "TELEGRAM", recipientReference: "configured-telegram-approver", status: "PENDING", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), functionalFingerprint: runFingerprint, context: messageContext, createdAt: now };
  const saved = await dependencies.orchestrationRepository.createDecisionRequest(request, event(`${requestId}:requested`, runId, "HUMAN_DECISION_REQUESTED", now, requestId));
  const delivery = await dependencies.decisionChannel.sendDecisionRequest(saved.request);
  await dependencies.orchestrationRepository.markDecisionDelivered({ requestId, delivery, event: event(`${requestId}:delivered`, runId, "HUMAN_DECISION_DELIVERED", delivery.deliveredAt, requestId) });
  return { ok: true, title: draft.title, wordCount: generator.wordCount, gemmaCalls: generator.calls, generationMilliseconds: generator.elapsedMs, callMetrics: generator.callMetrics, diagnostics: generator.diagnostics, telegramDelivered: true, persistence: "CREATED", publication: "SKIPPED" };
}

function event(id: string, runId: string, eventType: EditorialOrchestrationEvent["eventType"], occurredAt: string, requestId?: string): EditorialOrchestrationEvent {
  return { id, runId, ...(requestId === undefined ? {} : { requestId }), eventType, metadata: { automaticPublication: false, publication: "SKIPPED" }, occurredAt };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createProductionWebmcpDependencies(pool: Pool): WebmcpHomologationDependencies {
  const draftRepository = new PostgresEditorialDraftRepository(pool);
  const orchestrationRepository = new PostgresEditorialOrchestrationRepository(pool);
  const pipeline = new PostgresExistingEditorialOrchestrationPipeline(pool, 1);
  const channel = new TelegramHumanDecisionChannel({ botToken: required("TELEGRAM_BOT_TOKEN"), approverChatId: required("TELEGRAM_APPROVER_CHAT_ID"), webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"), allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean), clock: () => new Date().toISOString() });
  return {
    draftRepository,
    orchestrationRepository,
    decisionChannel: channel,
    getDecisionMessage: (input) => pipeline.getDecisionMessage(input),
    now: () => new Date().toISOString(),
    loadVerifiedContext: async (item) => {
      const row = await pool.query<{ news_id: string; verification_id: string; state: string; verification_status: string; lock_version: number; evidence_count: string; draft_count: string }>(`SELECT news.id news_id,latest.id verification_id,news.state,latest.status verification_status,news.lock_version,(SELECT count(*) FROM verification_evidence ve JOIN verification_claims vc ON vc.id=ve.claim_id WHERE vc.news_id=news.id)::text evidence_count,(SELECT count(*) FROM editorial_drafts d WHERE d.news_id=news.id)::text draft_count FROM collected_source_items item JOIN editorial_news news ON news.id=item.editorial_news_id JOIN LATERAL (SELECT id,status FROM verification_results WHERE news_id=news.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) latest ON true WHERE item.id=$1 AND item.canonical_url=$2 AND (news.source->>'isOfficial')::boolean=true`, [item.itemId, item.officialUrl]);
      const rowValue = row.rows[0];
      if (rowValue === undefined || Number(rowValue.draft_count) !== 0 || Number(rowValue.evidence_count) === 0) return undefined;
      const context = await draftRepository.loadContext(rowValue.news_id, rowValue.verification_id);
      if (context === undefined) return undefined;
      return { newsId: rowValue.news_id, verificationId: rowValue.verification_id, newsVersion: rowValue.lock_version, context };
    },
  };
}

export async function runWebmcpHomologationFromEnvironment(): Promise<WebmcpHomologationResult> {
  guardEnvironment();
  const pool = createDatabasePool(loadDatabaseConfig());
  try {
    await checkDatabaseConnection(pool);
    const item = { itemId: "source-item-0f6d6fa5a3874b606bc8fa94", officialUrl: "https://blog.cloudflare.com/webmcp/" };
    return await runWebmcpHomologation(item, createProductionWebmcpDependencies(pool), OllamaEditorialTextGenerator.fromEnvironment());
  } finally {
    await pool.end();
  }
}

function guardEnvironment() {
  if (process.env.DRY_RUN_ORCHESTRATION !== "true" || process.env.PUBLICATION_ENABLED !== "false" || process.env.HUMAN_DECISION_CHANNEL !== "TELEGRAM") throw new Error("Requires dry-run, Telegram channel and publication disabled.");
  if (process.env.LLM_PROVIDER !== "ollama" || process.env.LLM_MODEL !== "gemma4:e2b-it-qat") throw new Error("The local Gemma model is not configured.");
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1]?.endsWith("webmcp-homologation.ts") || process.argv[1]?.endsWith("webmcp-homologation.js")) {
  try {
    const result = await runWebmcpHomologationFromEnvironment();
    console.log(JSON.stringify({ ...result, logsSanitized: true, publicationEnabled: false }));
  } catch (error) {
    const diagnostics = error instanceof Error && "diagnostics" in error && Array.isArray((error as { diagnostics?: unknown }).diagnostics) ? (error as { diagnostics: readonly EditorialGenerationDiagnostic[] }).diagnostics : [];
    console.log(JSON.stringify({ ok: false, externalCode: "EDITORIAL_DRAFT_GENERATION_FAILED", diagnostics, gemmaCalls: diagnostics.at(-1)?.callCount ?? 0, persistence: "SKIPPED", telegram: "SKIPPED", publication: "SKIPPED", logsSanitized: true }));
    process.exitCode = 1;
  }
}
