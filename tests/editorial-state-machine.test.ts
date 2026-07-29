import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ALLOWED_TRANSITIONS,
  APPROVED_SCENARIO,
  ApprovalAlreadyProcessedError,
  ApprovalRequestNotFoundError,
  CHANGES_REQUESTED_SCENARIO,
  DRAFT_REJECTED_SCENARIO,
  DOMAIN_ERROR_CODES,
  DUPLICATE_SCENARIO,
  DomainError,
  DraftVersionNotFoundError,
  DuplicateCommandError,
  EDITORIAL_SCENARIOS,
  EDITORIAL_STATES,
  EntityNotFoundError,
  IDEMPOTENCY_SCENARIO,
  HIGH_RELEVANCE,
  INVALID_TRANSITION_SCENARIO,
  InMemoryEditorialNewsRepository,
  InvalidRelevanceScoreError,
  InvalidActorError,
  InvalidTransitionError,
  LOW_RELEVANCE_SCENARIO,
  LOW_RELEVANCE,
  LowRelevanceError,
  RequiredFieldMissingError,
  StaleApprovalVersionError,
  TERMINAL_STATES,
  VERIFICATION_REJECTED_SCENARIO,
  canTransition,
  transition,
  validateEntity,
} from "../packages/content-engine/src/index.ts";
import type {
  EditorialCommand,
  EditorialNews,
  TransitionContext,
  TransitionResult,
} from "../packages/content-engine/src/index.ts";

interface ScenarioRun {
  readonly entity: EditorialNews;
  readonly results: readonly TransitionResult[];
}

function runSteps(
  initialNews: EditorialNews,
  steps: readonly {
    readonly command: EditorialCommand;
    readonly context: TransitionContext;
  }[],
): ScenarioRun {
  let entity = initialNews;
  const results: TransitionResult[] = [];

  for (const step of steps) {
    const result = transition(entity, step.command, step.context);
    entity = result.entity;
    results.push(result);
  }

  return { entity, results };
}

function runScenario(
  scenario: (typeof EDITORIAL_SCENARIOS)[keyof typeof EDITORIAL_SCENARIOS],
): ScenarioRun {
  return runSteps(scenario.initialNews, scenario.steps);
}

function expectDomainError(
  operation: () => unknown,
  expectedCode: DomainError["code"],
  expectedClass?: new (...args: never[]) => DomainError,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, expectedCode);
    if (expectedClass !== undefined) {
      assert.ok(error instanceof expectedClass);
    }
    return true;
  });
}

