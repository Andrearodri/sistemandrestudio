import {
  ApprovalAlreadyProcessedError,
  ApprovalRequestNotFoundError,
  DraftVersionNotFoundError,
  DuplicateCommandError,
  InvalidActorError,
  InvalidRelevanceScoreError,
  InvalidTransitionError,
  LowRelevanceError,
  RequiredFieldMissingError,
  StaleApprovalVersionError,
} from "./errors.ts";
import type {
  ApprovalRequest,
  AuditEvent,
  CreateReceivedNewsInput,
  DraftVersion,
  EditorialCommand,
  EditorialNews,
  EditorialState,
  HumanDecision,
  RelevanceScore,
  TransitionContext,
  TransitionResult,
  ValidationIssue,
} from "./types.ts";

export const ALLOWED_TRANSITIONS = {
  RECEIVED: ["NORMALIZED"],
  NORMALIZED: ["DUPLICATE", "SCORED"],
  DUPLICATE: [],
  SCORED: ["DISCARDED_LOW_RELEVANCE", "PENDING_VERIFICATION"],
  DISCARDED_LOW_RELEVANCE: [],
  PENDING_VERIFICATION: ["VERIFIED", "VERIFICATION_REJECTED"],
  VERIFIED: ["DRAFT_CREATED"],
  VERIFICATION_REJECTED: [],
  DRAFT_CREATED: ["PENDING_APPROVAL"],
  PENDING_APPROVAL: ["CHANGES_REQUESTED", "APPROVED", "REJECTED"],
  CHANGES_REQUESTED: ["DRAFT_CREATED"],
  APPROVED: ["READY_FOR_PUBLICATION"],
  REJECTED: [],
  READY_FOR_PUBLICATION: [],
} as const satisfies Record<EditorialState, readonly EditorialState[]>;

const statesRequiringRelevance = new Set<EditorialState>([
  "SCORED",
  "DISCARDED_LOW_RELEVANCE",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "VERIFICATION_REJECTED",
  "DRAFT_CREATED",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
]);

const statesRequiringVerifiedResult = new Set<EditorialState>([
  "VERIFIED",
  "DRAFT_CREATED",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
]);

const statesRequiringDraft = new Set<EditorialState>([
  "DRAFT_CREATED",
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
]);

const statesRequiringApprovalRequest = new Set<EditorialState>([
  "PENDING_APPROVAL",
  "CHANGES_REQUESTED",
  "APPROVED",
  "REJECTED",
  "READY_FOR_PUBLICATION",
]);

export function canTransition(
  currentState: EditorialState,
  targetState: EditorialState,
): boolean {
  return (ALLOWED_TRANSITIONS[currentState] as readonly EditorialState[]).includes(
    targetState,
  );
}

export function createReceivedNews(
  input: CreateReceivedNewsInput,
): EditorialNews {
  const entity: EditorialNews = {
    id: input.id,
    source: input.source,
    title: input.title,
    originalUrl: input.originalUrl,
    canonicalUrl: null,
    publishedAt: input.publishedAt,
    eventAt: input.eventAt,
    receivedAt: input.receivedAt,
    state: "RECEIVED",
    duplicateOfNewsId: null,
    relevance: null,
    verification: null,
    draftVersions: [],
    currentDraftVersionId: null,
    approvalRequests: [],
    currentApprovalRequestId: null,
    decisions: [],
    processedCommands: [],
    auditEvents: [],
  };

  assertValidEntity(entity);
  return entity;
}

