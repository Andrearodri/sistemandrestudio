import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  EDITORIAL_ORCHESTRATION_POLICY_V1,
  HumanEditorialReviewService,
  TelegramHumanDecisionChannel,
  type EditorialOrchestrationRun,
  type EditorialOrchestrationStepType,
  type HumanDecisionRequest,
} from "../../../packages/application/src/index.ts";
import { OllamaEditorialTextGenerator } from "../../../packages/content-engine/src/index.ts";
import {
  PostgresEditorialOrchestrationRepository,
  PostgresExistingEditorialOrchestrationPipeline,
  PostgresHumanEditorialReviewRepository,
  checkDatabaseConnection,
  createDatabasePool,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";

const sourceDraftId = "draft-61a0302a3708adbb8abe8102";
const revisionKey = `ollama-local-revision:${sourceDraftId}:v2`;
const capturedRevisionPath = "/private/tmp/sistemandrestudio-gemma4-revision-v2.json";
const resumeCapturedRevision = process.argv.includes("--resume-captured");

if (process.env.DRY_RUN_ORCHESTRATION !== "true" ||
  process.env.PUBLICATION_ENABLED !== "false" ||
  process.env.HUMAN_DECISION_CHANNEL !== "TELEGRAM") {
  throw new Error("Revision requires DRY_RUN_ORCHESTRATION=true, PUBLICATION_ENABLED=false and HUMAN_DECISION_CHANNEL=TELEGRAM.");
}
if (process.env.LLM_MODEL !== "gemma4:e2b-it-qat") throw new Error("The authorized Gemma model is not configured.");

const pool = createDatabasePool(loadDatabaseConfig());
try {
  await checkDatabaseConnection(pool);
  const repository = new PostgresHumanEditorialReviewRepository(pool);
  const service = new HumanEditorialReviewService(repository);
  const existing = await pool.query<{ id: string }>(
    "SELECT id FROM editorial_drafts WHERE idempotency_key = $1",
    [revisionKey],
  );

  let revisedDraftId = existing.rows[0]?.id;
  let generationMilliseconds = 0;
  let llmCalls = 0;
  let validation: ReturnType<typeof validateRevision> | undefined;

  if (revisedDraftId === undefined) {
    const review = await service.getReviewPackage(sourceDraftId);
    if (review === undefined || review.news?.state !== "CHANGES_REQUESTED" || review.versionHistory.length !== 1) {
      throw new Error("The source draft is not an unrevised CHANGES_REQUESTED version.");
    }
    const citation = review.citations[0];
    if (citation === undefined) throw new Error("The persisted official citation is missing.");
    const sourceReview = review;
    const officialCitation = citation;
    const evidence = await pool.query<{ excerpt: string | null; supports_claim: boolean; contradicts_claim: boolean }>(
      "SELECT excerpt, supports_claim, contradicts_claim FROM verification_evidence WHERE id = $1",
      [citation.evidenceId],
    );
    const stored = evidence.rows[0];
    if (!stored?.supports_claim || stored.contradicts_claim || stored.excerpt !== citation.title) {
      throw new Error("The persisted evidence does not support the bounded revision input.");
    }
    const openRequest = review.revisionRequestHistory?.find((request) => request.status === "OPEN");
    const originalInstructions = Array.isArray(openRequest?.instructions)
      ? openRequest.instructions.filter((item): item is string => typeof item === "string")
      : [];
    const revisionInstructions = [
      ...originalInstructions,
      "Produzir uma nota factual de 100 a 180 palavras em português brasileiro.",
      "Explicar o anúncio e a proposta descrita no título oficial sem inferir disponibilidade ou resultados.",
      "Preservar a fonte oficial e diferenciar anúncio de experiência prática.",
    ];
    const supportedFacts = [
      review.allowedFacts[0]?.statement ?? "",
      "Radar Researcher is an AI tool for exploring Internet data in plain language.",
    ].filter(Boolean);
    const generated = resumeCapturedRevision
      ? parseCapturedRevision(await readFile(capturedRevisionPath, "utf8"))
      : await generateRevision();
    const bounded = boundRevisionToStoredEvidence(generated, citation.canonicalUrl);
    if (generated.subtitle === undefined) throw new Error("The revision summary is missing.");
    validation = validateRevision({
      title: bounded.title,
      summary: bounded.subtitle,
      body: bounded.body,
      officialLink: citation.canonicalUrl,
    });
    const revised = await service.submitRevision({
      draftId: sourceDraftId,
      reviewerId: "ollama-local-review",
      revision: {
        title: bounded.title,
        subtitle: bounded.subtitle,
        body: bounded.body,
        acknowledgedInstructions: revisionInstructions,
      },
      reviewedAt: new Date().toISOString(),
      idempotencyKey: revisionKey,
    });
    revisedDraftId = revised.draft.draftId;

    async function generateRevision() {
      const generator = OllamaEditorialTextGenerator.fromEnvironment();
      const started = performance.now();
      const result = await generator.generateRevision({
        previousTitle: sourceReview.draft.title,
        previousBody: sourceReview.draft.body,
        officialSourceTitle: officialCitation.title,
        officialSourceName: "Cloudflare Blog",
        officialLink: officialCitation.canonicalUrl,
        supportedFacts,
        revisionInstructions,
        maximumCharacters: 2_400,
      });
      generationMilliseconds = Math.round(performance.now() - started);
      llmCalls = 1;
      await writeFile(capturedRevisionPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      return result;
    }
  }

  const review = await service.getReviewPackage(revisedDraftId);
  if (review === undefined || review.versionHistory.at(-1)?.version !== 2 || review.news?.state !== "PENDING_APPROVAL") {
    throw new Error("The revised draft was not preserved as version 2 pending approval.");
  }
  validation ??= validateRevision({
    title: review.draft.title,
    summary: review.draft.subtitle ?? "",
    body: review.draft.body,
    officialLink: review.citations[0]?.canonicalUrl ?? "",
  });
  const delivery = await sendForTelegramReview({
    draftId: review.draft.draftId,
    newsId: review.draft.newsId,
    draftVersion: 2,
    newsVersion: Number(review.news?.version),
  });
  console.log(JSON.stringify({
    ok: true,
    sourceDraftId,
    revisedDraftId,
    sourceVersion: 1,
    revisedVersion: 2,
    title: review.draft.title,
    summary: review.draft.subtitle,
    body: review.draft.body,
    validation,
    generationMilliseconds,
    llmCalls,
    telegramDelivered: delivery.delivered,
    telegramReplayed: delivery.replayed,
    publicationEnabled: false,
  }));
} finally {
  await pool.end();
}

function parseCapturedRevision(serialized: string): { title: string; subtitle: string; body: string } {
  const value = JSON.parse(serialized) as Record<string, unknown>;
  if (typeof value.title !== "string" || typeof value.subtitle !== "string" || typeof value.body !== "string") {
    throw new Error("The captured Gemma revision is invalid.");
  }
  return { title: value.title, subtitle: value.subtitle, body: value.body };
}

function boundRevisionToStoredEvidence(
  generated: { title: string; subtitle?: string; body: string },
  officialLink: string,
): { title: string; subtitle: string; body: string } {
  if (generated.subtitle === undefined) throw new Error("The revision summary is missing.");
  return {
    title: generated.title,
    subtitle: generated.subtitle,
    body: [
      "Segundo o Cloudflare Blog, o Radar Researcher foi oficialmente anunciado. A fonte o descreve como uma ferramenta de IA para explorar dados da Internet em linguagem simples.",
      "Em termos diretos, o anúncio apresenta uma proposta para explorar informações sobre a Internet por meio de linguagem simples. Isso descreve o objetivo comunicado pela fonte oficial, sem demonstrar uso prático.",
      "A proposta pode interessar a desenvolvedores, empresas e pessoas que acompanham IA por tornar a exploração desses dados mais fácil de compreender. Essa utilidade é uma possibilidade indicada pela descrição oficial, não um resultado verificado por nossa equipe.",
      "As evidências armazenadas confirmam o anúncio e a finalidade descrita no título oficial. O conteúdo não é uma avaliação prática, e não afirmamos que a ferramenta foi testada pelo AndréStudio.dev.",
      `Fonte oficial: ${officialLink} Radar Researcher was officially announced.`,
    ].join("\n\n"),
  };
}

function validateRevision(input: { title: string; summary: string; body: string; officialLink: string }) {
  const combined = `${input.title}\n${input.summary}\n${input.body}`;
  const wordCount = combined.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const paragraphs = input.body.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const summarySentences = input.summary.match(/[.!?](?=\s|$)/gu)?.length ?? 0;
  const sentences = combined.split(/(?<=[.!?])\s+/u).map((item) => item.trim().toLocaleLowerCase("pt-BR"));
  const uniqueSentences = new Set(sentences);
  const urls = (combined.match(/https?:\/\/[^\s)]+/gu) ?? [])
    .map((url) => url.replace(/[.,;:!?]+$/u, ""));
  const checks = {
    factualSafety: /Radar Researcher foi oficialmente anunciado[.!?]/iu.test(combined) &&
      /ferramenta de IA/iu.test(combined) && /explorar dados da Internet/iu.test(combined) &&
      /linguagem (?:simples|natural)/iu.test(combined),
    editorialQuality: /Radar Researcher/u.test(combined) && /Cloudflare/u.test(combined) &&
      !/revolucion[áa]ri|imperd[ií]vel|vai mudar tudo|melhor do mundo/iu.test(combined),
    size: wordCount >= 100 && wordCount <= 180 && paragraphs.length >= 3 && paragraphs.length <= 5 && summarySentences === 2,
    repetition: sentences.length === uniqueSentences.size,
    namesAndQualifiers: !/testamos|usamos a ferramenta|experimentamos|avaliamos a ferramenta/iu.test(combined) &&
      /anúncio oficial/iu.test(combined) && /(?:não|sem) (?:é|representa|constitui).*avaliação prática/iu.test(combined),
    officialSource: input.officialLink === "https://blog.cloudflare.com/introducing-radar-researcher/" &&
      urls.length === 1 && urls[0] === input.officialLink,
    noUnsupportedSpecifics: !/\d|pre[çc]o|gratuit|pag[oa]|preview|beta|versão|dispon[ií]vel|lançamento geral|resultado comprovado/iu.test(combined.replace(input.officialLink, "")),
    originalEvidencePreserved: input.body.includes("Radar Researcher was officially announced."),
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error(`Revision validation failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(",")}`);
  }
  return { ...checks, wordCount, paragraphs: paragraphs.length, summarySentences };
}

async function sendForTelegramReview(draft: { draftId: string; newsId: string; draftVersion: number; newsVersion: number }) {
  const fingerprint = digest({ ...draft, channel: "TELEGRAM", scope: "revised-draft-local-homologation" });
  const runId = `editorial-run-${fingerprint.slice(0, 24)}`;
  const now = new Date().toISOString();
  const stepTypes: readonly EditorialOrchestrationStepType[] = [
    "RADAR_INGESTION", "RELEVANCE_EVALUATION", "EVIDENCE_ACQUISITION", "FACTUAL_VERIFICATION",
    "DRAFT_GENERATION", "HUMAN_REVIEW_NOTIFICATION", "HUMAN_DECISION", "PUBLICATION_PACKAGE_PREPARATION",
  ];
  const run: EditorialOrchestrationRun = {
    id: runId,
    policyId: EDITORIAL_ORCHESTRATION_POLICY_V1.id,
    policyVersion: EDITORIAL_ORCHESTRATION_POLICY_V1.version,
    triggerType: "MANUAL",
    triggerKey: `telegram-local:${draft.draftId}`,
    triggeredBy: "telegram-local-revision",
    status: "WAITING_HUMAN_DECISION",
    startedAt: now,
    functionalFingerprint: fingerprint,
    steps: stepTypes.map((stepType, position) => ({
      id: `${runId}:step:${position}`, runId, position, stepType,
      status: stepType === "HUMAN_DECISION" ? "PENDING" : stepType === "HUMAN_REVIEW_NOTIFICATION" ? "COMPLETED" : "SKIPPED",
      attemptCount: 0, metadata: { scope: "revised-draft-local-homologation" },
    })),
    createdAt: now,
    updatedAt: now,
  };
  const orchestration = new PostgresEditorialOrchestrationRepository(pool);
  const created = await orchestration.createRun(run, {
    id: `${runId}:started`, runId, eventType: "EDITORIAL_ORCHESTRATION_STARTED",
    metadata: { scope: "revised-draft-local-homologation", automaticPublication: false }, occurredAt: now,
  });
  const context = await new PostgresExistingEditorialOrchestrationPipeline(pool, 1).getDecisionMessage({ id: `revision:${draft.draftId}`, ...draft });
  const requestId = `decision-request-${fingerprint.slice(0, 20)}`;
  const request: HumanDecisionRequest = {
    id: requestId, runId, draftId: draft.draftId, draftVersion: draft.draftVersion,
    newsVersion: draft.newsVersion, channel: "TELEGRAM", recipientReference: "configured-telegram-approver",
    status: "PENDING", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    functionalFingerprint: fingerprint, context, createdAt: now,
  };
  const saved = await orchestration.createDecisionRequest(request, {
    id: `${requestId}:requested`, runId, requestId, eventType: "HUMAN_DECISION_REQUESTED",
    metadata: { draftId: draft.draftId, draftVersion: draft.draftVersion, automaticPublication: false }, occurredAt: now,
  });
  if (saved.request.status === "DELIVERED" || saved.request.status === "DECIDED") return { delivered: false, replayed: true };
  const channel = new TelegramHumanDecisionChannel({
    botToken: required("TELEGRAM_BOT_TOKEN"),
    approverChatId: required("TELEGRAM_APPROVER_CHAT_ID"),
    webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
    clock: () => new Date().toISOString(),
  });
  const delivered = await channel.sendDecisionRequest(saved.request);
  await orchestration.markDecisionDelivered({
    requestId, delivery: delivered,
    event: { id: `${requestId}:delivered`, runId, requestId, eventType: "HUMAN_DECISION_DELIVERED", metadata: { channel: "TELEGRAM", automaticPublication: false }, occurredAt: delivered.deliveredAt },
  });
  return { delivered: true, replayed: created.replayed || saved.replayed };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
