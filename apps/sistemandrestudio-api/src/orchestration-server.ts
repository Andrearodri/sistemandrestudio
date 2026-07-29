import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  EDITORIAL_READ_SCOPE,
  EditorialOrchestrationError,
  EditorialReadError,
  type EditorialReadService,
} from "../../../packages/application/src/index.ts";
import { createOrchestrationRuntime } from "./orchestration-runtime.ts";

const WRITE_SCOPE = "orchestration:write";

interface Credential {
  readonly id: string;
  readonly secret: string;
  readonly scopes: readonly string[];
}

interface AuditEvent {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly credentialId?: string;
  readonly requiredScope?: string;
  readonly outcome: "ALLOWED" | "DENIED" | "FAILED";
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string;
}

interface Runtime {
  readonly service: {
    startScheduledRun(input: Parameters<
      ReturnType<typeof createOrchestrationRuntime>["service"]["startScheduledRun"]
    >[0]): ReturnType<
      ReturnType<typeof createOrchestrationRuntime>["service"]["startScheduledRun"]
    >;
    getRun(id: string): ReturnType<
      ReturnType<typeof createOrchestrationRuntime>["service"]["getRun"]
    >;
    resumeRun(id: string): ReturnType<
      ReturnType<typeof createOrchestrationRuntime>["service"]["resumeRun"]
    >;
    getPendingHumanDecisions(): ReturnType<
      ReturnType<typeof createOrchestrationRuntime>["service"]["getPendingHumanDecisions"]
    >;
    registerExternalDecision(input: Parameters<
      ReturnType<typeof createOrchestrationRuntime>["service"]["registerExternalDecision"]
    >[0]): ReturnType<
      ReturnType<typeof createOrchestrationRuntime>["service"]["registerExternalDecision"]
    >;
  };
  readonly readService: Pick<
    EditorialReadService,
    "health" | "systemStatus" | "listItems" | "getItem" | "getEvidence" | "getDraft"
  >;
  readonly pool?: { end(): Promise<void> };
}

export interface OrchestrationHttpServerOptions {
  readonly runtime: Runtime;
  readonly credentials: readonly Credential[];
  readonly dryRun: boolean;
  readonly rateLimit?: number;
  readonly rateWindowMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly audit?: (event: AuditEvent) => void;
}

export function createOrchestrationHttpServer(
  options: OrchestrationHttpServerOptions,
) {
  if (options.credentials.length === 0 ||
    options.credentials.some((credential) => credential.secret.length < 16)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_SECRET_INVALID",
      "Internal API credentials must use secrets with at least 16 characters.",
    );
  }
  const rate = new Map<string, { count: number; windowStartedAt: number }>();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const audit = options.audit ?? ((event) => {
    process.stdout.write(`${JSON.stringify({ event: "internal-api-audit", ...event })}\n`);
  });

  return createServer(async (request, response) => {
    const startedAt = now();
    const requestId = requestIdFrom(request);
    const method = request.method ?? "";
    const url = safeUrl(request);
    let credential: Credential | undefined;
    let requiredScope: string | undefined;
    try {
      enforceRateLimit(request, rate, now(), options.rateLimit ?? 30,
        options.rateWindowMs ?? 60_000);
      credential = authenticate(request, options.credentials);
      requiredScope = scopeFor(method, url.pathname);
      authorize(credential, requiredScope);
      const result = await withTimeout(
        route(request, url, options.runtime, options.dryRun),
        timeoutMs,
      );
      json(response, result.status, { ok: true, result: result.body });
      audit({
        requestId,
        method,
        route: routeLabel(url.pathname),
        credentialId: credential.id,
        requiredScope,
        outcome: "ALLOWED",
        status: result.status,
        durationMs: Math.max(0, now() - startedAt),
      });
    } catch (error) {
      const { code, message, status } = publicError(error);
      json(response, status, { ok: false, error: { code, message } });
      audit({
        requestId,
        method,
        route: routeLabel(url.pathname),
        ...(credential === undefined ? {} : { credentialId: credential.id }),
        ...(requiredScope === undefined ? {} : { requiredScope }),
        outcome: status === 401 || status === 403 ? "DENIED" : "FAILED",
        status,
        durationMs: Math.max(0, now() - startedAt),
        errorCode: code,
      });
    }
  });
}