export function validateEntity(entity: EditorialNews): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  requireText(issues, "id", entity.id);
  requireText(issues, "title", entity.title);
  requireText(issues, "originalUrl", entity.originalUrl);
  requireText(issues, "publishedAt", entity.publishedAt);
  requireText(issues, "eventAt", entity.eventAt);
  requireText(issues, "receivedAt", entity.receivedAt);
  requireText(issues, "source.id", entity.source.id);
  requireText(issues, "source.name", entity.source.name);
  requireText(issues, "source.url", entity.source.url);

  if (entity.state !== "RECEIVED" && entity.state !== "NORMALIZED") {
    if (entity.canonicalUrl === null) {
      issues.push({
        field: "canonicalUrl",
        message: "A normalized entity requires a canonical URL.",
      });
    }
  }

  if (entity.state === "DUPLICATE" && entity.duplicateOfNewsId === null) {
    issues.push({
      field: "duplicateOfNewsId",
      message: "Duplicate state requires a canonical news reference.",
    });
  }

  if (statesRequiringRelevance.has(entity.state) && entity.relevance === null) {
    issues.push({
      field: "relevance",
      message: `State ${entity.state} requires a relevance score.`,
    });
  }

  if (
    entity.relevance !== null &&
    !isValidRelevanceScore(entity.relevance)
  ) {
    issues.push({
      field: "relevance",
      message: "Relevance score and threshold must be between 0 and 100.",
    });
  }

  if (
    entity.state === "DISCARDED_LOW_RELEVANCE" &&
    entity.relevance !== null &&
    entity.relevance.value >= entity.relevance.threshold
  ) {
    issues.push({
      field: "relevance",
      message: "Discarded state requires a score below the threshold.",
    });
  }

  if (
    statesRequiringVerifiedResult.has(entity.state) &&
    entity.verification?.outcome !== "VERIFIED"
  ) {
    issues.push({
      field: "verification",
      message: `State ${entity.state} requires a verified result.`,
    });
  }

  if (
    entity.state === "VERIFICATION_REJECTED" &&
    entity.verification?.outcome !== "REJECTED"
  ) {
    issues.push({
      field: "verification",
      message: "Rejected verification state requires a rejected result.",
    });
  }

  validateDrafts(entity, issues);
  validateApprovalRequests(entity, issues);
  validateProcessedCommands(entity, issues);
  validateReadyForPublication(entity, issues);

  return issues;
}

export function transition(
  entity: EditorialNews,
  command: EditorialCommand,
  context: TransitionContext,
): TransitionResult {
  assertValidEntity(entity);
  assertContext(context);

  if (command.idempotencyKey !== undefined) {
    const fingerprint = commandFingerprint(command);
    const processed = entity.processedCommands.find(
      (item) => item.idempotencyKey === command.idempotencyKey,
    );

    if (processed !== undefined) {
      if (
        processed.commandType === command.type &&
        processed.fingerprint === fingerprint
      ) {
        return { entity, event: null, replayed: true };
      }

      throw new DuplicateCommandError(command.idempotencyKey);
    }
  }

  if (entity.auditEvents.some((event) => event.id === context.eventId)) {
    throw new DuplicateCommandError(context.eventId);
  }

  const nextEntity = applyCommand(entity, command, context);
  const event = createAuditEvent(entity, nextEntity, command, context);
  const processedCommands =
    command.idempotencyKey === undefined
      ? nextEntity.processedCommands
      : [
          ...nextEntity.processedCommands,
          {
            commandType: command.type,
            fingerprint: commandFingerprint(command),
            idempotencyKey: command.idempotencyKey,
          },
        ];

  const entityWithAudit: EditorialNews = {
    ...nextEntity,
    processedCommands,
    auditEvents: [...nextEntity.auditEvents, event],
  };

  assertValidEntity(entityWithAudit);

  return {
    entity: entityWithAudit,
    event,
    replayed: false,
  };
}

