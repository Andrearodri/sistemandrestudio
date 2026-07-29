import {
  EditorialOrchestrationError,
  type EditorialOrchestrationTrigger,
  type HumanEditorialDecision,
} from "../../../packages/application/src/index.ts";
import { createOrchestrationRuntime } from "./orchestration-runtime.ts";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const runtime = createOrchestrationRuntime();

try {
  let result: unknown;
  if (command === "start") {
    requireDryRun();
    result = await runtime.service.startScheduledRun({
      triggerType: value(args, "trigger") as EditorialOrchestrationTrigger,
      triggerKey: value(args, "trigger-key"),
      triggeredBy: args.get("triggered-by") ?? "n8n-local",
    });
  } else if (command === "show") {
    result = await runtime.service.getRun(value(args, "run"));
  } else if (command === "list") {
    result = await runtime.service.listRuns();
  } else if (command === "pending-decisions") {
    result = await runtime.service.getPendingHumanDecisions();
  } else if (command === "resume") {
    result = await runtime.service.resumeRun(value(args, "run"));
  } else if (command === "cancel") {
    result = await runtime.service.cancelRun({
      runId: value(args, "run"),
      operator: value(args, "operator"),
      reason: value(args, "reason"),
    });
  } else if (command === "decision") {
    result = await runtime.service.registerHumanDecision({
      requestId: value(args, "request"),
      reviewerId: value(args, "reviewer"),
      decision: value(args, "decision") as HumanEditorialDecision,
      receivedAt: args.get("received-at") ?? new Date().toISOString(),
      idempotencyKey: value(args, "idempotency-key"),
      ...(args.get("reason") === undefined ? {} : { reason: args.get("reason")! }),
      ...(args.get("changes") === undefined
        ? {}
        : { changeInstructions: args.get("changes")!.split("|").filter(Boolean) }),
      ...(args.get("external-message-reference") === undefined
        ? {}
        : { externalMessageReference: args.get("external-message-reference")! }),
    });
  } else {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_CLI_COMMAND_INVALID",
      "Expected start, show, list, pending-decisions, resume, cancel or decision.",
    );
  }
  writeJson({ ok: true, result });
} catch (error) {
  writeJson({
    ok: false,
    error: {
      code: errorCode(error),
      message: error instanceof Error ? error.message : "Unknown orchestration error.",
    },
  });
  process.exitCode = 1;
} finally {
  await runtime.pool.end();
}

function parseArgs(values: readonly string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token?.startsWith("--")) continue;
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_CLI_ARGUMENT_INVALID",
        `Missing value for ${token}.`,
      );
    }
    parsed.set(token.slice(2), next);
    index += 1;
  }
  return parsed;
}

function value(argsMap: ReadonlyMap<string, string>, key: string) {
  const found = argsMap.get(key);
  if (!found) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_CLI_ARGUMENT_REQUIRED",
      `Missing required argument: --${key}.`,
    );
  }
  return found;
}

function requireDryRun() {
  if (process.env.DRY_RUN_ORCHESTRATION !== "true") {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DRY_RUN_REQUIRED",
      "Set DRY_RUN_ORCHESTRATION=true to use the controlled existing-item adapter.",
    );
  }
}

function errorCode(error: unknown) {
  return error instanceof EditorialOrchestrationError
    ? error.code
    : "EDITORIAL_ORCHESTRATION_UNEXPECTED_FAILURE";
}

function writeJson(valueToWrite: unknown) {
  process.stdout.write(`${JSON.stringify(valueToWrite)}\n`);
}
