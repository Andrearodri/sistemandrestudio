export interface TelegramCallbackUpdate {
  readonly id: string;
  readonly data: string;
  readonly from: { readonly id: number };
  readonly message: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat: { readonly id: number; readonly type: string };
  };
}

export interface TelegramCallbackRuntime {
  readonly channel: {
    parseDecision(input: {
      readonly callbackData: string;
      readonly chatId: string;
      readonly userId: string;
      readonly receivedAt: string;
      readonly externalMessageReference: string;
    }): unknown;
  };
  readonly service: {
    registerExternalDecision(input: {
      readonly callbackData: string;
      readonly chatId: string;
      readonly userId: string;
      readonly receivedAt: string;
      readonly externalMessageReference: string;
    }): Promise<
      | { readonly kind: "DETAILS"; readonly request: { readonly runId: string } }
      | { readonly kind: "DECISION"; readonly request: { readonly runId: string }; readonly decision: { readonly decision: string }; readonly replayed: boolean }
    >;
    resumeRun(runId: string): Promise<unknown>;
  };
}

export type TelegramCallbackApi = (
  method: "answerCallbackQuery" | "editMessageText" | "editMessageReplyMarkup",
  body: Record<string, unknown>,
) => Promise<unknown>;

export async function processTelegramCallback(input: {
  readonly callback: TelegramCallbackUpdate;
  readonly runtime: TelegramCallbackRuntime;
  readonly telegram: TelegramCallbackApi;
  readonly receivedAt?: string;
}) {
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const externalMessageReference = `telegram-callback:${input.callback.id}`;
  const decisionInput = {
    callbackData: input.callback.data,
    chatId: String(input.callback.message.chat.id),
    userId: String(input.callback.from.id),
    receivedAt,
    externalMessageReference,
  };

  input.runtime.channel.parseDecision(decisionInput);
  let callbackAcknowledged = true;
  try {
    await input.telegram("answerCallbackQuery", {
      callback_query_id: input.callback.id,
      text: "Recebido. Registrando a decisão editorial local.",
      show_alert: false,
    });
  } catch {
    callbackAcknowledged = false;
  }

  const result = await input.runtime.service.registerExternalDecision(decisionInput);
  if (result.kind === "DECISION") await input.runtime.service.resumeRun(result.request.runId);

  const decisionLabel = result.kind === "DETAILS"
    ? "DETALHES CONSULTADOS"
    : result.decision.decision === "APPROVE"
      ? "APROVAÇÃO EDITORIAL LOCAL"
      : result.decision.decision === "REJECT"
        ? "REJEITADO"
        : "REVISÃO SOLICITADA";
  let messageUpdated = true;
  try {
    if (input.callback.message.text) {
      await input.telegram("editMessageText", {
        chat_id: input.callback.message.chat.id,
        message_id: input.callback.message.message_id,
        text: `${input.callback.message.text.slice(0, 3_850)}\n\nDecisão local: ${decisionLabel}`,
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      await input.telegram("editMessageReplyMarkup", {
        chat_id: input.callback.message.chat.id,
        message_id: input.callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    }
  } catch {
    messageUpdated = false;
  }

  return {
    processed: true,
    kind: result.kind,
    decision: result.kind === "DECISION" ? result.decision.decision : undefined,
    replayed: result.kind === "DECISION" ? result.replayed : undefined,
    callbackAcknowledged,
    messageUpdated,
    publicationEnabled: false,
  };
}
