import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const EDITORIAL_ORCHESTRATION_POLICY_V1 = {
  id: "andre-studio-editorial-orchestration",
  version: "andre-studio-editorial-orchestration-v1",
  officialSourceIds: [
    "cloudflare-blog",
    "github-blog",
    "nodejs-blog",
    "google-developers-blog",
    "react-blog",
  ],
  maximumIngestedItems: 15,
  maximumEvidenceItems: 5,
  maximumDrafts: 3,
  maximumPendingHumanDecisions: 3,
  minimumRelevanceScore: 60,
  eligibleVerificationStatuses: ["CONFIRMED", "PARTIALLY_CONFIRMED"],
  decisionTimeoutHours: 24,
  retry: {
    maximumAttempts: 3,
    backoffSeconds: [5, 30],
  },
  automaticPublicationEnabled: false,
  automaticAiDecisionEnabled: false,
  humanApprovalRequired: true,
} as const;

export type EditorialOrchestrationRunStatus =
  | "CREATED"
  | "RUNNING"
  | "WAITING_HUMAN_DECISION"
  | "COMPLETED"
  | "COMPLETED_WITH_WARNINGS"
  | "FAILED"
  | "CANCELLED";

export type EditorialOrchestrationStepType =
  | "RADAR_INGESTION"
  | "RELEVANCE_EVALUATION"
  | "EVIDENCE_ACQUISITION"
  | "FACTUAL_VERIFICATION"
  | "DRAFT_GENERATION"
  | "HUMAN_REVIEW_NOTIFICATION"
  | "HUMAN_DECISION"
  | "PUBLICATION_PACKAGE_PREPARATION";

export type EditorialOrchestrationStepStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "SKIPPED";

export type EditorialOrchestrationTrigger =
  | "MANUAL"
  | "N8N_SCHEDULED"
  | "N8N_RETRY";

export type HumanEditorialDecision =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_CHANGES";

export type HumanDecisionRequestStatus =
  | "PENDING"
  | "DELIVERED"
  | "DECIDED"
  | "EXPIRED"
  | "CANCELLED";

export type EditorialOrchestrationEventType =
  | "EDITORIAL_ORCHESTRATION_STARTED"
  | "EDITORIAL_ORCHESTRATION_STEP_STARTED"
  | "EDITORIAL_ORCHESTRATION_STEP_COMPLETED"
  | "EDITORIAL_ORCHESTRATION_WAITING_HUMAN"
  | "HUMAN_DECISION_REQUESTED"
  | "HUMAN_DECISION_DELIVERED"
  | "HUMAN_DECISION_RECEIVED"
  | "EDITORIAL_ORCHESTRATION_RESUMED"
  | "EDITORIAL_ORCHESTRATION_COMPLETED"
  | "EDITORIAL_ORCHESTRATION_FAILED"
  | "EDITORIAL_ORCHESTRATION_REPLAYED";

export interface EditorialOrchestrationStep {
  readonly id: string;
  readonly runId: string;
  readonly position: number;
  readonly stepType: EditorialOrchestrationStepType;
  readonly status: EditorialOrchestrationStepStatus;
  readonly attemptCount: number;
  readonly inputReference?: Readonly<Record<string, unknown>>;
  readonly outputReference?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly errorCode?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EditorialOrchestrationRun {
  readonly id: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly triggerType: EditorialOrchestrationTrigger;
  readonly triggerKey: string;
  readonly triggeredBy: string;
  readonly status: EditorialOrchestrationRunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly functionalFingerprint: string;
  readonly steps: readonly EditorialOrchestrationStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HumanDecisionRequest {
  readonly id: string;
  readonly runId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly newsVersion: number;
  readonly channel: "CONSOLE" | "TELEGRAM";
  readonly recipientReference: string;
  readonly status: HumanDecisionRequestStatus;
  readonly expiresAt: string;
  readonly functionalFingerprint: string;
  readonly context: HumanDecisionMessage;
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

export interface PersistedHumanDecision {
  readonly id: string;
  readonly requestId: string;
  readonly reviewerId: string;
  readonly decision: HumanEditorialDecision;
  readonly reason?: string;
  readonly changeInstructions?: readonly string[];
  readonly receivedAt: string;
  readonly externalMessageReference?: string;
  readonly functionalFingerprint: string;
}

export interface EditorialOrchestrationAttempt {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptNumber: number;
  readonly status: "STARTED" | "SUCCEEDED" | "FAILED";
  readonly errorCode?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
}

export interface EditorialOrchestrationEvent {
  readonly id: string;
  readonly runId: string;
  readonly eventType: EditorialOrchestrationEventType;
  readonly stepId?: string;
  readonly requestId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface HumanDecisionMessage {
  readonly sourceName: string;
  readonly officialLink?: string;
  readonly title: string;
  readonly verificationStatus: "CONFIRMED" | "PARTIALLY_CONFIRMED";
  readonly confidence: number;
  readonly summary: string;
  readonly allowedClaims: readonly string[];
  readonly limitations: readonly string[];
  readonly draftId: string;
  readonly draftVersion: number;
  readonly newsVersion: number;
}

export interface HumanDecisionDelivery {
  readonly channel: "CONSOLE" | "TELEGRAM";
  readonly recipientReference: string;
  readonly externalMessageReference: string;
  readonly deliveredAt: string;
  readonly replayed: boolean;
}

export interface ExternalDecisionInput {
  readonly callbackData: string;
  readonly chatId: string;
  readonly userId?: string;
  readonly receivedAt: string;
  readonly externalMessageReference?: string;
  readonly reason?: string;
  readonly changeInstructions?: readonly string[];
}

export type ParsedExternalDecision =
  | {
    readonly kind: "DETAILS";
    readonly requestId: string;
    readonly reviewerId: string;
    readonly receivedAt: string;
  }
  | {
    readonly kind: "DECISION";
    readonly requestId: string;
    readonly reviewerId: string;
    readonly decision: HumanEditorialDecision;
    readonly receivedAt: string;
    readonly externalMessageReference?: string;
    readonly reason?: string;
    readonly changeInstructions?: readonly string[];
  };

export interface HumanDecisionChannel {
  readonly kind: "CONSOLE" | "TELEGRAM";
  sendDecisionRequest(
    request: HumanDecisionRequest,
  ): Promise<HumanDecisionDelivery>;
  parseDecision(input: ExternalDecisionInput): ParsedExternalDecision;
}

export interface EditorialPipelineReference {
  readonly id: string;
  readonly newsId: string;
}

export interface RelevanceReference extends EditorialPipelineReference {
  readonly relevanceScore: number;
  readonly eligible: boolean;
}

export interface EvidenceReference extends EditorialPipelineReference {
  readonly evidenceId: string;
}

export interface VerificationReference extends EditorialPipelineReference {
  readonly verificationId: string;
  readonly status:
    | "CONFIRMED"
    | "PARTIALLY_CONFIRMED"
    | "INSUFFICIENT_EVIDENCE"
    | "UNCONFIRMED"
    | "CONTRADICTED"
    | "OUTDATED";
  readonly confidence: number;
}

export interface DraftReference extends EditorialPipelineReference {
  readonly draftId: string;
  readonly draftVersion: number;
  readonly newsVersion: number;
}

export interface EditorialOrchestrationPipeline {
  ingest(input: {
    readonly sourceIds: readonly string[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }): Promise<readonly EditorialPipelineReference[]>;
  evaluateRelevance(input: {
    readonly items: readonly EditorialPipelineReference[];
    readonly minimumScore: number;
    readonly idempotencyKey: string;
  }): Promise<readonly RelevanceReference[]>;
  acquireEvidence(input: {
    readonly items: readonly RelevanceReference[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }): Promise<readonly EvidenceReference[]>;
  verifyFacts(input: {
    readonly items: readonly EvidenceReference[];
    readonly idempotencyKey: string;
  }): Promise<readonly VerificationReference[]>;
  generateDrafts(input: {
    readonly items: readonly VerificationReference[];
    readonly maximumDrafts: number;
    readonly idempotencyKey: string;
  }): Promise<readonly DraftReference[]>;
  getDecisionMessage(draft: DraftReference): Promise<HumanDecisionMessage>;
}

export interface HumanEditorialDecisionExecutor {
  execute(input: {
    readonly request: HumanDecisionRequest;
    readonly decision: PersistedHumanDecision;
  }): Promise<{ readonly resultReference: string; readonly replayed: boolean }>;
}

export interface EditorialOrchestrationRepository {
  createRun(
    run: EditorialOrchestrationRun,
    event: EditorialOrchestrationEvent,
  ): Promise<{ readonly run: EditorialOrchestrationRun; readonly replayed: boolean }>;
  getRun(id: string): Promise<EditorialOrchestrationRun | undefined>;
  listRuns(): Promise<readonly EditorialOrchestrationRun[]>;
  updateRunStatus(input: {
    readonly runId: string;
    readonly status: EditorialOrchestrationRunStatus;
    readonly occurredAt: string;
    readonly completedAt?: string;
    readonly event?: EditorialOrchestrationEvent;
  }): Promise<EditorialOrchestrationRun>;
  startStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }): Promise<EditorialOrchestrationStep>;
  completeStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly outputReference: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  }): Promise<EditorialOrchestrationStep>;
  failStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly errorCode: string;
    readonly occurredAt: string;
  }): Promise<EditorialOrchestrationStep>;
  resetFailedStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }): Promise<EditorialOrchestrationStep>;
  createDecisionRequest(
    request: HumanDecisionRequest,
    event: EditorialOrchestrationEvent,
  ): Promise<{ readonly request: HumanDecisionRequest; readonly replayed: boolean }>;
  markDecisionDelivered(input: {
    readonly requestId: string;
    readonly delivery: HumanDecisionDelivery;
    readonly event: EditorialOrchestrationEvent;
  }): Promise<HumanDecisionRequest>;
  getDecisionRequest(id: string): Promise<HumanDecisionRequest | undefined>;
  getPendingHumanDecisions(now: string): Promise<readonly HumanDecisionRequest[]>;
  getDecisionByRequest(
    requestId: string,
  ): Promise<PersistedHumanDecision | undefined>;
  registerDecision(input: {
    readonly requestId: string;
    readonly decision: PersistedHumanDecision;
    readonly event: EditorialOrchestrationEvent;
  }): Promise<{ readonly decision: PersistedHumanDecision; readonly replayed: boolean }>;
  getDecisionForRun(runId: string): Promise<PersistedHumanDecision | undefined>;
  recordAttempt(attempt: EditorialOrchestrationAttempt): Promise<void>;
  listEvents(runId: string): Promise<readonly EditorialOrchestrationEvent[]>;
}