function applyCommand(
  entity: EditorialNews,
  command: EditorialCommand,
  context: TransitionContext,
): EditorialNews {
  switch (command.type) {
    case "NormalizeNews":
      expectState(entity, command, "RECEIVED");
      requireCommandText("normalizedTitle", command.normalizedTitle);
      requireCommandText("canonicalUrl", command.canonicalUrl);
      return {
        ...entity,
        canonicalUrl: command.canonicalUrl,
        state: "NORMALIZED",
        title: command.normalizedTitle,
      };

    case "MarkAsDuplicate":
      expectState(entity, command, "NORMALIZED");
      requireCommandText("duplicateOfNewsId", command.duplicateOfNewsId);
      return {
        ...entity,
        duplicateOfNewsId: command.duplicateOfNewsId,
        state: "DUPLICATE",
      };

    case "ScoreNews":
      expectState(entity, command, "NORMALIZED");
      assertRelevanceScore(command.relevance);
      return {
        ...entity,
        relevance: command.relevance,
        state: "SCORED",
      };

    case "DiscardLowRelevance":
      expectState(entity, command, "SCORED");
      if (entity.relevance === null) {
        throw new RequiredFieldMissingError("relevance");
      }
      if (entity.relevance.value >= entity.relevance.threshold) {
        throw new InvalidTransitionError(entity.state, command.type);
      }
      return {
        ...entity,
        state: "DISCARDED_LOW_RELEVANCE",
      };

    case "RequestVerification":
      expectState(entity, command, "SCORED");
      if (entity.relevance === null) {
        throw new RequiredFieldMissingError("relevance");
      }
      if (entity.relevance.value < entity.relevance.threshold) {
        throw new LowRelevanceError(
          entity.relevance.value,
          entity.relevance.threshold,
        );
      }
      return {
        ...entity,
        state: "PENDING_VERIFICATION",
      };

    case "ApproveVerification":
      expectState(entity, command, "PENDING_VERIFICATION");
      if (command.verification.outcome !== "VERIFIED") {
        throw new RequiredFieldMissingError("verification.outcome");
      }
      return {
        ...entity,
        state: "VERIFIED",
        verification: command.verification,
      };

    case "RejectVerification":
      expectState(entity, command, "PENDING_VERIFICATION");
      if (command.verification.outcome !== "REJECTED") {
        throw new RequiredFieldMissingError("verification.outcome");
      }
      return {
        ...entity,
        state: "VERIFICATION_REJECTED",
        verification: command.verification,
      };

    case "CreateDraft": {
      expectOneOfStates(entity, command, ["VERIFIED", "CHANGES_REQUESTED"]);
      requireCommandText("draftVersionId", command.draftVersionId);
      requireCommandText("body", command.body);

      if (
        entity.draftVersions.some(
          (version) => version.id === command.draftVersionId,
        )
      ) {
        throw new DuplicateCommandError(command.draftVersionId);
      }

      const previousVersion = findCurrentDraftOrNull(entity);
      const draftVersion: DraftVersion = {
        id: command.draftVersionId,
        version: entity.draftVersions.length + 1,
        body: command.body,
        createdAt: context.occurredAt,
        createdBy: context.actor,
        basedOnVersionId: previousVersion?.id ?? null,
      };

      return {
        ...entity,
        currentDraftVersionId: draftVersion.id,
        draftVersions: [...entity.draftVersions, draftVersion],
        state: "DRAFT_CREATED",
      };
    }

    case "SubmitForApproval": {
      expectState(entity, command, "DRAFT_CREATED");
      const currentVersion = requireCurrentDraft(entity);

      if (command.contentVersionId !== currentVersion.id) {
        if (
          !entity.draftVersions.some(
            (version) => version.id === command.contentVersionId,
          )
        ) {
          throw new DraftVersionNotFoundError(command.contentVersionId);
        }
        throw new StaleApprovalVersionError(
          currentVersion.id,
          command.contentVersionId,
        );
      }

      requireCommandText("approvalRequestId", command.approvalRequestId);
      if (
        entity.approvalRequests.some(
          (request) => request.id === command.approvalRequestId,
        )
      ) {
        throw new DuplicateCommandError(command.approvalRequestId);
      }

      const request: ApprovalRequest = {
        id: command.approvalRequestId,
        contentVersionId: currentVersion.id,
        status: "PENDING",
        requestedAt: context.occurredAt,
        resolvedAt: null,
      };

      return {
        ...entity,
        approvalRequests: [...entity.approvalRequests, request],
        currentApprovalRequestId: request.id,
        state: "PENDING_APPROVAL",
      };
    }

    case "RequestChanges":
      return resolveApproval(
        entity,
        command,
        context,
        "CHANGES_REQUESTED",
        "CHANGES_REQUESTED",
      );

    case "ApproveDraft":
      return resolveApproval(
        entity,
        command,
        context,
        "APPROVED",
        "APPROVED",
      );

    case "RejectDraft":
      return resolveApproval(
        entity,
        command,
        context,
        "REJECTED",
        "REJECTED",
      );

    case "MarkReadyForPublication": {
      expectState(entity, command, "APPROVED");
      const currentVersion = requireCurrentDraft(entity);
      const request = requireCurrentApprovalRequest(entity);

      if (
        request.status !== "APPROVED" ||
        request.contentVersionId !== currentVersion.id
      ) {
        throw new StaleApprovalVersionError(
          currentVersion.id,
          request.contentVersionId,
        );
      }

      return {
        ...entity,
        state: "READY_FOR_PUBLICATION",
      };
    }
  }
}