describe("editorial state machine", () => {
  test("declares every valid state transition explicitly", () => {
    const expected = {
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
      READY_FOR_PUBLICATION: ["PUBLISHED"],
      PUBLISHED: [],
    };

    assert.deepEqual(ALLOWED_TRANSITIONS, expected);
    for (const source of EDITORIAL_STATES) {
      for (const target of EDITORIAL_STATES) {
        assert.equal(
          canTransition(source, target),
          expected[source].includes(target as never),
        );
      }
    }
  });

  test("completes the approved flow and records one event per transition", () => {
    const { entity, results } = runScenario(APPROVED_SCENARIO);

    assert.equal(entity.state, "READY_FOR_PUBLICATION");
    assert.equal(entity.draftVersions.length, 1);
    assert.equal(entity.decisions.length, 1);
    assert.equal(entity.auditEvents.length, APPROVED_SCENARIO.steps.length);
    assert.equal(results.every((result) => result.event !== null), true);
    assert.equal(entity.currentDraftVersionId, "draft-approved-v1");
  });

  test("stops a duplicate and prevents draft generation", () => {
    const { entity } = runScenario(DUPLICATE_SCENARIO);
    assert.equal(entity.state, "DUPLICATE");
    assert.equal(entity.duplicateOfNewsId, "news-canonical-fixture");

    expectDomainError(
      () =>
        transition(
          entity,
          {
            type: "CreateDraft",
            draftVersionId: "draft-forbidden",
            body: "Conteúdo fictício.",
          },
          {
            eventId: "event-forbidden-duplicate",
            actor: { id: "actor-llm-fixture", type: "LLM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_TRANSITION",
      InvalidTransitionError,
    );
  });

  test("discards low-relevance news in a terminal state", () => {
    const { entity } = runScenario(LOW_RELEVANCE_SCENARIO);
    assert.equal(entity.state, "DISCARDED_LOW_RELEVANCE");
    assert.equal(entity.relevance?.value, LOW_RELEVANCE.value);
  });

  test("prevents low-relevance news from requesting verification", () => {
    const beforeDiscard = runSteps(
      LOW_RELEVANCE_SCENARIO.initialNews,
      LOW_RELEVANCE_SCENARIO.steps.slice(0, 2),
    ).entity;

    expectDomainError(
      () =>
        transition(
          beforeDiscard,
          { type: "RequestVerification" },
          {
            eventId: "event-low-relevance-invalid",
            actor: { id: "actor-n8n-fixture", type: "N8N" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "LOW_RELEVANCE",
      LowRelevanceError,
    );
  });

  test("stops news when verification is rejected", () => {
    const { entity } = runScenario(VERIFICATION_REJECTED_SCENARIO);
    assert.equal(entity.state, "VERIFICATION_REJECTED");
    assert.equal(entity.verification?.outcome, "REJECTED");
  });

  test("prevents rejected verification from generating a draft", () => {
    const { entity } = runScenario(VERIFICATION_REJECTED_SCENARIO);
    expectDomainError(
      () =>
        transition(
          entity,
          {
            type: "CreateDraft",
            draftVersionId: "draft-after-rejection",
            body: "Conteúdo proibido.",
          },
          {
            eventId: "event-draft-after-rejection",
            actor: { id: "actor-llm-fixture", type: "LLM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_TRANSITION",
      InvalidTransitionError,
    );
  });

  test("prevents rejected verification from being approved", () => {
    const { entity } = runScenario(VERIFICATION_REJECTED_SCENARIO);
    expectDomainError(
      () =>
        transition(
          entity,
          {
            type: "ApproveDraft",
            decisionId: "decision-after-verification-rejection",
            approvalRequestId: "approval-after-verification-rejection",
            contentVersionId: "draft-after-verification-rejection",
            idempotencyKey: "idempotency-after-verification-rejection",
          },
          {
            eventId: "event-approval-after-verification-rejection",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_TRANSITION",
      InvalidTransitionError,
    );
  });

  test("records a human draft rejection as terminal", () => {
    const { entity } = runScenario(DRAFT_REJECTED_SCENARIO);
    assert.equal(entity.state, "REJECTED");
    assert.equal(entity.decisions.at(-1)?.type, "REJECT");
    assert.equal(entity.approvalRequests.at(-1)?.status, "REJECTED");
  });

  test("preserves versions and requires a new approval after changes", () => {
    const beforeSecondApproval = runSteps(
      CHANGES_REQUESTED_SCENARIO.initialNews,
      CHANGES_REQUESTED_SCENARIO.steps.slice(0, 9),
    ).entity;

    assert.equal(beforeSecondApproval.state, "PENDING_APPROVAL");
    assert.equal(beforeSecondApproval.draftVersions.length, 2);
    assert.equal(
      beforeSecondApproval.draftVersions[1]?.basedOnVersionId,
      "draft-changes-requested-v1",
    );
    assert.equal(
      beforeSecondApproval.approvalRequests[0]?.status,
      "CHANGES_REQUESTED",
    );
    assert.equal(
      beforeSecondApproval.approvalRequests[1]?.status,
      "PENDING",
    );
    assert.equal(beforeSecondApproval.decisions.length, 1);

    const complete = runScenario(CHANGES_REQUESTED_SCENARIO).entity;
    assert.equal(complete.state, "READY_FOR_PUBLICATION");
    assert.equal(complete.decisions.length, 2);
    assert.equal(complete.currentDraftVersionId, "draft-changes-requested-v2");
  });

  test("rejects an approval for an outdated draft version", () => {
    const current = runSteps(
      CHANGES_REQUESTED_SCENARIO.initialNews,
      CHANGES_REQUESTED_SCENARIO.steps.slice(0, 9),
    ).entity;

    expectDomainError(
      () =>
        transition(
          current,
          {
            type: "ApproveDraft",
            decisionId: "decision-stale",
            approvalRequestId: "approval-changes-requested-v1",
            contentVersionId: "draft-changes-requested-v1",
            idempotencyKey: "idempotency-stale",
          },
          {
            eventId: "event-stale",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "STALE_APPROVAL_VERSION",
      StaleApprovalVersionError,
    );
  });

  test("fails controlled approval before verification", () => {
    expectDomainError(
      () => runScenario(INVALID_TRANSITION_SCENARIO),
      "INVALID_TRANSITION",
      InvalidTransitionError,
    );
  });

  test("does not allow ready state before approval", () => {
    const pending = runSteps(
      APPROVED_SCENARIO.initialNews,
      APPROVED_SCENARIO.steps.slice(0, 6),
    ).entity;

    expectDomainError(
      () =>
        transition(
          pending,
          { type: "MarkReadyForPublication" },
          {
            eventId: "event-ready-without-approval",
            actor: { id: "actor-system-fixture", type: "SYSTEM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_TRANSITION",
      InvalidTransitionError,
    );
  });

  test("treats a replayed approval as an idempotent no-op", () => {
    const { entity, results } = runScenario(IDEMPOTENCY_SCENARIO);
    const replay = results.at(-1);

    assert.equal(entity.state, "APPROVED");
    assert.equal(entity.decisions.length, 1);
    assert.equal(entity.auditEvents.length, IDEMPOTENCY_SCENARIO.steps.length - 1);
    assert.equal(replay?.replayed, true);
    assert.equal(replay?.event, null);
  });

  test("rejects reuse of an idempotency key for another command", () => {
    const approved = runSteps(
      IDEMPOTENCY_SCENARIO.initialNews,
      IDEMPOTENCY_SCENARIO.steps.slice(0, 7),
    ).entity;

    expectDomainError(
      () =>
        transition(
          approved,
          {
            type: "RejectDraft",
            decisionId: "decision-key-reuse",
            approvalRequestId: "approval-idempotency-v1",
            contentVersionId: "draft-idempotency-v1",
            idempotencyKey: "idempotency-replayed-approval",
            reason: "Reuso inválido.",
          },
          {
            eventId: "event-key-reuse",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "DUPLICATE_COMMAND",
      DuplicateCommandError,
    );
  });

  test("rejects reuse of an idempotency key for a different approval payload", () => {
    const approved = runSteps(
      IDEMPOTENCY_SCENARIO.initialNews,
      IDEMPOTENCY_SCENARIO.steps.slice(0, 7),
    ).entity;

    expectDomainError(
      () =>
        transition(
          approved,
          {
            type: "ApproveDraft",
            decisionId: "decision-different-payload",
            approvalRequestId: "approval-idempotency-v1",
            contentVersionId: "draft-idempotency-v1",
            idempotencyKey: "idempotency-replayed-approval",
          },
          {
            eventId: "event-different-payload",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "DUPLICATE_COMMAND",
      DuplicateCommandError,
    );
  });

  test("requires a human actor for editorial decisions", () => {
    const pending = runSteps(
      APPROVED_SCENARIO.initialNews,
      APPROVED_SCENARIO.steps.slice(0, 6),
    ).entity;

    expectDomainError(
      () =>
        transition(
          pending,
          {
            type: "ApproveDraft",
            decisionId: "decision-invalid-actor",
            approvalRequestId: "approval-approved-v1",
            contentVersionId: "draft-approved-v1",
            idempotencyKey: "idempotency-invalid-actor",
          },
          {
            eventId: "event-invalid-actor",
            actor: { id: "actor-llm-fixture", type: "LLM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_ACTOR",
      InvalidActorError,
    );
  });

  test("reports an already processed approval with a new key", () => {
    const approved = runSteps(
      APPROVED_SCENARIO.initialNews,
      APPROVED_SCENARIO.steps.slice(0, 7),
    ).entity;

    expectDomainError(
      () =>
        transition(
          approved,
          {
            type: "ApproveDraft",
            decisionId: "decision-second",
            approvalRequestId: "approval-approved-v1",
            contentVersionId: "draft-approved-v1",
            idempotencyKey: "idempotency-approved-second",
          },
          {
            eventId: "event-approved-second",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "APPROVAL_ALREADY_PROCESSED",
      ApprovalAlreadyProcessedError,
    );
  });

  test("creates deterministic audit events with required fields", () => {
    const firstStep = APPROVED_SCENARIO.steps[0];
    assert.ok(firstStep);
    const result = transition(
      APPROVED_SCENARIO.initialNews,
      firstStep.command,
      firstStep.context,
    );

    assert.deepEqual(result.event, {
      id: "event-approved-01",
      entityId: "news-approved",
      previousState: "RECEIVED",
      newState: "NORMALIZED",
      action: "NormalizeNews",
      actor: { id: "actor-system-fixture", type: "SYSTEM" },
      occurredAt: "2026-01-15T10:01:00.000Z",
      reason: null,
      contentVersionId: null,
      idempotencyKey: null,
    });
  });

  test("rejects a repeated audit event identifier", () => {
    const firstStep = APPROVED_SCENARIO.steps[0];
    const secondStep = APPROVED_SCENARIO.steps[1];
    assert.ok(firstStep);
    assert.ok(secondStep);

    const normalized = transition(
      APPROVED_SCENARIO.initialNews,
      firstStep.command,
      firstStep.context,
    ).entity;

    expectDomainError(
      () =>
        transition(normalized, secondStep.command, {
          ...secondStep.context,
          eventId: firstStep.context.eventId,
        }),
      "DUPLICATE_COMMAND",
      DuplicateCommandError,
    );
  });

  test("produces identical results for identical inputs", () => {
    const first = runScenario(APPROVED_SCENARIO).entity;
    const second = runScenario(APPROVED_SCENARIO).entity;
    assert.deepEqual(first, second);
  });

  test("validates required entity fields", () => {
    const invalid = {
      ...APPROVED_SCENARIO.initialNews,
      title: "",
    };
    assert.deepEqual(validateEntity(invalid), [
      { field: "title", message: "title is required." },
    ]);

    const step = APPROVED_SCENARIO.steps[0];
    assert.ok(step);
    expectDomainError(
      () => transition(invalid, step.command, step.context),
      "REQUIRED_FIELD_MISSING",
      RequiredFieldMissingError,
    );
  });

  test("rejects relevance scores outside 0 to 100", () => {
    const normalized = runSteps(
      LOW_RELEVANCE_SCENARIO.initialNews,
      LOW_RELEVANCE_SCENARIO.steps.slice(0, 1),
    ).entity;

    expectDomainError(
      () =>
        transition(
          normalized,
          {
            type: "ScoreNews",
            relevance: {
              ...HIGH_RELEVANCE,
              value: 101,
            },
          },
          {
            eventId: "event-invalid-score",
            actor: { id: "actor-system-fixture", type: "SYSTEM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "INVALID_RELEVANCE_SCORE",
      InvalidRelevanceScoreError,
    );
  });

  test("reports a missing draft version during approval submission", () => {
    const draftCreated = runSteps(
      APPROVED_SCENARIO.initialNews,
      APPROVED_SCENARIO.steps.slice(0, 5),
    ).entity;

    expectDomainError(
      () =>
        transition(
          draftCreated,
          {
            type: "SubmitForApproval",
            approvalRequestId: "approval-missing-version",
            contentVersionId: "draft-does-not-exist",
          },
          {
            eventId: "event-missing-version",
            actor: { id: "actor-telegram-fixture", type: "TELEGRAM" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "DRAFT_VERSION_NOT_FOUND",
      DraftVersionNotFoundError,
    );
  });

  test("reports a missing approval request", () => {
    const pending = runSteps(
      APPROVED_SCENARIO.initialNews,
      APPROVED_SCENARIO.steps.slice(0, 6),
    ).entity;

    expectDomainError(
      () =>
        transition(
          pending,
          {
            type: "ApproveDraft",
            decisionId: "decision-missing-request",
            approvalRequestId: "approval-does-not-exist",
            contentVersionId: "draft-approved-v1",
            idempotencyKey: "idempotency-missing-request",
          },
          {
            eventId: "event-missing-request",
            actor: { id: "actor-human-fixture", type: "HUMAN" },
            occurredAt: "2026-01-15T11:00:00.000Z",
          },
        ),
      "APPROVAL_REQUEST_NOT_FOUND",
      ApprovalRequestNotFoundError,
    );
  });

  test("treats all declared terminal states as transitionless", () => {
    for (const terminal of TERMINAL_STATES) {
      assert.deepEqual(ALLOWED_TRANSITIONS[terminal], []);
      for (const target of EDITORIAL_STATES) {
        assert.equal(canTransition(terminal, target), false);
      }
    }
  });

  test("stores and recovers isolated snapshots in memory", async () => {
    const repository = new InMemoryEditorialNewsRepository();
    const completed = runScenario(APPROVED_SCENARIO).entity;
    await repository.save(completed, 0);

    const recovered = await repository.getById(completed.id);
    assert.deepEqual(recovered, completed);
    assert.notEqual(recovered, completed);
    assert.deepEqual(
      await repository.listAuditEvents(completed.id),
      completed.auditEvents,
    );
  });

  test("reports a stable error when an in-memory entity is missing", async () => {
    const repository = new InMemoryEditorialNewsRepository();
    await assert.rejects(
      repository.getById("news-missing"),
      (error: unknown) =>
        error instanceof EntityNotFoundError &&
        error.code === "ENTITY_NOT_FOUND",
    );
  });

  test("keeps domain error codes stable and unique", () => {
    assert.equal(new Set(DOMAIN_ERROR_CODES).size, DOMAIN_ERROR_CODES.length);
    assert.deepEqual(DOMAIN_ERROR_CODES, [
      "INVALID_TRANSITION",
      "ENTITY_NOT_FOUND",
      "DRAFT_VERSION_NOT_FOUND",
      "APPROVAL_REQUEST_NOT_FOUND",
      "APPROVAL_ALREADY_PROCESSED",
      "DUPLICATE_COMMAND",
      "REQUIRED_FIELD_MISSING",
      "STALE_APPROVAL_VERSION",
      "INVALID_RELEVANCE_SCORE",
      "LOW_RELEVANCE",
      "INVALID_ACTOR",
      "CONCURRENT_UPDATE",
      "INVALID_RELEVANCE_INPUT",
      "INVALID_RELEVANCE_POLICY",
      "INVALID_DATE_RANGE",
      "UNSUPPORTED_SOURCE_TYPE",
      "UNSUPPORTED_NOVELTY_TYPE",
    ]);
  });
});