export class EditorialOrchestrationError extends Error {
  readonly code: string;
  readonly transient: boolean;

  constructor(code: string, message: string, transient = false) {
    super(message);
    this.name = "EditorialOrchestrationError";
    this.code = code;
    this.transient = transient;
  }
}

const STEPS: readonly EditorialOrchestrationStepType[] = [
  "RADAR_INGESTION",
  "RELEVANCE_EVALUATION",
  "EVIDENCE_ACQUISITION",
  "FACTUAL_VERIFICATION",
  "DRAFT_GENERATION",
  "HUMAN_REVIEW_NOTIFICATION",
  "HUMAN_DECISION",
  "PUBLICATION_PACKAGE_PREPARATION",
];

const TRANSIENT_ERROR_CODES = new Set([
  "ORCHESTRATION_HTTP_TIMEOUT",
  "ORCHESTRATION_TELEGRAM_UNAVAILABLE",
  "ORCHESTRATION_POSTGRES_UNAVAILABLE",
  "ORCHESTRATION_TEMPORARY_UNAVAILABLE",
]);

const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/;

export class EditorialOrchestrationService {
  readonly repository: EditorialOrchestrationRepository;
  readonly pipeline: EditorialOrchestrationPipeline;
  readonly channel: HumanDecisionChannel;
  readonly decisionExecutor: HumanEditorialDecisionExecutor;
  readonly clock: () => string;

  constructor(input: {
    readonly repository: EditorialOrchestrationRepository;
    readonly pipeline: EditorialOrchestrationPipeline;
    readonly channel: HumanDecisionChannel;
    readonly decisionExecutor: HumanEditorialDecisionExecutor;
    readonly clock: () => string;
  }) {
    this.repository = input.repository;
    this.pipeline = input.pipeline;
    this.channel = input.channel;
    this.decisionExecutor = input.decisionExecutor;
    this.clock = input.clock;
  }