function resolveApproval(
  entity: EditorialNews,
  command: Extract<
    EditorialCommand,
    { type: "RequestChanges" | "ApproveDraft" | "RejectDraft" }
  >,
  context: TransitionContext,
  targetState: "CHANGES_REQUESTED" | "APPROVED" | "REJECTED",
  requestStatus: "CHANGES_REQUESTED" | "APPROVED" | "REJECTED",
): EditorialNews {
  if (entity.state !== "PENDING_APPROVAL") {
    const existingRequest = entity.approvalRequests.find(
      (request) => request.id === command.approvalRequestId,
    );
    if (existingRequest !== undefined && existingRequest.status !== "PENDING") {
      throw new ApprovalAlreadyProcessedError(command.approvalRequestId);
    }
    throw new InvalidTransitionError(entity.state, command.type);
  }

  if (context.actor.type !== "HUMAN") {
    throw new InvalidActorError("HUMAN", context.actor.type);
  }

  const currentVersion = requireCurrentDraft(entity);
  if (command.contentVersionId !== currentVersion.id) {
    throw new StaleApprovalVersionError(
      currentVersion.id,
      command.contentVersionId,
    );
  }

  const request = findApprovalRequest(entity, command.approvalRequestId);
  if (
    entity.currentApprovalRequestId !== request.id ||
    request.contentVersionId !== currentVersion.id
  ) {
    throw new StaleApprovalVersionError(
      currentVersion.id,
      request.contentVersionId,
    );
  }
  if (request.status !== "PENDING") {
    throw new ApprovalAlreadyProcessedError(request.id);
  }

  const decision: HumanDecision = {
    id: command.decisionId,
    approvalRequestId: request.id,
    contentVersionId: currentVersion.id,
    type:
      command.type === "ApproveDraft"
        ? "APPROVE"
        : command.type === "RejectDraft"
          ? "REJECT"
          : "REQUEST_CHANGES",
    actor: context.actor,
    decidedAt: context.occurredAt,
    reason: command.reason ?? null,
    idempotencyKey: command.idempotencyKey,
  };

  return {
    ...entity,
    approvalRequests: entity.approvalRequests.map((item) =>
      item.id === request.id
        ? {
            ...item,
            resolvedAt: context.occurredAt,
            status: requestStatus,
          }
        : item,
    ),
    decisions: [...entity.decisions, decision],
    state: targetState,
  };
}

function createAuditEvent(
  previous: EditorialNews,
  next: EditorialNews,
  command: EditorialCommand,
  context: TransitionContext,
): AuditEvent {
  return {
    id: context.eventId,
    entityId: previous.id,
    previousState: previous.state,
    newState: next.state,
    action: command.type,
    actor: context.actor,
    occurredAt: context.occurredAt,
    reason: command.reason ?? null,
    contentVersionId: contentVersionIdFor(command, next),
    idempotencyKey: command.idempotencyKey ?? null,
  };
}

function contentVersionIdFor(
  command: EditorialCommand,
  entity: EditorialNews,
): string | null {
  switch (command.type) {
    case "CreateDraft":
      return command.draftVersionId;
    case "SubmitForApproval":
    case "RequestChanges":
    case "ApproveDraft":
    case "RejectDraft":
      return command.contentVersionId;
    case "MarkReadyForPublication":
      return entity.currentDraftVersionId;
    default:
      return null;
  }
}

