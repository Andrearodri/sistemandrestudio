import assert from "node:assert/strict";
import { test } from "node:test";

import { processTelegramCallback } from "../apps/sistemandrestudio-api/src/telegram-callback-handler.ts";

test("acknowledges a validated callback before persistence and updates the message afterward", async () => {
  const events: string[] = [];
  const callback = {
    id: "callback-safe",
    data: "approve:request-safe:signature",
    from: { id: 420 },
    message: { message_id: 77, text: "Versão revisada", chat: { id: 123, type: "private" } },
  };
  const result = await processTelegramCallback({
    callback,
    receivedAt: "2026-08-08T23:50:00.000Z",
    runtime: {
      channel: { parseDecision: () => { events.push("validate"); } },
      service: {
        registerExternalDecision: async () => {
          events.push("persist");
          return { kind: "DECISION" as const, request: { runId: "run-safe" }, decision: { decision: "APPROVE" }, replayed: false };
        },
        resumeRun: async () => { events.push("resume"); },
      },
    },
    telegram: async (method) => { events.push(method); },
  });
  assert.deepEqual(events, ["validate", "answerCallbackQuery", "persist", "resume", "editMessageText"]);
  assert.equal(result.callbackAcknowledged, true);
  assert.equal(result.messageUpdated, true);
  assert.equal(result.publicationEnabled, false);
});

test("keeps a replayed callback idempotent", async () => {
  let calls = 0;
  const runtime = {
    channel: { parseDecision: () => undefined },
    service: {
      registerExternalDecision: async () => ({
        kind: "DECISION" as const,
        request: { runId: "run-safe" },
        decision: { decision: "REQUEST_CHANGES" },
        replayed: calls++ > 0,
      }),
      resumeRun: async () => undefined,
    },
  };
  const callback = {
    id: "callback-replay",
    data: "changes:request-safe:signature",
    from: { id: 420 },
    message: { message_id: 77, text: "Versão revisada", chat: { id: 123, type: "private" } },
  };
  const first = await processTelegramCallback({ callback, runtime, telegram: async () => undefined });
  const second = await processTelegramCallback({ callback, runtime, telegram: async () => undefined });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
});