  async startScheduledRun(input: {
    readonly triggerType: EditorialOrchestrationTrigger;
    readonly triggerKey: string;
    readonly triggeredBy: string;
  }): Promise<{
    readonly run: EditorialOrchestrationRun;
    readonly replayed: boolean;
    readonly operationalEvent?: "EDITORIAL_ORCHESTRATION_REPLAYED";
  }> {
    validateTrigger(input);
    const now = this.clock();
    const functionalFingerprint = fingerprint({
      triggerType: input.triggerType,
      triggerKey: input.triggerKey,
      policy: EDITORIAL_ORCHESTRATION_POLICY_V1,
    });
    const runId = `editorial-run-${functionalFingerprint.slice(0, 24)}`;
    const run: EditorialOrchestrationRun = {
      id: runId,
      policyId: EDITORIAL_ORCHESTRATION_POLICY_V1.id,
      policyVersion: EDITORIAL_ORCHESTRATION_POLICY_V1.version,
      triggerType: input.triggerType,
      triggerKey: input.triggerKey,
      triggeredBy: input.triggeredBy,
      status: "CREATED",
      startedAt: now,
      functionalFingerprint,
      steps: STEPS.map((stepType, position) => ({
        id: `${runId}:step:${position}`,
        runId,
        position,
        stepType,
        status: "PENDING",
        attemptCount: 0,
        metadata: {},
      })),
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.repository.createRun(
      run,
      event(runId, "EDITORIAL_ORCHESTRATION_STARTED", now),
    );
    if (created.replayed) {
      return {
        run: await this.getRun(runId),
        replayed: true,
        operationalEvent: "EDITORIAL_ORCHESTRATION_REPLAYED",
      };
    }
    return { run: await this.advance(runId), replayed: false };
  }

  async resumeRun(runId: string): Promise<EditorialOrchestrationRun> {
    const run = await this.getRun(runId);
    if (run.status === "CANCELLED" || run.status === "COMPLETED" ||
      run.status === "COMPLETED_WITH_WARNINGS") return run;
    const now = this.clock();
    const decision = await this.repository.getDecisionForRun(runId);
    if (run.status === "WAITING_HUMAN_DECISION" && decision === undefined) {
      return run;
    }
    if (decision !== undefined) {
      await this.ensureDecisionStep(runId, decision, now);
      const finalStatus = decision.decision === "APPROVE"
        ? "COMPLETED"
        : "COMPLETED_WITH_WARNINGS";
      await this.skipPublicationStep(runId, now, decision.decision);
      return this.repository.updateRunStatus({
        runId,
        status: finalStatus,
        completedAt: now,
        occurredAt: now,
        event: event(runId, "EDITORIAL_ORCHESTRATION_COMPLETED", now, {
          decision: decision.decision,
          automaticPublication: false,
        }),
      });
    }
    await this.repository.updateRunStatus({
      runId,
      status: "RUNNING",
      occurredAt: now,
      event: event(runId, "EDITORIAL_ORCHESTRATION_RESUMED", now),
    });
    return this.advance(runId);
  }

  getRun(runId: string): Promise<EditorialOrchestrationRun> {
    return this.repository.getRun(runId).then((run) => {
      if (run === undefined) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_RUN_NOT_FOUND",
          "Orchestration run not found.",
        );
      }
      return run;
    });
  }

  listRuns(): Promise<readonly EditorialOrchestrationRun[]> {
    return this.repository.listRuns();
  }

  getPendingHumanDecisions(): Promise<readonly HumanDecisionRequest[]> {
    return this.repository.getPendingHumanDecisions(this.clock());
  }

  async registerHumanDecision(input: {
    readonly requestId: string;
    readonly reviewerId: string;
    readonly decision: HumanEditorialDecision;
    readonly receivedAt: string;
    readonly idempotencyKey: string;
    readonly reason?: string;
    readonly changeInstructions?: readonly string[];
    readonly externalMessageReference?: string;
  }): Promise<{ readonly decision: PersistedHumanDecision; readonly replayed: boolean }> {
    validateDecisionInput(input);
    const request = await this.repository.getDecisionRequest(input.requestId);
    if (request === undefined) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_REQUEST_NOT_FOUND",
        "Human decision request not found.",
      );
    }
    if (new Date(input.receivedAt).getTime() > new Date(request.expiresAt).getTime()) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_EXPIRED",
        "Human decision request expired.",
      );
    }
    if (request.status === "CANCELLED" || request.status === "EXPIRED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_NOT_PENDING",
        "Human decision request is not pending.",
      );
    }
    const decisionFingerprint = fingerprint({
      requestId: request.id,
      draftId: request.draftId,
      draftVersion: request.draftVersion,
      reviewerId: input.reviewerId,
      decision: input.decision,
      reason: input.reason ?? null,
      changeInstructions: input.changeInstructions ?? [],
      idempotencyKey: input.idempotencyKey,
    });
    const decisionBase = {
      id: `human-decision-${decisionFingerprint.slice(0, 24)}`,
      requestId: request.id,
      reviewerId: input.reviewerId,
      decision: input.decision,
      receivedAt: input.receivedAt,
      functionalFingerprint: decisionFingerprint,
    };
    const decision: PersistedHumanDecision = {
      ...decisionBase,
      ...(input.reason === undefined ? {} : { reason: cleanText(input.reason, 2_000) }),
      ...(input.changeInstructions === undefined
        ? {}
        : { changeInstructions: input.changeInstructions.map((item) => cleanText(item, 1_000)) }),
      ...(input.externalMessageReference === undefined
        ? {}
        : { externalMessageReference: cleanReference(input.externalMessageReference) }),
    };
    const prior = await this.repository.getDecisionByRequest(request.id);
    if (prior !== undefined) {
      if (prior.functionalFingerprint !== decision.functionalFingerprint) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_DECISION_CONFLICT",
          "A different final decision already exists.",
        );
      }
      return { decision: prior, replayed: true };
    }
    await this.decisionExecutor.execute({ request, decision });
    return this.repository.registerDecision({
      requestId: request.id,
      decision,
      event: event(
        request.runId,
        "HUMAN_DECISION_RECEIVED",
        input.receivedAt,
        { decision: decision.decision, reviewerId: decision.reviewerId },
        undefined,
        request.id,
      ),
    });
  }

  async registerExternalDecision(input: ExternalDecisionInput): Promise<
    | { readonly kind: "DETAILS"; readonly request: HumanDecisionRequest }
    | {
      readonly kind: "DECISION";
      readonly request: HumanDecisionRequest;
      readonly decision: PersistedHumanDecision;
      readonly replayed: boolean;
    }
  > {
    const parsed = this.channel.parseDecision(input);
    const request = await this.repository.getDecisionRequest(parsed.requestId);
    if (request === undefined) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_REQUEST_NOT_FOUND",
        "Human decision request not found.",
      );
    }
    if (parsed.kind === "DETAILS") return { kind: "DETAILS", request };
    const changeInstructions = parsed.changeInstructions ??
      (parsed.decision === "REQUEST_CHANGES"
        ? ["Revisão editorial solicitada via Telegram; forneça instruções antes de uma nova versão."]
        : undefined);
    const saved = await this.registerHumanDecision({
      requestId: parsed.requestId,
      reviewerId: parsed.reviewerId,
      decision: parsed.decision,
      receivedAt: parsed.receivedAt,
      idempotencyKey: `external:${parsed.externalMessageReference ?? parsed.requestId}:${parsed.decision}`,
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      ...(changeInstructions === undefined
        ? {}
        : { changeInstructions }),
      ...(parsed.externalMessageReference === undefined
        ? {}
        : { externalMessageReference: parsed.externalMessageReference }),
    });
    return { kind: "DECISION", request, ...saved };
  }

  async retryFailedStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
  }): Promise<EditorialOrchestrationRun> {
    const run = await this.getRun(input.runId);
    const step = stepFor(run, input.stepType);
    if (step.status !== "FAILED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_STEP_NOT_FAILED",
        "Only a failed step can be retried.",
      );
    }
    if (!step.errorCode || !TRANSIENT_ERROR_CODES.has(step.errorCode)) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_RETRY_NOT_ALLOWED",
        "Permanent or domain failures cannot be retried.",
      );
    }
    if (step.attemptCount >= EDITORIAL_ORCHESTRATION_POLICY_V1.retry.maximumAttempts) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_RETRY_LIMIT_REACHED",
        "Retry limit reached.",
      );
    }
    await this.repository.resetFailedStep({
      runId: input.runId,
      stepType: input.stepType,
      occurredAt: this.clock(),
    });
    return this.resumeRun(input.runId);
  }

  async cancelRun(input: {
    readonly runId: string;
    readonly operator: string;
    readonly reason: string;
  }): Promise<EditorialOrchestrationRun> {
    if (!safeIdentifier.test(input.operator)) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_INVALID_OPERATOR",
        "Invalid operator identifier.",
      );
    }
    const reason = cleanText(input.reason, 1_000);
    const run = await this.getRun(input.runId);
    if (run.status === "COMPLETED" || run.status === "COMPLETED_WITH_WARNINGS") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_TERMINAL_RUN",
        "Completed runs cannot be cancelled.",
      );
    }
    if (run.status === "CANCELLED") return run;
    const now = this.clock();
    return this.repository.updateRunStatus({
      runId: input.runId,
      status: "CANCELLED",
      completedAt: now,
      occurredAt: now,
      event: event(input.runId, "EDITORIAL_ORCHESTRATION_FAILED", now, {
        cancelled: true,
        operator: input.operator,
        reason,
      }),
    });
  }

  private async advance(runId: string): Promise<EditorialOrchestrationRun> {
    await this.repository.updateRunStatus({
      runId,
      status: "RUNNING",
      occurredAt: this.clock(),
    });
    try {
      const ingested = await this.executeReferenceStep(
        runId,
        "RADAR_INGESTION",
        async (key) => this.pipeline.ingest({
          sourceIds: EDITORIAL_ORCHESTRATION_POLICY_V1.officialSourceIds,
          maximumItems: EDITORIAL_ORCHESTRATION_POLICY_V1.maximumIngestedItems,
          idempotencyKey: key,
        }),
      );
      const relevant = await this.executeReferenceStep(
        runId,
        "RELEVANCE_EVALUATION",
        async (key) => this.pipeline.evaluateRelevance({
          items: decodeReferences<EditorialPipelineReference>(ingested),
          minimumScore: EDITORIAL_ORCHESTRATION_POLICY_V1.minimumRelevanceScore,
          idempotencyKey: key,
        }),
      );
      const eligible = decodeReferences<RelevanceReference>(relevant)
        .filter((item) => item.eligible)
        .slice(0, EDITORIAL_ORCHESTRATION_POLICY_V1.maximumEvidenceItems);
      const evidence = await this.executeReferenceStep(
        runId,
        "EVIDENCE_ACQUISITION",
        async (key) => this.pipeline.acquireEvidence({
          items: eligible,
          maximumItems: EDITORIAL_ORCHESTRATION_POLICY_V1.maximumEvidenceItems,
          idempotencyKey: key,
        }),
      );
      const verified = await this.executeReferenceStep(
        runId,
        "FACTUAL_VERIFICATION",
        async (key) => this.pipeline.verifyFacts({
          items: decodeReferences<EvidenceReference>(evidence),
          idempotencyKey: key,
        }),
      );
      const verifiedEligible = decodeReferences<VerificationReference>(verified)
        .filter((item) =>
          (EDITORIAL_ORCHESTRATION_POLICY_V1.eligibleVerificationStatuses as readonly string[])
            .includes(item.status)
        );
      const drafted = await this.executeReferenceStep(
        runId,
        "DRAFT_GENERATION",
        async (key) => this.pipeline.generateDrafts({
          items: verifiedEligible,
          maximumDrafts: EDITORIAL_ORCHESTRATION_POLICY_V1.maximumDrafts,
          idempotencyKey: key,
        }),
      );
      const drafts = decodeReferences<DraftReference>(drafted);
      if (drafts.length === 0) {
        const now = this.clock();
        await this.skipHumanSteps(runId, now, "NO_ELIGIBLE_DRAFT");
        await this.skipPublicationStep(runId, now, "NO_HUMAN_APPROVAL");
        return this.repository.updateRunStatus({
          runId,
          status: "COMPLETED_WITH_WARNINGS",
          completedAt: now,
          occurredAt: now,
          event: event(runId, "EDITORIAL_ORCHESTRATION_COMPLETED", now, {
            warning: "NO_ELIGIBLE_DRAFT",
          }),
        });
      }
      await this.notifyHuman(runId, drafts.slice(
        0,
        EDITORIAL_ORCHESTRATION_POLICY_V1.maximumPendingHumanDecisions,
      ));
      const now = this.clock();
      return this.repository.updateRunStatus({
        runId,
        status: "WAITING_HUMAN_DECISION",
        occurredAt: now,
        event: event(runId, "EDITORIAL_ORCHESTRATION_WAITING_HUMAN", now),
      });
    } catch (error) {
      const now = this.clock();
      await this.repository.updateRunStatus({
        runId,
        status: "FAILED",
        occurredAt: now,
        event: event(runId, "EDITORIAL_ORCHESTRATION_FAILED", now, {
          errorCode: errorCode(error),
        }),
      });
      throw error;
    }
  }

  private async executeReferenceStep<T extends object>(
    runId: string,
    stepType: EditorialOrchestrationStepType,
    operation: (idempotencyKey: string) => Promise<readonly T[]>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const current = stepFor(await this.getRun(runId), stepType);
    if (current.status === "COMPLETED") return current.outputReference ?? { references: [] };
    const now = this.clock();
    const started = await this.repository.startStep({ runId, stepType, occurredAt: now });
    const attempt: EditorialOrchestrationAttempt = {
      id: `${started.id}:attempt:${started.attemptCount}`,
      runId,
      stepId: started.id,
      attemptNumber: started.attemptCount,
      status: "STARTED",
      startedAt: now,
    };
    await this.repository.recordAttempt(attempt);
    try {
      const values = await operation(`${runId}:${stepType}`);
      const bounded = values.slice(0, EDITORIAL_ORCHESTRATION_POLICY_V1.maximumIngestedItems);
      const output = { references: bounded };
      assertBoundedMetadata(output);
      await this.repository.recordAttempt({
        ...attempt,
        status: "SUCCEEDED",
        completedAt: this.clock(),
      });
      const completed = await this.repository.completeStep({
        runId,
        stepType,
        outputReference: output,
        occurredAt: this.clock(),
      });
      return completed.outputReference ?? output;
    } catch (error) {
      const code = errorCode(error);
      await this.repository.recordAttempt({
        ...attempt,
        status: "FAILED",
        errorCode: code,
        completedAt: this.clock(),
      });
      await this.repository.failStep({
        runId,
        stepType,
        errorCode: code,
        occurredAt: this.clock(),
      });
      throw error;
    }
  }

  private async notifyHuman(
    runId: string,
    drafts: readonly DraftReference[],
  ): Promise<void> {
    const step = stepFor(await this.getRun(runId), "HUMAN_REVIEW_NOTIFICATION");
    if (step.status === "COMPLETED") return;
    const started = await this.repository.startStep({
      runId,
      stepType: "HUMAN_REVIEW_NOTIFICATION",
      occurredAt: this.clock(),
    });
    const attempt: EditorialOrchestrationAttempt = {
      id: `${started.id}:attempt:${started.attemptCount}`,
      runId,
      stepId: started.id,
      attemptNumber: started.attemptCount,
      status: "STARTED",
      startedAt: this.clock(),
    };
    await this.repository.recordAttempt(attempt);
    try {
      const requestIds: string[] = [];
      for (const draft of drafts) {
        const context = validateDecisionMessage(
          await this.pipeline.getDecisionMessage(draft),
        );
        if (context.draftId !== draft.draftId ||
          context.draftVersion !== draft.draftVersion) {
          throw new EditorialOrchestrationError(
            "EDITORIAL_ORCHESTRATION_DRAFT_CONTEXT_MISMATCH",
            "Decision context does not match the selected draft.",
          );
        }
        const createdAt = this.clock();
        const requestFingerprint = fingerprint({
          runId,
          draftId: draft.draftId,
          draftVersion: draft.draftVersion,
          channel: this.channel.kind,
          policyVersion: EDITORIAL_ORCHESTRATION_POLICY_V1.version,
        });
        const requestId = `decision-request-${requestFingerprint.slice(0, 20)}`;
        const request: HumanDecisionRequest = {
          id: requestId,
          runId,
          draftId: draft.draftId,
          draftVersion: draft.draftVersion,
          newsVersion: draft.newsVersion,
          channel: this.channel.kind,
          recipientReference: this.channel.kind === "CONSOLE"
            ? "local-console"
            : "configured-telegram-approver",
          status: "PENDING",
          expiresAt: new Date(
            new Date(createdAt).getTime() +
              EDITORIAL_ORCHESTRATION_POLICY_V1.decisionTimeoutHours * 3_600_000,
          ).toISOString(),
          functionalFingerprint: requestFingerprint,
          context,
          createdAt,
        };
        const saved = await this.repository.createDecisionRequest(
          request,
          event(
            runId,
            "HUMAN_DECISION_REQUESTED",
            createdAt,
            { draftId: draft.draftId, draftVersion: draft.draftVersion },
            started.id,
            requestId,
          ),
        );
        const delivery = await this.channel.sendDecisionRequest(saved.request);
        await this.repository.markDecisionDelivered({
          requestId,
          delivery,
          event: event(
            runId,
            "HUMAN_DECISION_DELIVERED",
            delivery.deliveredAt,
            { channel: delivery.channel, replayed: delivery.replayed },
            started.id,
            requestId,
          ),
        });
        requestIds.push(requestId);
      }
      await this.repository.recordAttempt({
        ...attempt,
        status: "SUCCEEDED",
        completedAt: this.clock(),
      });
      await this.repository.completeStep({
        runId,
        stepType: "HUMAN_REVIEW_NOTIFICATION",
        outputReference: { requestIds },
        occurredAt: this.clock(),
      });
    } catch (error) {
      const code = errorCode(error);
      await this.repository.recordAttempt({
        ...attempt,
        status: "FAILED",
        errorCode: code,
        completedAt: this.clock(),
      });
      await this.repository.failStep({
        runId,
        stepType: "HUMAN_REVIEW_NOTIFICATION",
        errorCode: code,
        occurredAt: this.clock(),
      });
      throw error;
    }
  }

  private async ensureDecisionStep(
    runId: string,
    decision: PersistedHumanDecision,
    now: string,
  ): Promise<void> {
    const step = stepFor(await this.getRun(runId), "HUMAN_DECISION");
    if (step.status === "COMPLETED") return;
    if (step.status === "PENDING") {
      await this.repository.startStep({
        runId,
        stepType: "HUMAN_DECISION",
        occurredAt: now,
      });
    }
    await this.repository.completeStep({
      runId,
      stepType: "HUMAN_DECISION",
      outputReference: {
        decisionId: decision.id,
        decision: decision.decision,
      },
      occurredAt: now,
    });
  }

  private async skipHumanSteps(
    runId: string,
    now: string,
    reason: string,
  ): Promise<void> {
    for (const stepType of [
      "HUMAN_REVIEW_NOTIFICATION",
      "HUMAN_DECISION",
    ] as const) {
      const step = stepFor(await this.getRun(runId), stepType);
      if (step.status === "PENDING") {
        await this.repository.completeStep({
          runId,
          stepType,
          outputReference: { skipped: true, reason },
          occurredAt: now,
        });
      }
    }
  }

  private async skipPublicationStep(
    runId: string,
    now: string,
    reason: string,
  ): Promise<void> {
    const step = stepFor(
      await this.getRun(runId),
      "PUBLICATION_PACKAGE_PREPARATION",
    );
    if (step.status !== "PENDING") return;
    await this.repository.completeStep({
      runId,
      stepType: "PUBLICATION_PACKAGE_PREPARATION",
      outputReference: {
        skipped: true,
        reason,
        automaticPublication: false,
      },
      occurredAt: now,
    });
  }
}

