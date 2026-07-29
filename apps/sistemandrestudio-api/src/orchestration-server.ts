import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { EditorialOrchestrationError } from "../../../packages/application/src/index.ts";
import { createOrchestrationRuntime } from "./orchestration-runtime.ts";

const secret = process.env.ORCHESTRATION_API_SECRET?.trim();
if (!secret) {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_SECRET_MISSING",
    "ORCHESTRATION_API_SECRET is required.",
  );
}
const host = process.env.ORCHESTRATION_API_HOST?.trim() || "127.0.0.1";
if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_BIND_FORBIDDEN",
    "The internal API is restricted to localhost in this stage.",
  );
}
const port = Number(process.env.ORCHESTRATION_API_PORT ?? "4317");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_PORT_INVALID",
    "Invalid internal API port.",
  );
}

const runtime = createOrchestrationRuntime();
const rate = new Map<string, { count: number; windowStartedAt: number }>();
const server = createServer(async (request, response) => {
  try {
    enforceRateLimit(request);
    authenticate(request);
    const result = await route(request);
    json(response, result.status, { ok: true, result: result.body });
  } catch (error) {
    const code = error instanceof EditorialOrchestrationError
      ? error.code
      : "EDITORIAL_ORCHESTRATION_API_ERROR";
    const status = code.includes("NOT_FOUND")
      ? 404
      : code.includes("UNAUTHORIZED") || code.includes("SECRET")
      ? 401
      : code.includes("RATE_LIMIT")
      ? 429
      : 400;
    json(response, status, {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : "Internal API error.",
      },
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({ event: "orchestration-api-ready", host, port })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void runtime.pool.end().finally(() => process.exit(0));
    });
  });
}

async function route(request: IncomingMessage) {
  const method = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (method === "POST" && url.pathname === "/internal/orchestration/runs") {
    requireDryRun();
    const body = await readBody(request);
    return {
      status: 201,
      body: await runtime.service.startScheduledRun({
        triggerType: requiredString(body, "triggerType") as
          | "MANUAL"
          | "N8N_SCHEDULED"
          | "N8N_RETRY",
        triggerKey: requiredString(body, "triggerKey"),
        triggeredBy: requiredString(body, "triggeredBy"),
      }),
    };
  }
  const runMatch = url.pathname.match(/^\/internal\/orchestration\/runs\/([^/]+)$/);
  if (method === "GET" && runMatch?.[1]) {
    return {
      status: 200,
      body: await runtime.service.getRun(decodeURIComponent(runMatch[1])),
    };
  }
  const resumeMatch = url.pathname.match(
    /^\/internal\/orchestration\/runs\/([^/]+)\/resume$/,
  );
  if (method === "POST" && resumeMatch?.[1]) {
    return {
      status: 200,
      body: await runtime.service.resumeRun(decodeURIComponent(resumeMatch[1])),
    };
  }
  if (method === "GET" &&
    url.pathname === "/internal/orchestration/pending-decisions") {
    return {
      status: 200,
      body: await runtime.service.getPendingHumanDecisions(),
    };
  }
  if (method === "POST" && url.pathname === "/internal/human-decisions") {
    const body = await readBody(request);
    return {
      status: 200,
      body: await runtime.service.registerExternalDecision({
        callbackData: requiredString(body, "callbackData"),
        chatId: requiredString(body, "chatId"),
        receivedAt: requiredString(body, "receivedAt"),
        ...(optionalString(body, "userId") === undefined
          ? {}
          : { userId: optionalString(body, "userId")! }),
        ...(optionalString(body, "externalMessageReference") === undefined
          ? {}
          : {
            externalMessageReference: optionalString(
              body,
              "externalMessageReference",
            )!,
          }),
        ...(optionalString(body, "reason") === undefined
          ? {}
          : { reason: optionalString(body, "reason")! }),
        ...(Array.isArray(body.changeInstructions)
          ? {
            changeInstructions: body.changeInstructions.map((item) => {
              if (typeof item !== "string") invalidPayload();
              return item as string;
            }),
          }
          : {}),
      }),
    };
  }
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_ROUTE_NOT_FOUND",
    "Internal orchestration route not found.",
  );
}

async function readBody(request: IncomingMessage) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith(
    "application/json",
  )) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_CONTENT_TYPE_INVALID",
      "Internal API accepts application/json only.",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_000) {
      throw new EditorialOrchestrationError(
        "EDITORIAL_ORCHESTRATION_API_PAYLOAD_TOO_LARGE",
        "Internal API payload exceeds 16 KB.",
      );
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      invalidPayload();
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof EditorialOrchestrationError) throw error;
    invalidPayload();
  }
}

function authenticate(request: IncomingMessage) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.authorization ?? "");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_UNAUTHORIZED",
      "Internal API authentication failed.",
    );
  }
}

function enforceRateLimit(request: IncomingMessage) {
  const key = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const current = rate.get(key);
  if (current === undefined || now - current.windowStartedAt >= 60_000) {
    rate.set(key, { count: 1, windowStartedAt: now });
    return;
  }
  current.count += 1;
  if (current.count > 30) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_RATE_LIMIT",
      "Internal API rate limit exceeded.",
    );
  }
}

function requiredString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    invalidPayload();
  }
  return value as string;
}

function optionalString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2_000) invalidPayload();
  return value as string;
}

function invalidPayload(): never {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_PAYLOAD_INVALID",
    "Internal API payload is invalid.",
  );
}

function requireDryRun() {
  if (process.env.DRY_RUN_ORCHESTRATION !== "true") {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DRY_RUN_REQUIRED",
      "Controlled orchestration requires DRY_RUN_ORCHESTRATION=true.",
    );
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(body)}\n`);
}
