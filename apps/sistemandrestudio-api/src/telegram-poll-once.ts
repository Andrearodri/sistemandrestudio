import { createOrchestrationRuntime } from "./orchestration-runtime.ts";
import {
  processTelegramCallback,
  type TelegramCallbackUpdate,
} from "./telegram-callback-handler.ts";

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
    const result = await processTelegramCallback({ callback, runtime, telegram });
    console.log(JSON.stringify({ ok: true, ...result }));
  }
} finally {
  await runtime.pool.end();
}

function latestPrivateCallback(updates: unknown): TelegramCallbackUpdate | undefined {
  if (!Array.isArray(updates)) return undefined;
  const callbacks = updates.flatMap((update) => {
    if (typeof update !== "object" || update === null) return [];
    const candidate = (update as { callback_query?: unknown }).callback_query;
    if (!isCallback(candidate) || candidate.message.chat.type !== "private") return [];
    return [candidate];
  });
  return callbacks.at(-1);
}

function isCallback(value: unknown): value is TelegramCallbackUpdate {
  if (typeof value !== "object" || value === null) return false;
  const callback = value as {
    id?: unknown; data?: unknown; from?: { id?: unknown };
    message?: { message_id?: unknown; text?: unknown; chat?: { id?: unknown; type?: unknown } };
  };
  return typeof callback.id === "string" && typeof callback.data === "string" &&
    typeof callback.from?.id === "number" && typeof callback.message?.message_id === "number" &&
    typeof callback.message.chat?.id === "number" &&
    typeof callback.message.chat.type === "string";
}

async function telegram(method: "getUpdates" | "answerCallbackQuery" | "editMessageText" | "editMessageReplyMarkup", body: Record<string, unknown>) {
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