export class InMemoryEditorialOrchestrationRepository
implements EditorialOrchestrationRepository {
  private readonly runs = new Map<string, EditorialOrchestrationRun>();
  private readonly triggerKeys = new Map<string, string>();
  private readonly requests = new Map<string, HumanDecisionRequest>();
  private readonly decisions = new Map<string, PersistedHumanDecision>();
  private readonly decisionKeys = new Map<string, string>();
  private readonly events = new Map<string, EditorialOrchestrationEvent[]>();
  private readonly attempts = new Map<string, EditorialOrchestrationAttempt>();

  async createRun(run: EditorialOrchestrationRun, firstEvent: EditorialOrchestrationEvent) {
    const priorId = this.triggerKeys.get(run.triggerKey);
    if (priorId !== undefined) {
      const prior = this.runs.get(priorId)!;
      if (prior.functionalFingerprint !== run.functionalFingerprint) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT",
          "Trigger key was reused with incompatible functional input.",
        );
      }
      return { run: clone(prior), replayed: true };
    }
    this.runs.set(run.id, clone(run));
    this.triggerKeys.set(run.triggerKey, run.id);
    this.appendEvent(firstEvent);
    return { run: clone(run), replayed: false };
  }

  async getRun(id: string) {
    const run = this.runs.get(id);
    return run === undefined ? undefined : clone(run);
  }

  async listRuns() {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async updateRunStatus(input: {
    readonly runId: string;
    readonly status: EditorialOrchestrationRunStatus;
    readonly occurredAt: string;
    readonly completedAt?: string;
    readonly event?: EditorialOrchestrationEvent;
  }) {
    const run = this.requireRun(input.runId);
    const updated: EditorialOrchestrationRun = {
      ...run,
      status: input.status,
      updatedAt: input.occurredAt,
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    };
    this.runs.set(run.id, updated);
    if (input.status === "CANCELLED") {
      for (const [id, request] of this.requests) {
        if (request.runId === input.runId &&
          (request.status === "PENDING" || request.status === "DELIVERED")) {
          this.requests.set(id, { ...request, status: "CANCELLED" });
        }
      }
    }
    if (input.event !== undefined) this.appendEvent(input.event);
    return clone(updated);
  }

  async startStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }) {
    const run = this.requireRun(input.runId);
    const step = stepFor(run, input.stepType);
    if (step.status === "COMPLETED" || step.status === "SKIPPED") return clone(step);
    if (step.status === "RUNNING") return clone(step);
    if (step.status === "FAILED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_STEP_FAILED",
        "Failed step must be reset before retry.",
      );
    }
    const updated: EditorialOrchestrationStep = {
      ...step,
      status: "RUNNING",
      attemptCount: step.attemptCount + 1,
      startedAt: input.occurredAt,
    };
    this.replaceStep(run, updated, input.occurredAt);
    this.appendEvent(event(
      run.id,
      "EDITORIAL_ORCHESTRATION_STEP_STARTED",
      input.occurredAt,
      { stepType: input.stepType, attemptCount: updated.attemptCount },
      step.id,
    ));
    return clone(updated);
  }

  async completeStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly outputReference: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  }) {
    assertBoundedMetadata(input.outputReference);
    const run = this.requireRun(input.runId);
    const step = stepFor(run, input.stepType);
    if (step.status === "COMPLETED") return clone(step);
    const updated: EditorialOrchestrationStep = {
      ...step,
      status: input.outputReference.skipped === true ? "SKIPPED" : "COMPLETED",
      outputReference: clone(input.outputReference),
      completedAt: input.occurredAt,
    };
    this.replaceStep(run, updated, input.occurredAt);
    this.appendEvent(event(
      run.id,
      "EDITORIAL_ORCHESTRATION_STEP_COMPLETED",
      input.occurredAt,
      { stepType: input.stepType, status: updated.status },
      step.id,
    ));
    return clone(updated);
  }

  async failStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly errorCode: string;
    readonly occurredAt: string;
  }) {
    const run = this.requireRun(input.runId);
    const step = stepFor(run, input.stepType);
    const updated: EditorialOrchestrationStep = {
      ...step,
      status: "FAILED",
      errorCode: input.errorCode,
      completedAt: input.occurredAt,
    };
    this.replaceStep(run, updated, input.occurredAt);
    return clone(updated);
  }

  async resetFailedStep(input: {
    readonly runId: string;
    readonly stepType: EditorialOrchestrationStepType;
    readonly occurredAt: string;
  }) {
    const run = this.requireRun(input.runId);
    const step = stepFor(run, input.stepType);
    if (step.status !== "FAILED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_STEP_NOT_FAILED",
        "Step is not failed.",
      );
    }
    const updated: EditorialOrchestrationStep = {
      id: step.id,
      runId: step.runId,
      position: step.position,
      stepType: step.stepType,
      status: "PENDING",
      attemptCount: step.attemptCount,
      metadata: step.metadata,
    };
    this.replaceStep(run, updated, input.occurredAt);
    return clone(updated);
  }

  async createDecisionRequest(
    request: HumanDecisionRequest,
    requestEvent: EditorialOrchestrationEvent,
  ) {
    const prior = this.requests.get(request.id);
    if (prior !== undefined) {
      if (prior.functionalFingerprint !== request.functionalFingerprint) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT",
          "Decision request identity conflict.",
        );
      }
      return { request: clone(prior), replayed: true };
    }
    const duplicateDraft = [...this.requests.values()].find((item) =>
      item.runId === request.runId &&
      item.draftId === request.draftId &&
      item.draftVersion === request.draftVersion
    );
    if (duplicateDraft !== undefined) {
      return { request: clone(duplicateDraft), replayed: true };
    }
    this.requests.set(request.id, clone(request));
    this.appendEvent(requestEvent);
    return { request: clone(request), replayed: false };
  }

  async markDecisionDelivered(input: {
    readonly requestId: string;
    readonly delivery: HumanDecisionDelivery;
    readonly event: EditorialOrchestrationEvent;
  }) {
    const request = this.requireRequest(input.requestId);
    if (request.status === "DELIVERED" || request.status === "DECIDED") {
      return clone(request);
    }
    const updated: HumanDecisionRequest = {
      ...request,
      status: "DELIVERED",
      recipientReference: input.delivery.recipientReference,
      deliveredAt: input.delivery.deliveredAt,
    };
    this.requests.set(request.id, updated);
    this.appendEvent(input.event);
    return clone(updated);
  }

  async getDecisionRequest(id: string) {
    const request = this.requests.get(id);
    return request === undefined ? undefined : clone(request);
  }

  async getPendingHumanDecisions(now: string) {
    const instant = new Date(now).getTime();
    for (const [id, request] of this.requests) {
      if ((request.status === "PENDING" || request.status === "DELIVERED") &&
        new Date(request.expiresAt).getTime() < instant) {
        this.requests.set(id, { ...request, status: "EXPIRED" });
      }
    }
    return [...this.requests.values()]
      .filter((request) => request.status === "PENDING" || request.status === "DELIVERED")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async registerDecision(input: {
    readonly requestId: string;
    readonly decision: PersistedHumanDecision;
    readonly event: EditorialOrchestrationEvent;
  }) {
    const request = this.requireRequest(input.requestId);
    const priorId = this.decisionKeys.get(request.id);
    if (priorId !== undefined) {
      const prior = this.decisions.get(priorId)!;
      if (prior.functionalFingerprint !== input.decision.functionalFingerprint) {
        throw new EditorialOrchestrationError(
          "EDITORIAL_ORCHESTRATION_DECISION_CONFLICT",
          "A different final decision already exists.",
        );
      }
      return { decision: clone(prior), replayed: true };
    }
    if (request.status !== "PENDING" && request.status !== "DELIVERED") {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_NOT_PENDING",
        "Human decision request is not pending.",
      );
    }
    this.decisions.set(input.decision.id, clone(input.decision));
    this.decisionKeys.set(request.id, input.decision.id);
    this.requests.set(request.id, { ...request, status: "DECIDED" });
    this.appendEvent(input.event);
    return { decision: clone(input.decision), replayed: false };
  }

  async getDecisionByRequest(requestId: string) {
    const id = this.decisionKeys.get(requestId);
    return id === undefined ? undefined : clone(this.decisions.get(id)!);
  }

  async getDecisionForRun(runId: string) {
    const request = [...this.requests.values()].find((item) => item.runId === runId);
    if (request === undefined) return undefined;
    const id = this.decisionKeys.get(request.id);
    return id === undefined ? undefined : clone(this.decisions.get(id)!);
  }

  async recordAttempt(attempt: EditorialOrchestrationAttempt) {
    const prior = this.attempts.get(attempt.id);
    if (prior !== undefined && prior.status !== "STARTED" &&
      attempt.status === "STARTED") return;
    this.attempts.set(attempt.id, clone(attempt));
  }

  async listEvents(runId: string) {
    return (this.events.get(runId) ?? []).map(clone);
  }

  private requireRun(id: string) {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_RUN_NOT_FOUND",
        "Orchestration run not found.",
      );
    }
    return run;
  }

  private requireRequest(id: string) {
    const request = this.requests.get(id);
    if (request === undefined) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DECISION_REQUEST_NOT_FOUND",
        "Decision request not found.",
      );
    }
    return request;
  }

  private replaceStep(
    run: EditorialOrchestrationRun,
    step: EditorialOrchestrationStep,
    updatedAt: string,
  ) {
    this.runs.set(run.id, {
      ...run,
      steps: run.steps.map((item) => item.id === step.id ? step : item),
      updatedAt,
    });
  }

  private appendEvent(item: EditorialOrchestrationEvent) {
    const current = this.events.get(item.runId) ?? [];
    if (!current.some((eventItem) => eventItem.id === item.id)) {
      this.events.set(item.runId, [...current, clone(item)]);
    }
  }
}