async function route(
  request: IncomingMessage,
  url: URL,
  runtime: Runtime,
  dryRun: boolean,
) {
  const method = request.method ?? "";
  if (method === "GET" && url.pathname === "/internal/health") {
    rejectUnexpectedParameters(url, []);
    return { status: 200, body: await runtime.readService.health() };
  }
  if (method === "GET" && url.pathname === "/internal/system/status") {
    rejectUnexpectedParameters(url, []);
    return { status: 200, body: await runtime.readService.systemStatus() };
  }
  if (method === "GET" && url.pathname === "/internal/editorial/items") {
    rejectUnexpectedParameters(url, ["state", "limit", "cursor"]);
    return {
      status: 200,
      body: await runtime.readService.listItems({
        ...(singleParameter(url, "state") === undefined
          ? {}
          : { state: singleParameter(url, "state")! }),
        ...(singleInteger(url, "limit") === undefined
          ? {}
          : { limit: singleInteger(url, "limit")! }),
        ...(singleParameter(url, "cursor") === undefined
          ? {}
          : { cursor: singleParameter(url, "cursor")! }),
      }),
    };
  }
  const evidenceMatch = url.pathname.match(
    /^\/internal\/editorial\/items\/([^/]+)\/evidence$/,
  );
  if (method === "GET" && evidenceMatch?.[1]) {
    rejectUnexpectedParameters(url, ["limit", "cursor"]);
    return {
      status: 200,
      body: await runtime.readService.getEvidence({
        newsId: decodeIdentifier(evidenceMatch[1]),
        ...(singleInteger(url, "limit") === undefined
          ? {}
          : { limit: singleInteger(url, "limit")! }),
        ...(singleParameter(url, "cursor") === undefined
          ? {}
          : { cursor: singleParameter(url, "cursor")! }),
      }),
    };
  }
  const itemMatch = url.pathname.match(/^\/internal\/editorial\/items\/([^/]+)$/);
  if (method === "GET" && itemMatch?.[1]) {
    rejectUnexpectedParameters(url, []);
    return {
      status: 200,
      body: await runtime.readService.getItem(decodeIdentifier(itemMatch[1])),
    };
  }
  const draftMatch = url.pathname.match(/^\/internal\/editorial\/drafts\/([^/]+)$/);
  if (method === "GET" && draftMatch?.[1]) {
    rejectUnexpectedParameters(url, ["version"]);
    return {
      status: 200,
      body: await runtime.readService.getDraft(
        decodeIdentifier(draftMatch[1]),
        singleInteger(url, "version"),
      ),
    };
  }
  if (method === "POST" && url.pathname === "/internal/orchestration/runs") {
    requireDryRun(dryRun);
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
    rejectUnexpectedParameters(url, []);
    return {
      status: 200,
      body: await runtime.service.getRun(decodeIdentifier(runMatch[1])),
    };
  }
  const resumeMatch = url.pathname.match(
    /^\/internal\/orchestration\/runs\/([^/]+)\/resume$/,
  );
  if (method === "POST" && resumeMatch?.[1]) {
    return {
      status: 200,
      body: await runtime.service.resumeRun(decodeIdentifier(resumeMatch[1])),
    };
  }
  if (method === "GET" &&
    url.pathname === "/internal/orchestration/pending-decisions") {
    rejectUnexpectedParameters(url, []);
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
    "Internal API route not found.",
  );
}

function scopeFor(method: string, pathname: string) {
  if (method === "GET" && (
    pathname === "/internal/health" ||
    pathname === "/internal/system/status" ||
    pathname === "/internal/orchestration/pending-decisions" ||
    /^\/internal\/orchestration\/runs\/[^/]+$/.test(pathname) ||
    pathname === "/internal/editorial/items" ||
    /^\/internal\/editorial\/items\/[^/]+(?:\/evidence)?$/.test(pathname) ||
    /^\/internal\/editorial\/drafts\/[^/]+$/.test(pathname)
  )) return EDITORIAL_READ_SCOPE;
  return WRITE_SCOPE;
}

function authenticate(request: IncomingMessage, credentials: readonly Credential[]) {
  const value = request.headers.authorization;
  if (value === undefined || !value.startsWith("Bearer ")) unauthorized();
  const received = Buffer.from(value.slice(7));
  for (const credential of credentials) {
    const expected = Buffer.from(credential.secret);
    if (expected.length === received.length &&
      timingSafeEqual(expected, received)) return credential;
  }
  unauthorized();
}

function authorize(credential: Credential, requiredScope: string) {
  if (!credential.scopes.includes(requiredScope)) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_FORBIDDEN",
      "Credential does not grant the required scope.",
    );
  }
}

function unauthorized(): never {
  throw new EditorialOrchestrationError(
    "EDITORIAL_ORCHESTRATION_API_UNAUTHORIZED",
    "Internal API authentication failed.",
  );
}