function commandFingerprint(command: EditorialCommand): string {
  switch (command.type) {
    case "RequestChanges":
    case "RejectDraft":
      return [
        command.type,
        command.decisionId,
        command.approvalRequestId,
        command.contentVersionId,
        command.reason,
      ].join("|");
    case "ApproveDraft":
      return [
        command.type,
        command.decisionId,
        command.approvalRequestId,
        command.contentVersionId,
      ].join("|");
    default:
      return JSON.stringify(command);
  }
}

function expectState(
  entity: EditorialNews,
  command: EditorialCommand,
  expectedState: EditorialState,
): void {
  if (entity.state !== expectedState) {
    throw new InvalidTransitionError(entity.state, command.type);
  }
}

function expectOneOfStates(
  entity: EditorialNews,
  command: EditorialCommand,
  expectedStates: readonly EditorialState[],
): void {
  if (!expectedStates.includes(entity.state)) {
    throw new InvalidTransitionError(entity.state, command.type);
  }
}

function requireCurrentDraft(entity: EditorialNews): DraftVersion {
  const draft = findCurrentDraftOrNull(entity);
  if (draft === null) {
    throw new DraftVersionNotFoundError(
      entity.currentDraftVersionId ?? "current",
    );
  }
  return draft;
}

function findCurrentDraftOrNull(entity: EditorialNews): DraftVersion | null {
  if (entity.currentDraftVersionId === null) {
    return null;
  }
  return (
    entity.draftVersions.find(
      (version) => version.id === entity.currentDraftVersionId,
    ) ?? null
  );
}

function findApprovalRequest(
  entity: EditorialNews,
  approvalRequestId: string,
): ApprovalRequest {
  const request = entity.approvalRequests.find(
    (item) => item.id === approvalRequestId,
  );
  if (request === undefined) {
    throw new ApprovalRequestNotFoundError(approvalRequestId);
  }
  return request;
}

function requireCurrentApprovalRequest(
  entity: EditorialNews,
): ApprovalRequest {
  if (entity.currentApprovalRequestId === null) {
    throw new ApprovalRequestNotFoundError("current");
  }
  return findApprovalRequest(entity, entity.currentApprovalRequestId);
}

function assertRelevanceScore(score: RelevanceScore): void {
  if (!isValidRelevanceScore(score)) {
    throw new InvalidRelevanceScoreError();
  }
  requireCommandText("relevance.reason", score.reason);
  requireCommandText("relevance.policyVersion", score.policyVersion);
}

function isValidRelevanceScore(score: RelevanceScore): boolean {
  return (
    Number.isFinite(score.value) &&
    Number.isFinite(score.threshold) &&
    score.value >= 0 &&
    score.value <= 100 &&
    score.threshold >= 0 &&
    score.threshold <= 100
  );
}

function assertContext(context: TransitionContext): void {
  requireCommandText("context.eventId", context.eventId);
  requireCommandText("context.actor.id", context.actor.id);
  requireCommandText("context.occurredAt", context.occurredAt);
}

function assertValidEntity(entity: EditorialNews): void {
  const issue = validateEntity(entity)[0];
  if (issue !== undefined) {
    throw new RequiredFieldMissingError(issue.field);
  }
}

function validateDrafts(
  entity: EditorialNews,
  issues: ValidationIssue[],
): void {
  const draftIds = new Set<string>();

  entity.draftVersions.forEach((version, index) => {
    if (draftIds.has(version.id)) {
      issues.push({
        field: "draftVersions.id",
        message: `Duplicate draft version ID ${version.id}.`,
      });
    }
    draftIds.add(version.id);

    if (version.version !== index + 1) {
      issues.push({
        field: "draftVersions.version",
        message: "Draft versions must be sequential.",
      });
    }
    requireText(issues, "draftVersions.body", version.body);
  });

  if (statesRequiringDraft.has(entity.state)) {
    if (
      entity.currentDraftVersionId === null ||
      !draftIds.has(entity.currentDraftVersionId)
    ) {
      issues.push({
        field: "currentDraftVersionId",
        message: `State ${entity.state} requires a current draft version.`,
      });
    }
  }
}