export class InMemoryHumanDecisionChannel implements HumanDecisionChannel {
  readonly kind = "CONSOLE" as const;
  readonly deliveries: HumanDecisionRequest[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string) {
    this.clock = clock;
  }

  async sendDecisionRequest(request: HumanDecisionRequest) {
    const replayed = this.deliveries.some((item) => item.id === request.id);
    if (!replayed) this.deliveries.push(clone(request));
    return {
      channel: this.kind,
      recipientReference: "local-console",
      externalMessageReference: `console:${request.id}`,
      deliveredAt: this.clock(),
      replayed,
    };
  }

  parseDecision(input: ExternalDecisionInput): ParsedExternalDecision {
    const parts = input.callbackData.split(":");
    const action = parts[0];
    const requestId = parts[1];
    if (!action || !requestId) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_INVALID_CALLBACK",
        "Invalid console callback.",
      );
    }
    const reviewerId = input.userId ?? `console-${input.chatId}`;
    if (action === "details") {
      return { kind: "DETAILS", requestId, reviewerId, receivedAt: input.receivedAt };
    }
    const decision = callbackDecision(action);
    return {
      kind: "DECISION",
      requestId,
      reviewerId,
      decision,
      receivedAt: input.receivedAt,
      ...(input.externalMessageReference === undefined
        ? {}
        : { externalMessageReference: input.externalMessageReference }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.changeInstructions === undefined
        ? {}
        : { changeInstructions: input.changeInstructions }),
    };
  }
}