function enforceRateLimit(
  request: IncomingMessage,
  rate: Map<string, { count: number; windowStartedAt: number }>,
  now: number,
  maximum: number,
  windowMs: number,
) {
  const key = request.socket.remoteAddress ?? "unknown";
  const current = rate.get(key);
  if (current === undefined || now - current.windowStartedAt >= windowMs) {
    rate.set(key, { count: 1, windowStartedAt: now });
    return;
  }
  current.count += 1;
  if (current.count > maximum) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_RATE_LIMIT",
      "Internal API rate limit exceeded.",
    );
  }
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

function requireDryRun(dryRun: boolean) {
  if (!dryRun) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_DRY_RUN_REQUIRED",
      "Controlled orchestration requires DRY_RUN_ORCHESTRATION=true.",
    );
  }
}

function rejectUnexpectedParameters(url: URL, allowed: readonly string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new EditorialReadError(
        "EDITORIAL_READ_PARAMETER_INVALID",
        "Request parameters are invalid.",
      );
    }
  }
}

function singleParameter(url: URL, name: string) {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (value.length === 0 || value.length > 128) {
    throw new EditorialReadError(
      "EDITORIAL_READ_PARAMETER_INVALID",
      "Request parameters are invalid.",
    );
  }
  return value;
}

function singleInteger(url: URL, name: string) {
  const value = singleParameter(url, name);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,6})$/.test(value)) {
    throw new EditorialReadError(
      "EDITORIAL_READ_PARAMETER_INVALID",
      "Request parameters are invalid.",
    );
  }
  return Number(value);
}

function decodeIdentifier(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EditorialReadError(
      "EDITORIAL_READ_IDENTIFIER_INVALID",
      "Resource identifier is invalid.",
    );
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_TIMEOUT_CONFIG_INVALID",
      "Internal API timeout configuration is invalid.",
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_TIMEOUT",
      "Internal API request timed out.",
    )), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function publicError(error: unknown) {
  if (error instanceof EditorialReadError ||
    error instanceof EditorialOrchestrationError) {
    const code = error.code;
    const status = code.includes("NOT_FOUND") || code.includes("ROUTE_NOT_FOUND")
      ? 404
      : code.includes("UNAUTHORIZED") || code.includes("SECRET")
      ? 401
      : code.includes("FORBIDDEN")
      ? 403
      : code.includes("RATE_LIMIT")
      ? 429
      : code.endsWith("_TIMEOUT")
      ? 504
      : 400;
    return { code, message: error.message, status };
  }
  return {
    code: "EDITORIAL_ORCHESTRATION_API_INTERNAL_ERROR",
    message: "Internal API request failed.",
    status: 500,
  };
}

function safeUrl(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return new URL("/", "http://127.0.0.1");
  }
}

function requestIdFrom(request: IncomingMessage) {
  const supplied = request.headers["x-request-id"];
  if (typeof supplied === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(supplied)) return supplied;
  return `internal-${Date.now().toString(36)}`;
}

function routeLabel(pathname: string) {
  return pathname
    .replace(/(\/items\/)[^/]+/, "$1:newsId")
    .replace(/(\/drafts\/)[^/]+/, "$1:draftId")
    .replace(/(\/runs\/)[^/]+/, "$1:runId");
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function configuredCredentials(environment: NodeJS.ProcessEnv): Credential[] {
  const writeSecret = environment.ORCHESTRATION_API_SECRET?.trim();
  if (!writeSecret) {
    throw new EditorialOrchestrationError(
      "EDITORIAL_ORCHESTRATION_API_SECRET_MISSING",
      "ORCHESTRATION_API_SECRET is required.",
    );
  }
  const credentials: Credential[] = [{
    id: "orchestration-service",
    secret: writeSecret,
    scopes: [WRITE_SCOPE, EDITORIAL_READ_SCOPE],
  }];
  const readSecret = environment.EDITORIAL_READ_API_SECRET?.trim();
  if (readSecret) {
    credentials.push({
      id: "editorial-read-client",
      secret: readSecret,
      scopes: [EDITORIAL_READ_SCOPE],
    });
  }
  return credentials;
}

export function startConfiguredOrchestrationServer() {
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
  const server = createOrchestrationHttpServer({
    runtime,
    credentials: configuredCredentials(process.env),
    dryRun: process.env.DRY_RUN_ORCHESTRATION === "true",
    timeoutMs: Number(process.env.ORCHESTRATION_API_TIMEOUT_MS ?? "5000"),
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
  return server;
}

if (process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href) {
  startConfiguredOrchestrationServer();
}