function validateApprovalRequests(
  entity: EditorialNews,
  issues: ValidationIssue[],
): void {
  const draftIds = new Set(entity.draftVersions.map((version) => version.id));
  const approvalIds = new Set<string>();

  for (const request of entity.approvalRequests) {
    if (approvalIds.has(request.id)) {
      issues.push({
        field: "approvalRequests.id",
        message: `Duplicate approval request ID ${request.id}.`,
      });
    }
    approvalIds.add(request.id);

    if (!draftIds.has(request.contentVersionId)) {
      issues.push({
        field: "approvalRequests.contentVersionId",
        message: `Unknown draft version ${request.contentVersionId}.`,
      });
    }
  }

  for (const decision of entity.decisions) {
    if (decision.actor.type !== "HUMAN") {
      issues.push({
        field: "decisions.actor",
        message: "Editorial decisions require a HUMAN actor.",
      });
    }
    if (!approvalIds.has(decision.approvalRequestId)) {
      issues.push({
        field: "decisions.approvalRequestId",
        message: `Unknown approval request ${decision.approvalRequestId}.`,
      });
    }
    if (!draftIds.has(decision.contentVersionId)) {
      issues.push({
        field: "decisions.contentVersionId",
        message: `Unknown draft version ${decision.contentVersionId}.`,
      });
    }
  }

  if (statesRequiringApprovalRequest.has(entity.state)) {
    if (
      entity.currentApprovalRequestId === null ||
      !approvalIds.has(entity.currentApprovalRequestId)
    ) {
      issues.push({
        field: "currentApprovalRequestId",
        message: `State ${entity.state} requires an approval request.`,
      });
    }
  }

  const currentRequest =
    entity.currentApprovalRequestId === null
      ? undefined
      : entity.approvalRequests.find(
          (request) => request.id === entity.currentApprovalRequestId,
        );
  const expectedStatusByState: Partial<
    Record<EditorialState, ApprovalRequest["status"]>
  > = {
    APPROVED: "APPROVED",
    CHANGES_REQUESTED: "CHANGES_REQUESTED",
    PENDING_APPROVAL: "PENDING",
    READY_FOR_PUBLICATION: "APPROVED",
    REJECTED: "REJECTED",
  };
  const expectedStatus = expectedStatusByState[entity.state];
  if (
    expectedStatus !== undefined &&
    currentRequest !== undefined &&
    currentRequest.status !== expectedStatus
  ) {
    issues.push({
      field: "approvalRequests.status",
      message: `State ${entity.state} requires approval status ${expectedStatus}.`,
    });
  }
}

function validateReadyForPublication(
  entity: EditorialNews,
  issues: ValidationIssue[],
): void {
  if (entity.state !== "READY_FOR_PUBLICATION") {
    return;
  }

  const request =
    entity.currentApprovalRequestId === null
      ? undefined
      : entity.approvalRequests.find(
          (item) => item.id === entity.currentApprovalRequestId,
        );

  if (
    request?.status !== "APPROVED" ||
    request.contentVersionId !== entity.currentDraftVersionId
  ) {
    issues.push({
      field: "approvalRequests",
      message: "Ready content requires approval of the current version.",
    });
  }

  const hasDecision = entity.decisions.some(
    (decision) =>
      decision.type === "APPROVE" &&
      decision.contentVersionId === entity.currentDraftVersionId,
  );
  if (!hasDecision) {
    issues.push({
      field: "decisions",
      message: "Ready content requires a matching human approval decision.",
    });
  }
}

function validateProcessedCommands(
  entity: EditorialNews,
  issues: ValidationIssue[],
): void {
  const keys = new Set<string>();
  for (const command of entity.processedCommands) {
    if (keys.has(command.idempotencyKey)) {
      issues.push({
        field: "processedCommands.idempotencyKey",
        message: `Duplicate idempotency key ${command.idempotencyKey}.`,
      });
    }
    keys.add(command.idempotencyKey);
    requireText(issues, "processedCommands.fingerprint", command.fingerprint);
  }
}

function requireText(
  issues: ValidationIssue[],
  field: string,
  value: string,
): void {
  if (value.trim().length === 0) {
    issues.push({ field, message: `${field} is required.` });
  }
}

function requireCommandText(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new RequiredFieldMissingError(field);
  }
}
