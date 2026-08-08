import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EDITORIAL_ORCHESTRATION_POLICY_V1,
  EditorialOrchestrationError,
  EditorialOrchestrationService,
  FixtureEditorialOrchestrationPipeline,
  InMemoryEditorialOrchestrationRepository,
  InMemoryHumanDecisionChannel,
  InMemoryHumanEditorialDecisionExecutor,
  TelegramHumanDecisionChannel,
  formatHumanDecisionMessage,
  type EditorialOrchestrationPipeline,
  type HumanDecisionRequest,
} from "../packages/application/src/index.ts";

const at = "2026-07-29T11:00:00.000Z";

describe("controlled editorial orchestration", () => {
  test("creates a deterministic run and stops for human decision", async () => {
    const fixture = createFixture();
    const result = await fixture.service.startScheduledRun(trigger("create"));
    assert.equal(result.replayed, false);
    assert.equal(result.run.status, "WAITING_HUMAN_DECISION");
    assert.equal(result.run.steps.length, 8);
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 1);
  });

  test("replays the same trigger key without duplicating a run", async () => {
    const fixture = createFixture();
    const first = await fixture.service.startScheduledRun(trigger("replay"));
    const second = await fixture.service.startScheduledRun(trigger("replay"));
    assert.equal(second.replayed, true);
    assert.equal(second.run.id, first.run.id);
    assert.equal((await fixture.service.listRuns()).length, 1);
    assert.equal(fixture.channel.deliveries.length, 1);
  });

  test("rejects incompatible reuse of a trigger key", async () => {
    const fixture = createFixture();
    await fixture.service.startScheduledRun(trigger("conflict"));
    await assert.rejects(
      fixture.service.startScheduledRun({
        ...trigger("conflict"),
        triggerType: "N8N_RETRY",
      }),
      code("EDITORIAL_ORCHESTRATION_IDEMPOTENCY_CONFLICT"),
    );
  });

  test("executes the five domain delegation steps in order", async () => {
    const pipeline = new FixtureEditorialOrchestrationPipeline();
    const fixture = createFixture({ pipeline });
    await fixture.service.startScheduledRun(trigger("sequence"));
    assert.deepEqual(pipeline.calls, [
      "RADAR_INGESTION",
      "RELEVANCE_EVALUATION",
      "EVIDENCE_ACQUISITION",
      "FACTUAL_VERIFICATION",
      "DRAFT_GENERATION",
    ]);
  });

  test("records a technical step failure and fails the run", async () => {
    const fixture = createFixture({
      pipeline: new FixtureEditorialOrchestrationPipeline({
        failure: {
          step: "EVIDENCE_ACQUISITION",
          code: "ORCHESTRATION_HTTP_TIMEOUT",
        },
      }),
    });
    await assert.rejects(
      fixture.service.startScheduledRun(trigger("step-failure")),
      code("ORCHESTRATION_HTTP_TIMEOUT"),
    );
    assert.equal(
      (await fixture.service.listRuns())[0]?.status,
      "FAILED",
    );
  });

  test("does not retry a permanent domain failure", async () => {
    const fixture = createFixture({
      pipeline: new FixtureEditorialOrchestrationPipeline({
        failure: {
          step: "FACTUAL_VERIFICATION",
          code: "FACTUAL_VERIFICATION_INSUFFICIENT_EVIDENCE",
        },
      }),
    });
    const runId = await failedRunId(fixture, "permanent-failure");
    await assert.rejects(
      fixture.service.retryFailedStep({
        runId,
        stepType: "FACTUAL_VERIFICATION",
      }),
      code("EDITORIAL_ORCHESTRATION_RETRY_NOT_ALLOWED"),
    );
  });

  test("allows only bounded retries for a transient failure", async () => {
    const fixture = createFixture({
      pipeline: new FixtureEditorialOrchestrationPipeline({
        failure: {
          step: "EVIDENCE_ACQUISITION",
          code: "ORCHESTRATION_HTTP_TIMEOUT",
        },
      }),
    });
    const runId = await failedRunId(fixture, "transient-failure");
    await assert.rejects(
      fixture.service.retryFailedStep({
        runId,
        stepType: "EVIDENCE_ACQUISITION",
      }),
      code("ORCHESTRATION_HTTP_TIMEOUT"),
    );
    const run = await fixture.service.getRun(runId);
    assert.equal(
      run.steps.find((step) => step.stepType === "EVIDENCE_ACQUISITION")
        ?.attemptCount,
      2,
    );
  });

  test("an empty eligible set creates no draft or decision", async () => {
    const fixture = createFixture({
      pipeline: new FixtureEditorialOrchestrationPipeline({ empty: true }),
    });
    const result = await fixture.service.startScheduledRun(trigger("empty"));
    assert.equal(result.run.status, "COMPLETED_WITH_WARNINGS");
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
  });

  test("insufficient evidence never becomes a draft", async () => {
    class InsufficientPipeline extends FixtureEditorialOrchestrationPipeline {
      override async verifyFacts(input: Parameters<
        FixtureEditorialOrchestrationPipeline["verifyFacts"]
      >[0]) {
        this.calls.push("FACTUAL_VERIFICATION");
        return input.items.map((item) => ({
          ...item,
          verificationId: `verification-${item.newsId}`,
          status: "INSUFFICIENT_EVIDENCE" as const,
          confidence: 0,
        }));
      }
    }
    const fixture = createFixture({ pipeline: new InsufficientPipeline() });
    const result = await fixture.service.startScheduledRun(trigger("insufficient"));
    assert.equal(result.run.status, "COMPLETED_WITH_WARNINGS");
    assert.equal(fixture.executor.executed.length, 0);
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
  });

  test("respects the policy item and draft limits", async () => {
    assert.equal(EDITORIAL_ORCHESTRATION_POLICY_V1.maximumIngestedItems, 15);
    assert.equal(EDITORIAL_ORCHESTRATION_POLICY_V1.maximumEvidenceItems, 5);
    assert.equal(EDITORIAL_ORCHESTRATION_POLICY_V1.maximumDrafts, 3);
    assert.equal(
      EDITORIAL_ORCHESTRATION_POLICY_V1.maximumPendingHumanDecisions,
      3,
    );
  });

  test("requires explicit human approval in the versioned policy", () => {
    assert.equal(
      EDITORIAL_ORCHESTRATION_POLICY_V1.version,
      "andre-studio-editorial-orchestration-v1",
    );
    assert.equal(EDITORIAL_ORCHESTRATION_POLICY_V1.humanApprovalRequired, true);
    assert.equal(
      EDITORIAL_ORCHESTRATION_POLICY_V1.automaticAiDecisionEnabled,
      false,
    );
    assert.equal(
      EDITORIAL_ORCHESTRATION_POLICY_V1.automaticPublicationEnabled,
      false,
    );
  });

  test("approves the exact associated draft and resumes to completion", async () => {
    const fixture = createFixture();
    const started = await fixture.service.startScheduledRun(trigger("approve"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    const result = await fixture.service.registerHumanDecision({
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "APPROVE",
      receivedAt: at,
      idempotencyKey: "approve-once",
    });
    assert.equal(result.decision.decision, "APPROVE");
    const completed = await fixture.service.resumeRun(started.run.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(fixture.executor.executed[0]?.requestId, request.id);
  });

  test("rejection requires a reason and completes with warnings", async () => {
    const fixture = createFixture();
    const started = await fixture.service.startScheduledRun(trigger("reject"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await assert.rejects(
      fixture.service.registerHumanDecision({
        requestId: request.id,
        reviewerId: "andre-local",
        decision: "REJECT",
        receivedAt: at,
        idempotencyKey: "reject-no-reason",
      }),
      code("EDITORIAL_ORCHESTRATION_DECISION_REASON_REQUIRED"),
    );
    await fixture.service.registerHumanDecision({
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "REJECT",
      reason: "Ângulo editorial inadequado.",
      receivedAt: at,
      idempotencyKey: "reject-with-reason",
    });
    assert.equal(
      (await fixture.service.resumeRun(started.run.id)).status,
      "COMPLETED_WITH_WARNINGS",
    );
  });

  test("change request requires controlled instructions", async () => {
    const fixture = createFixture();
    const started = await fixture.service.startScheduledRun(trigger("changes"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await assert.rejects(
      fixture.service.registerHumanDecision({
        requestId: request.id,
        reviewerId: "andre-local",
        decision: "REQUEST_CHANGES",
        receivedAt: at,
        idempotencyKey: "changes-empty",
      }),
      code("EDITORIAL_ORCHESTRATION_CHANGE_INSTRUCTIONS_REQUIRED"),
    );
    await fixture.service.registerHumanDecision({
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "REQUEST_CHANGES",
      changeInstructions: ["Reduzir o resumo sem adicionar fatos."],
      receivedAt: at,
      idempotencyKey: "changes-valid",
    });
    assert.equal(
      (await fixture.service.resumeRun(started.run.id)).status,
      "COMPLETED_WITH_WARNINGS",
    );
  });

  test("identical human decision is replayed", async () => {
    const fixture = createFixture();
    await fixture.service.startScheduledRun(trigger("decision-replay"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    const input = {
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "APPROVE" as const,
      receivedAt: at,
      idempotencyKey: "decision-replay-key",
    };
    assert.equal((await fixture.service.registerHumanDecision(input)).replayed, false);
    assert.equal((await fixture.service.registerHumanDecision(input)).replayed, true);
    assert.equal(fixture.executor.executed.length, 1);
  });

  test("a different second decision is rejected before domain execution", async () => {
    const fixture = createFixture();
    await fixture.service.startScheduledRun(trigger("decision-conflict"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await fixture.service.registerHumanDecision({
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "APPROVE",
      receivedAt: at,
      idempotencyKey: "decision-first",
    });
    await assert.rejects(
      fixture.service.registerHumanDecision({
        requestId: request.id,
        reviewerId: "andre-local",
        decision: "REJECT",
        reason: "Rejeição conflitante.",
        receivedAt: at,
        idempotencyKey: "decision-second",
      }),
      code("EDITORIAL_ORCHESTRATION_DECISION_CONFLICT"),
    );
    assert.equal(fixture.executor.executed.length, 1);
  });

  test("expired requests never approve automatically", async () => {
    let now = at;
    const fixture = createFixture({
      clock: () => now,
    });
    await fixture.service.startScheduledRun(trigger("expired"));
    now = "2026-07-31T12:00:00.000Z";
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
    assert.equal(fixture.executor.executed.length, 0);
  });

  test("details returns context without a transition", async () => {
    const fixture = createFixture();
    await fixture.service.startScheduledRun(trigger("details"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    const result = await fixture.service.registerExternalDecision({
      callbackData: `details:${request.id}`,
      chatId: "local",
      receivedAt: at,
    });
    assert.equal(result.kind, "DETAILS");
    assert.equal(fixture.executor.executed.length, 0);
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 1);
  });

  test("cancel is explicit, terminal and cancels pending requests", async () => {
    const fixture = createFixture();
    const run = await fixture.service.startScheduledRun(trigger("cancel"));
    const cancelled = await fixture.service.cancelRun({
      runId: run.run.id,
      operator: "andre-local",
      reason: "Execução interrompida manualmente.",
    });
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal((await fixture.service.getPendingHumanDecisions()).length, 0);
  });

  test("resume without a decision remains waiting", async () => {
    const fixture = createFixture();
    const run = await fixture.service.startScheduledRun(trigger("resume-wait"));
    assert.equal((await fixture.service.resumeRun(run.run.id)).status, "WAITING_HUMAN_DECISION");
  });

  test("retries a transient channel failure without duplicating the request", async () => {
    class FlakyChannel extends InMemoryHumanDecisionChannel {
      sends = 0;
      override async sendDecisionRequest(request: HumanDecisionRequest) {
        this.sends += 1;
        if (this.sends === 1) {
          throw new EditorialOrchestrationError(
            "ORCHESTRATION_TELEGRAM_UNAVAILABLE",
            "Temporary channel failure.",
            true,
          );
        }
        return super.sendDecisionRequest(request);
      }
    }
    const repository = new InMemoryEditorialOrchestrationRepository();
    const channel = new FlakyChannel(() => at);
    const service = new EditorialOrchestrationService({
      repository,
      pipeline: new FixtureEditorialOrchestrationPipeline(),
      channel,
      decisionExecutor: new InMemoryHumanEditorialDecisionExecutor(),
      clock: () => at,
    });
    await assert.rejects(
      service.startScheduledRun(trigger("channel-retry")),
      code("ORCHESTRATION_TELEGRAM_UNAVAILABLE"),
    );
    const run = (await service.listRuns())[0]!;
    const retried = await service.retryFailedStep({
      runId: run.id,
      stepType: "HUMAN_REVIEW_NOTIFICATION",
    });
    assert.equal(retried.status, "WAITING_HUMAN_DECISION");
    assert.equal(channel.sends, 2);
    assert.equal((await service.getPendingHumanDecisions()).length, 1);
  });

  test("rejects a decision context for another draft", async () => {
    class DivergentPipeline extends FixtureEditorialOrchestrationPipeline {
      override async getDecisionMessage(draft: Parameters<
        FixtureEditorialOrchestrationPipeline["getDecisionMessage"]
      >[0]) {
        return {
          ...(await super.getDecisionMessage(draft)),
          draftId: "different-draft",
        };
      }
    }
    const fixture = createFixture({ pipeline: new DivergentPipeline() });
    await assert.rejects(
      fixture.service.startScheduledRun(trigger("draft-mismatch")),
      code("EDITORIAL_ORCHESTRATION_DRAFT_CONTEXT_MISMATCH"),
    );
    assert.equal(fixture.executor.executed.length, 0);
  });

  test("publication preparation remains skipped after approval", async () => {
    const fixture = createFixture();
    const run = await fixture.service.startScheduledRun(trigger("no-publish"));
    const request = (await fixture.service.getPendingHumanDecisions())[0]!;
    await fixture.service.registerHumanDecision({
      requestId: request.id,
      reviewerId: "andre-local",
      decision: "APPROVE",
      receivedAt: at,
      idempotencyKey: "no-publish-approval",
    });
    const completed = await fixture.service.resumeRun(run.run.id);
    const publicationStep = completed.steps.find((step) =>
      step.stepType === "PUBLICATION_PACKAGE_PREPARATION"
    );
    assert.equal(publicationStep?.status, "SKIPPED");
    assert.equal(publicationStep?.outputReference?.automaticPublication, false);
  });

  test("injected clock makes independent runs deterministic", async () => {
    const left = createFixture();
    const right = createFixture();
    const leftRun = await left.service.startScheduledRun(trigger("deterministic"));
    const rightRun = await right.service.startScheduledRun(trigger("deterministic"));
    assert.deepEqual(leftRun.run, rightRun.run);
  });

  test("human message is bounded and excludes internal paths", () => {
    const message = formatHumanDecisionMessage({
      sourceName: "Google Developers Blog",
      officialLink: "https://developers.googleblog.com/example",
      title: "Grounding with Parallel foi anunciado oficialmente.",
      verificationStatus: "CONFIRMED",
      confidence: 0.96,
      summary: "Resumo factual.",
      allowedClaims: ["Google announced Grounding with Parallel."],
      limitations: ["Sem afirmação de disponibilidade geral."],
      draftId: "draft-safe",
      draftVersion: 1,
      newsVersion: 2,
    });
    assert.match(message, /Nova notícia pronta para revisão/);
    assert.match(message, /https:\/\/developers\.googleblog\.com\/example/);
    assert.doesNotMatch(message, /\/Users\/|token|password/i);
    assert.ok(message.length < 4_000);
  });
});

describe("Telegram human decision boundary", () => {
  test("signs and validates an approved callback", () => {
    const channel = telegram();
    const callbackData = channel.signCallback("approve", "request-safe-123");
    const parsed = channel.parseDecision({
      callbackData,
      chatId: "123",
      userId: "42",
      receivedAt: at,
    });
    assert.equal(parsed.kind, "DECISION");
    if (parsed.kind === "DECISION") assert.equal(parsed.decision, "APPROVE");
  });

  test("rejects an invalid callback signature", () => {
    const channel = telegram();
    assert.throws(
      () => channel.parseDecision({
        callbackData: "approve:request-safe-123:invalid",
        chatId: "123",
        userId: "42",
        receivedAt: at,
      }),
      code("EDITORIAL_ORCHESTRATION_CALLBACK_SIGNATURE_INVALID"),
    );
  });

  test("records a signed Telegram revision request with controlled default instructions", async () => {
    const channel = new TelegramHumanDecisionChannel({
      botToken: "test-bot-token",
      approverChatId: "123",
      webhookSecret: "test-webhook-secret",
      allowedUserIds: ["420"],
      clock: () => at,
      fetchImplementation: async () => new Response(
        JSON.stringify({ ok: true, result: { message_id: 77 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    const repository = new InMemoryEditorialOrchestrationRepository();
    const service = new EditorialOrchestrationService({
      repository,
      pipeline: new FixtureEditorialOrchestrationPipeline(),
      channel,
      decisionExecutor: new InMemoryHumanEditorialDecisionExecutor(),
      clock: () => at,
    });
    await service.startScheduledRun(trigger("telegram-change-request"));
    const request = (await service.getPendingHumanDecisions())[0];
    if (request === undefined) throw new Error("Expected a Telegram decision request.");
    const result = await service.registerExternalDecision({
      callbackData: channel.signCallback("changes", request.id),
      chatId: "123",
      userId: "420",
      receivedAt: at,
    });
    assert.equal(result.kind, "DECISION");
    if (result.kind === "DECISION") {
      assert.equal(result.decision.decision, "REQUEST_CHANGES");
      assert.deepEqual(result.decision.changeInstructions, [
        "Revisão editorial solicitada via Telegram; forneça instruções antes de uma nova versão.",
      ]);
    }
  });

  test("rejects an unauthorized chat", () => {
    const channel = telegram();
    assert.throws(
      () => channel.parseDecision({
        callbackData: channel.signCallback("approve", "request-safe-123"),
        chatId: "999",
        userId: "42",
        receivedAt: at,
      }),
      code("EDITORIAL_ORCHESTRATION_TELEGRAM_CHAT_UNAUTHORIZED"),
    );
  });

  test("rejects an unauthorized user when configured", () => {
    const channel = telegram();
    assert.throws(
      () => channel.parseDecision({
        callbackData: channel.signCallback("approve", "request-safe-123"),
        chatId: "123",
        userId: "77",
        receivedAt: at,
      }),
      code("EDITORIAL_ORCHESTRATION_TELEGRAM_USER_UNAUTHORIZED"),
    );
  });

  test("delivers only to the fixed Telegram HTTPS API", async () => {
    let calledUrl = "";
    const channel = telegram(async (input) => {
      calledUrl = String(input);
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 55 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const request = await decisionRequest();
    const delivery = await channel.sendDecisionRequest(request);
    assert.match(calledUrl, /^https:\/\/api\.telegram\.org\/bot/);
    assert.equal(delivery.externalMessageReference, "telegram-message:55");
  });

  test("classifies Telegram unavailability as transient without exposing token", async () => {
    const channel = telegram(async () => new Response("unavailable", { status: 503 }));
    await assert.rejects(
      channel.sendDecisionRequest(await decisionRequest()),
      (error: unknown) => error instanceof EditorialOrchestrationError &&
        error.code === "ORCHESTRATION_TELEGRAM_UNAVAILABLE" &&
        error.transient &&
        !error.message.includes("test-bot-token"),
    );
  });

  test("requires explicit Telegram configuration", () => {
    assert.throws(
      () => new TelegramHumanDecisionChannel({
        botToken: "",
        approverChatId: "",
        webhookSecret: "",
        clock: () => at,
      }),
      code("EDITORIAL_ORCHESTRATION_TELEGRAM_CONFIG_MISSING"),
    );
  });
});

function createFixture(options: {
  readonly pipeline?: EditorialOrchestrationPipeline;
  readonly clock?: () => string;
  readonly deliveryClock?: () => string;
} = {}) {
  const repository = new InMemoryEditorialOrchestrationRepository();
  const channel = new InMemoryHumanDecisionChannel(
    options.deliveryClock ?? (() => at),
  );
  const executor = new InMemoryHumanEditorialDecisionExecutor();
  const service = new EditorialOrchestrationService({
    repository,
    pipeline: options.pipeline ?? new FixtureEditorialOrchestrationPipeline(),
    channel,
    decisionExecutor: executor,
    clock: options.clock ?? (() => at),
  });
  return { repository, channel, executor, service };
}

function trigger(suffix: string) {
  return {
    triggerType: "N8N_SCHEDULED" as const,
    triggerKey: `editorial-run:2026-07-29:${suffix}`,
    triggeredBy: "n8n-test",
  };
}

async function failedRunId(
  fixture: ReturnType<typeof createFixture>,
  suffix: string,
) {
  await assert.rejects(fixture.service.startScheduledRun(trigger(suffix)));
  const run = (await fixture.service.listRuns())[0];
  if (run === undefined) throw new Error("Expected failed run.");
  return run.id;
}

function telegram(fetchImplementation?: typeof fetch) {
  return new TelegramHumanDecisionChannel({
    botToken: "test-bot-token",
    approverChatId: "123",
    webhookSecret: "test-webhook-secret",
    allowedUserIds: ["42"],
    clock: () => at,
    ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
  });
}

async function decisionRequest() {
  const fixture = createFixture();
  await fixture.service.startScheduledRun(trigger("telegram-delivery"));
  const request = (await fixture.service.getPendingHumanDecisions())[0];
  if (request === undefined) throw new Error("Expected decision request.");
  return { ...request, channel: "TELEGRAM" as const };
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof EditorialOrchestrationError && error.code === expected;
}
