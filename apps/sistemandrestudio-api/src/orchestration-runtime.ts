import {
  ConsoleHumanDecisionChannel,
  EditorialOrchestrationError,
  EditorialOrchestrationService,
  HumanReviewServiceDecisionExecutor,
  TelegramHumanDecisionChannel,
  type HumanDecisionChannel,
} from "../../../packages/application/src/index.ts";
import { HumanEditorialReviewService } from "../../../packages/application/src/human-editorial-review-service.ts";
import {
  PostgresEditorialOrchestrationRepository,
  PostgresExistingEditorialOrchestrationPipeline,
  PostgresHumanEditorialReviewRepository,
  createDatabasePool,
  loadDatabaseConfig,
} from "../../../packages/database/src/index.ts";

export function createOrchestrationRuntime() {
  const pool = createDatabasePool(loadDatabaseConfig());
  const clock = () => new Date().toISOString();
  const channel = configuredChannel(clock);
  const repository = new PostgresEditorialOrchestrationRepository(pool);
  const pipeline = new PostgresExistingEditorialOrchestrationPipeline(pool, 3);
  const reviewService = new HumanEditorialReviewService(
    new PostgresHumanEditorialReviewRepository(pool),
  );
  const service = new EditorialOrchestrationService({
    repository,
    pipeline,
    channel,
    decisionExecutor: new HumanReviewServiceDecisionExecutor(reviewService),
    clock,
  });
  return { pool, service, channel };
}

function configuredChannel(clock: () => string): HumanDecisionChannel {
  const selected = process.env.HUMAN_DECISION_CHANNEL?.trim() || "CONSOLE";
  if (selected === "CONSOLE") return new ConsoleHumanDecisionChannel(clock);
  if (selected !== "TELEGRAM") {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_CHANNEL_INVALID",
      "HUMAN_DECISION_CHANNEL must be CONSOLE or TELEGRAM.",
    );
  }
  const botToken = required("TELEGRAM_BOT_TOKEN");
  const approverChatId = required("TELEGRAM_APPROVER_CHAT_ID");
  const webhookSecret = required("TELEGRAM_WEBHOOK_SECRET");
  const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return new TelegramHumanDecisionChannel({
    botToken,
    approverChatId,
    webhookSecret,
    allowedUserIds,
    clock,
  });
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_TELEGRAM_CONFIG_MISSING",
      `Missing required configuration: ${name}.`,
    );
  }
  return value;
}