export class ConsoleHumanDecisionChannel extends InMemoryHumanDecisionChannel {
  override async sendDecisionRequest(request: HumanDecisionRequest) {
    const delivery = await super.sendDecisionRequest(request);
    const message = formatHumanDecisionMessage(request.context);
    process.stdout.write(`${message}\nRequest: ${request.id}\n`);
    return delivery;
  }
}

export interface TelegramHumanDecisionChannelOptions {
  readonly botToken: string;
  readonly approverChatId: string;
  readonly webhookSecret: string;
  readonly allowedUserIds?: readonly string[];
  readonly fetchImplementation?: typeof fetch;
  readonly clock: () => string;
  readonly timeoutMilliseconds?: number;
}

export class TelegramHumanDecisionChannel implements HumanDecisionChannel {
  readonly kind = "TELEGRAM" as const;
  private readonly botToken: string;
  private readonly approverChatId: string;
  private readonly webhookSecret: string;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly fetchImplementation: typeof fetch;
  private readonly clock: () => string;
  private readonly timeoutMilliseconds: number;

  constructor(options: TelegramHumanDecisionChannelOptions) {
    if (!options.botToken || !options.approverChatId || !options.webhookSecret) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_TELEGRAM_CONFIG_MISSING",
        "Telegram requires bot token, approver chat and webhook secret.",
      );
    }
    this.botToken = options.botToken;
    this.approverChatId = options.approverChatId;
    this.webhookSecret = options.webhookSecret;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.clock = options.clock;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 8_000;
  }

  async sendDecisionRequest(request: HumanDecisionRequest): Promise<HumanDecisionDelivery> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    const callback = (action: "approve" | "reject" | "changes" | "details") =>
      this.signCallback(action, request.id);
    const body = JSON.stringify({
      chat_id: this.approverChatId,
      text: formatHumanDecisionMessage(request.context),
      reply_markup: {
        inline_keyboard: [
          [
            { text: "APROVAR", callback_data: callback("approve") },
            { text: "REJEITAR", callback_data: callback("reject") },
          ],
          [
            { text: "PEDIR REVISÃO", callback_data: callback("changes") },
            { text: "VER DETALHES", callback_data: callback("details") },
          ],
        ],
      },
    });
    if (Buffer.byteLength(body) > 16_000) {
      clearTimeout(timeout);
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_TELEGRAM_PAYLOAD_TOO_LARGE",
        "Telegram decision payload exceeds the local limit.",
      );
    }
    try {
      const response = await this.fetchImplementation(
        `https://api.telegram.org/bot${encodeURIComponent(this.botToken)}/sendMessage`,
        {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new EditorialOrchestrationError(
          "ORCHESTRATION_TELEGRAM_UNAVAILABLE",
          "Telegram delivery failed.",
          response.status >= 500 || response.status === 429,
        );
      }
      const payload = await response.json() as {
        readonly ok?: boolean;
        readonly result?: { readonly message_id?: number };
      };
      if (payload.ok !== true || !Number.isSafeInteger(payload.result?.message_id)) {
        throw new EditorialOrchestrationError(
          "ORCHESTRATION_TELEGRAM_UNAVAILABLE",
          "Telegram returned an invalid bounded response.",
          true,
        );
      }
      return {
        channel: "TELEGRAM",
        recipientReference: "configured-telegram-approver",
        externalMessageReference: `telegram-message:${payload.result?.message_id}`,
        deliveredAt: this.clock(),
        replayed: false,
      };
    } catch (error) {
      if (error instanceof EditorialOrchestrationError) throw error;
      throw new EditorialOrchestrationError(
        "ORCHESTRATION_TELEGRAM_UNAVAILABLE",
        "Telegram delivery was unavailable.",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  parseDecision(input: ExternalDecisionInput): ParsedExternalDecision {
    if (input.chatId !== this.approverChatId) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_TELEGRAM_CHAT_UNAUTHORIZED",
        "Telegram chat is not authorized.",
      );
    }
    if (this.allowedUserIds.size > 0 &&
      (input.userId === undefined || !this.allowedUserIds.has(input.userId))) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_TELEGRAM_USER_UNAUTHORIZED",
        "Telegram user is not authorized.",
      );
    }
    const parts = input.callbackData.split(":");
    if (parts.length !== 3) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_INVALID_CALLBACK",
        "Telegram callback structure is invalid.",
      );
    }
    const [action, requestId, signature] = parts;
    if (!action || !requestId || !signature ||
      !this.verifyCallback(action, requestId, signature)) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_CALLBACK_SIGNATURE_INVALID",
        "Telegram callback signature is invalid.",
      );
    }
    const reviewerId = input.userId ?? `telegram-chat-${input.chatId}`;
    if (action === "details") {
      return { kind: "DETAILS", requestId, reviewerId, receivedAt: input.receivedAt };
    }
    return {
      kind: "DECISION",
      requestId,
      reviewerId,
      decision: callbackDecision(action),
      receivedAt: input.receivedAt,
      ...(input.externalMessageReference === undefined
        ? {}
        : { externalMessageReference: input.externalMessageReference }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.changeInstructions === undefined
        ? {}
        : { changeInstructions: input.changeInstructions }),
    };
  }

  signCallback(
    action: "approve" | "reject" | "changes" | "details",
    requestId: string,
  ): string {
    const signature = createHmac("sha256", this.webhookSecret)
      .update(`${action}:${requestId}`)
      .digest("base64url")
      .slice(0, 16);
    return `${action}:${requestId}:${signature}`;
  }

  private verifyCallback(action: string, requestId: string, received: string) {
    if (!["approve", "reject", "changes", "details"].includes(action)) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${action}:${requestId}`)
      .digest("base64url")
      .slice(0, 16);
    const expectedBytes = Buffer.from(expected);
    const receivedBytes = Buffer.from(received);
    return expectedBytes.length === receivedBytes.length &&
      timingSafeEqual(expectedBytes, receivedBytes);
  }
}

export class HumanReviewServiceDecisionExecutor
implements HumanEditorialDecisionExecutor {
  private readonly reviewService: {
    approve(input: {
      reviewId: string;
      draftId: string;
      expectedDraftVersion: number;
      expectedNewsVersion: number;
      reviewerId: string;
      reason?: string;
      revisionInstructions?: string[];
      reviewedAt: string;
      idempotencyKey: string;
    }): Promise<{ readonly replayed: boolean }>;
    reject(input: {
      reviewId: string;
      draftId: string;
      expectedDraftVersion: number;
      expectedNewsVersion: number;
      reviewerId: string;
      reason?: string;
      revisionInstructions?: string[];
      reviewedAt: string;
      idempotencyKey: string;
    }): Promise<{ readonly replayed: boolean }>;
    requestRevision(input: {
      reviewId: string;
      draftId: string;
      expectedDraftVersion: number;
      expectedNewsVersion: number;
      reviewerId: string;
      reason?: string;
      revisionInstructions?: string[];
      reviewedAt: string;
      idempotencyKey: string;
    }): Promise<{ readonly replayed: boolean }>;
  };

  constructor(reviewService: HumanReviewServiceDecisionExecutor["reviewService"]) {
    this.reviewService = reviewService;
  }

  async execute(input: {
    readonly request: HumanDecisionRequest;
    readonly decision: PersistedHumanDecision;
  }) {
    const common = {
      reviewId: input.decision.id,
      draftId: input.request.draftId,
      expectedDraftVersion: input.request.draftVersion,
      expectedNewsVersion: input.request.newsVersion,
      reviewerId: input.decision.reviewerId,
      reviewedAt: input.decision.receivedAt,
      idempotencyKey: `orchestration:${input.decision.functionalFingerprint}`,
    };
    if (input.decision.decision === "APPROVE") {
      const result = await this.reviewService.approve(common);
      return { resultReference: input.decision.id, replayed: result.replayed };
    }
    if (input.decision.decision === "REJECT") {
      const result = await this.reviewService.reject({
        ...common,
        reason: input.decision.reason ?? "Rejected through supervised orchestration.",
      });
      return { resultReference: input.decision.id, replayed: result.replayed };
    }
    const result = await this.reviewService.requestRevision({
      ...common,
      reason: input.decision.reason ?? "Changes requested through supervised orchestration.",
      revisionInstructions: [...(input.decision.changeInstructions ?? [
        "Review the requested editorial changes with the human operator.",
      ])],
    });
    return { resultReference: input.decision.id, replayed: result.replayed };
  }
}

export class InMemoryHumanEditorialDecisionExecutor
implements HumanEditorialDecisionExecutor {
  readonly executed: PersistedHumanDecision[] = [];

  async execute(input: {
    readonly request: HumanDecisionRequest;
    readonly decision: PersistedHumanDecision;
  }) {
    if (input.request.draftId !== input.request.context.draftId ||
      input.request.draftVersion !== input.request.context.draftVersion) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_DRAFT_CONTEXT_MISMATCH",
        "Decision cannot target a different draft.",
      );
    }
    const replayed = this.executed.some((item) =>
      item.functionalFingerprint === input.decision.functionalFingerprint
    );
    if (!replayed) this.executed.push(clone(input.decision));
    return { resultReference: input.decision.id, replayed };
  }
}

export class FixtureEditorialOrchestrationPipeline
implements EditorialOrchestrationPipeline {
  readonly calls: string[] = [];
  readonly failure:
    | { readonly step: EditorialOrchestrationStepType; readonly code: string }
    | undefined;
  readonly empty: boolean;

  constructor(options: {
    readonly failure?: { readonly step: EditorialOrchestrationStepType; readonly code: string };
    readonly empty?: boolean;
  } = {}) {
    this.failure = options.failure;
    this.empty = options.empty ?? false;
  }

  async ingest(input: {
    readonly sourceIds: readonly string[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }) {
    this.call("RADAR_INGESTION");
    if (this.empty) return [];
    return [{
      id: "item-google-grounding",
      newsId: "news-google-grounding",
    }].slice(0, input.maximumItems);
  }

  async evaluateRelevance(input: {
    readonly items: readonly EditorialPipelineReference[];
    readonly minimumScore: number;
    readonly idempotencyKey: string;
  }) {
    this.call("RELEVANCE_EVALUATION");
    return input.items.map((item) => ({
      ...item,
      relevanceScore: 91,
      eligible: 91 >= input.minimumScore,
    }));
  }

  async acquireEvidence(input: {
    readonly items: readonly RelevanceReference[];
    readonly maximumItems: number;
    readonly idempotencyKey: string;
  }) {
    this.call("EVIDENCE_ACQUISITION");
    return input.items.slice(0, input.maximumItems).map((item) => ({
      ...item,
      evidenceId: `evidence-${item.newsId}`,
    }));
  }

  async verifyFacts(input: {
    readonly items: readonly EvidenceReference[];
    readonly idempotencyKey: string;
  }): Promise<readonly VerificationReference[]> {
    this.call("FACTUAL_VERIFICATION");
    return input.items.map((item) => ({
      ...item,
      verificationId: `verification-${item.newsId}`,
      status: "CONFIRMED" as const,
      confidence: 0.96,
    }));
  }

  async generateDrafts(input: {
    readonly items: readonly VerificationReference[];
    readonly maximumDrafts: number;
    readonly idempotencyKey: string;
  }) {
    this.call("DRAFT_GENERATION");
    return input.items.slice(0, input.maximumDrafts).map((item) => ({
      ...item,
      draftId: "draft-google-grounding-v1",
      draftVersion: 1,
      newsVersion: 7,
    }));
  }

  async getDecisionMessage(draft: DraftReference): Promise<HumanDecisionMessage> {
    return {
      sourceName: "Google Developers Blog",
      title: "Grounding with Parallel foi anunciado oficialmente.",
      verificationStatus: "CONFIRMED",
      confidence: 0.96,
      summary: "Resumo factual baseado na fonte oficial.",
      allowedClaims: ["Google announced Grounding with Parallel."],
      limitations: ["Não afirma disponibilidade geral."],
      draftId: draft.draftId,
      draftVersion: draft.draftVersion,
      newsVersion: draft.newsVersion,
    };
  }

  private call(step: EditorialOrchestrationStepType) {
    this.calls.push(step);
    if (this.failure?.step === step) {
      throw new EditorialOrchestrationError(
        this.failure.code,
        "Fixture pipeline failure.",
        TRANSIENT_ERROR_CODES.has(this.failure.code),
      );
    }
  }
}

export function formatHumanDecisionMessage(message: HumanDecisionMessage): string {
  const claims = message.allowedClaims.slice(0, 5).map((item) => `- ${item}`).join("\n");
  const limitations = message.limitations.slice(0, 5).map((item) => `- ${item}`).join("\n");
  return [
    "Nova notícia pronta para revisão",
    "",
    "Fonte:",
    cleanText(message.sourceName, 120),
    ...(message.officialLink === undefined
      ? []
      : ["", "Link oficial:", cleanHttpsUrl(message.officialLink)]),
    "",
    "Título:",
    cleanText(message.title, 240),
    "",
    "Verificação:",
    message.verificationStatus,
    "",
    "Confiança:",
    message.confidence.toFixed(2),
    "",
    "Resumo:",
    cleanText(message.summary, 800),
    "",
    "Fatos permitidos:",
    claims || "- Nenhum claim resumido.",
    "",
    "Limitações:",
    limitations || "- Nenhuma limitação adicional.",
    "",
    "Draft:",
    `${message.draftId}-versão-${message.draftVersion}`,
  ].join("\n").slice(0, 3_800);
}

function validateTrigger(input: {
  readonly triggerType: EditorialOrchestrationTrigger;
  readonly triggerKey: string;
  readonly triggeredBy: string;
}) {
  if (!["MANUAL", "N8N_SCHEDULED", "N8N_RETRY"].includes(input.triggerType)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_INVALID_TRIGGER",
      "Unsupported orchestration trigger.",
    );
  }
  if (!safeIdentifier.test(input.triggerKey) || !safeIdentifier.test(input.triggeredBy)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_INVALID_TRIGGER",
      "Trigger key and actor must be bounded safe identifiers.",
    );
  }
}

function validateDecisionInput(input: {
  readonly requestId: string;
  readonly reviewerId: string;
  readonly decision: HumanEditorialDecision;
  readonly receivedAt: string;
  readonly idempotencyKey: string;
  readonly reason?: string;
  readonly changeInstructions?: readonly string[];
}) {
  if (!safeIdentifier.test(input.requestId) ||
    !safeIdentifier.test(input.reviewerId) ||
    !safeIdentifier.test(input.idempotencyKey)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_INVALID_DECISION",
      "Decision identifiers are invalid.",
    );
  }
  if (!["APPROVE", "REJECT", "REQUEST_CHANGES"].includes(input.decision) ||
    !Number.isFinite(new Date(input.receivedAt).getTime())) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_INVALID_DECISION",
      "Decision or timestamp is invalid.",
    );
  }
  if (input.decision === "REJECT" && !input.reason?.trim()) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DECISION_REASON_REQUIRED",
      "Rejection requires a reason.",
    );
  }
  if (input.decision === "REQUEST_CHANGES" &&
    (!input.changeInstructions || input.changeInstructions.length === 0)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_CHANGE_INSTRUCTIONS_REQUIRED",
      "Change request requires controlled instructions.",
    );
  }
}

function validateDecisionMessage(message: HumanDecisionMessage) {
  if (message.verificationStatus !== "CONFIRMED" &&
    message.verificationStatus !== "PARTIALLY_CONFIRMED") {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DRAFT_NOT_ELIGIBLE",
      "Only eligible verified drafts can request a human decision.",
    );
  }
  if (!Number.isFinite(message.confidence) ||
    message.confidence < 0 || message.confidence > 1 ||
    !Number.isSafeInteger(message.draftVersion) || message.draftVersion < 1 ||
    !Number.isSafeInteger(message.newsVersion) || message.newsVersion < 0 ||
    message.allowedClaims.length > 10 || message.limitations.length > 10) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DECISION_CONTEXT_INVALID",
      "Decision message context is invalid.",
    );
  }
  cleanText(message.sourceName, 120);
  if (message.officialLink !== undefined) cleanHttpsUrl(message.officialLink);
  cleanText(message.title, 240);
  cleanText(message.summary, 800);
  message.allowedClaims.forEach((item) => cleanText(item, 500));
  message.limitations.forEach((item) => cleanText(item, 500));
  return message;
}

function cleanHttpsUrl(value: string) {
  const cleaned = value.trim();
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.hash || cleaned.length > 2_000) {
      throw new Error("unsafe URL");
    }
    return cleaned;
  } catch {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_UNSAFE_URL",
      "Decision message URL must be a bounded HTTPS URL without credentials or fragments.",
    );
  }
}

function callbackDecision(action: string): HumanEditorialDecision {
  if (action === "approve") return "APPROVE";
  if (action === "reject") return "REJECT";
  if (action === "changes") return "REQUEST_CHANGES";
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_INVALID_CALLBACK",
    "Unsupported decision action.",
  );
}

function cleanText(value: string, maximum: number) {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(cleaned) ||
    /<script|javascript:|data:|file:/i.test(cleaned)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_UNSAFE_TEXT",
      "Unsafe or excessive text.",
    );
  }
  return cleaned;
}

function cleanReference(value: string) {
  if (!safeIdentifier.test(value)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_INVALID_REFERENCE",
      "External reference is invalid.",
    );
  }
  return value;
}

function event(
  runId: string,
  eventType: EditorialOrchestrationEventType,
  occurredAt: string,
  metadata: Readonly<Record<string, unknown>> = {},
  stepId?: string,
  requestId?: string,
): EditorialOrchestrationEvent {
  const id = `orchestration-event-${fingerprint({
    runId,
    eventType,
    occurredAt,
    metadata,
    stepId: stepId ?? null,
    requestId: requestId ?? null,
  }).slice(0, 24)}`;
  return {
    id,
    runId,
    eventType,
    metadata,
    occurredAt,
    ...(stepId === undefined ? {} : { stepId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function stepFor(
  run: EditorialOrchestrationRun,
  type: EditorialOrchestrationStepType,
) {
  const step = run.steps.find((item) => item.stepType === type);
  if (step === undefined) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_STEP_NOT_FOUND",
      "Orchestration step not found.",
    );
  }
  return step;
}

function decodeReferences<T>(
  output: Readonly<Record<string, unknown>>,
): readonly T[] {
  const references = output.references;
  if (!Array.isArray(references)) return [];
  return references as readonly T[];
}

function assertBoundedMetadata(value: Readonly<Record<string, unknown>>) {
  if (Buffer.byteLength(JSON.stringify(value)) > 16_000) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_METADATA_TOO_LARGE",
      "Orchestration metadata exceeds the bounded limit.",
    );
  }
}

function errorCode(error: unknown) {
  if (error instanceof EditorialOrchestrationError) return error.code;
  if (error instanceof Error && "code" in error &&
    typeof error.code === "string") return error.code;
  return "EDITORIAL_ORCHESTRATION_UNEXPECTED_FAILURE";
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
