import { createOrchestrationRuntime } from "./orchestration-runtime.ts";

if (process.env.DRY_RUN_ORCHESTRATION !== "true" ||
  process.env.HUMAN_DECISION_CHANNEL !== "TELEGRAM" ||
  process.env.PUBLICATION_ENABLED !== "false") {
  throw new Error("Telegram polling requires DRY_RUN_ORCHESTRATION=true, HUMAN_DECISION_CHANNEL=TELEGRAM and PUBLICATION_ENABLED=false.");
}

const token = required("TELEGRAM_BOT_TOKEN");
const runtime = createOrchestrationRuntime();

try {
  const updates = await telegram("getUpdates", { allowed_updates: ["callback_query"], timeout: 0 });
  const callback = latestPrivateCallback(updates.result);
  if (callback === undefined) {
    console.log(JSON.stringify({ ok: true, processed: false, reason: "NO_PRIVATE_CALLBACK" }));
  } else {
    const result = await runtime.service.registerExternalDecision({
      callbackData: callback.data,
      chatId: String(callback.message.chat.id),
      userId: String(callback.from.id),
      receivedAt: new Date().toISOString(),
      externalMessageReference: `telegram-callback:${callback.id}`,
    });
    if (result.kind === "DECISION") await runtime.service.resumeRun(result.request.runId);
    let callbackAcknowledged = true;
    try {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: result.kind === "DETAILS"
          ? "Detalhes já estão na mensagem."
          : "Decisão registrada localmente. A publicação continua bloqueada.",
        show_alert: false,
      });
    } catch {
      callbackAcknowledged = false;
    }
    console.log(JSON.stringify({
      ok: true,
      processed: true,
      kind: result.kind,
      decision: result.kind === "DECISION" ? result.decision.decision : undefined,
      replayed: result.kind === "DECISION" ? result.replayed : undefined,
      callbackAcknowledged,
      publicationEnabled: false,
    }));
  }
} finally {
  await runtime.pool.end();
}

function latestPrivateCallback(updates: unknown) {
  if (!Array.isArray(updates)) return undefined;
  const callbacks = updates.flatMap((update) => {
    if (typeof update !== "object" || update === null) return [];
    const candidate = (update as { callback_query?: unknown }).callback_query;
    if (!isCallback(candidate) || candidate.message.chat.type !== "private") return [];
    return [candidate];
  });
  return callbacks.at(-1);
}

function isCallback(value: unknown): value is {
  readonly id: string;
  readonly data: string;
  readonly from: { readonly id: number };
  readonly message: { readonly chat: { readonly id: number; readonly type: string } };
} {
  if (typeof value !== "object" || value === null) return false;
  const callback = value as {
    id?: unknown; data?: unknown; from?: { id?: unknown };
    message?: { chat?: { id?: unknown; type?: unknown } };
  };
  return typeof callback.id === "string" && typeof callback.data === "string" &&
    typeof callback.from?.id === "number" && typeof callback.message?.chat?.id === "number" &&
    typeof callback.message.chat.type === "string";
}

async function telegram(method: "getUpdates" | "answerCallbackQuery", body: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json() as { readonly ok?: boolean; readonly result?: unknown };
  if (!response.ok || payload.ok !== true) throw new Error(`Telegram ${method} failed.`);
  return payload as { readonly ok: true; readonly result: unknown };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
