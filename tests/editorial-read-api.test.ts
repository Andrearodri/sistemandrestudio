import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";

import {
  EditorialReadService,
  type EditorialDraftView,
  type EditorialReadRepository,
} from "../packages/application/src/index.ts";
import type { EditorialNews } from "../packages/content-engine/src/index.ts";
import {
  createOrchestrationHttpServer,
  type OrchestrationHttpServerOptions,
} from "../apps/sistemandrestudio-api/src/orchestration-server.ts";

const READ_SECRET = "read-secret-at-least-16-characters";
const WRITE_SECRET = "write-secret-at-least-16-characters";
const OPERATIONAL_SECRET = "operational-secret-at-least-16-characters";
const servers: ReturnType<typeof createOrchestrationHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

describe("internal editorial read API", () => {
  test("returns 401 without Bearer authentication", async () => {
    const context = await start();
    const response = await fetch(`${context.url}/internal/health`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  test("returns 403 when a valid credential lacks editorial:read", async () => {
    const context = await start();
    const response = await request(context.url, "/internal/health", WRITE_SECRET);
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response),
      "EDITORIAL_ORCHESTRATION_API_FORBIDDEN");
  });

  test("serves all read contracts with authentication and no-store", async () => {
    const context = await start();
    const paths = [
      "/internal/health",
      "/internal/system/status",
      "/internal/editorial/items?state=RECEIVED&limit=1",
      "/internal/editorial/items/news-read-1",
      "/internal/editorial/items/news-read-1/evidence",
      "/internal/editorial/drafts/draft-read-1?version=1",
    ];
    for (const path of paths) {
      const response = await request(context.url, path, READ_SECRET);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(context.repository.mutations, 0);
  });

  test("allows editorial:read on the two read-only orchestration routes", async () => {
    const context = await start();
    const paths = [
      "/internal/orchestration/pending-decisions",
      "/internal/orchestration/runs/run-read-1",
    ];
    for (const path of paths) {
      const unauthenticated = await fetch(`${context.url}${path}`);
      assert.equal(unauthenticated.status, 401, path);

      const forbidden = await request(context.url, path, WRITE_SECRET);
      assert.equal(forbidden.status, 403, path);

      const allowed = await request(context.url, path, READ_SECRET);
      assert.equal(allowed.status, 200, path);

      const operational = await request(context.url, path, OPERATIONAL_SECRET);
      assert.equal(operational.status, 200, path);
    }
  });

  test("keeps every mutating route forbidden to editorial:read", async () => {
    const context = await start();
    const attempts = [
      ["POST", "/internal/orchestration/runs"],
      ["POST", "/internal/orchestration/runs/run-read-1/resume"],
      ["POST", "/internal/human-decisions"],
      ["PUT", "/internal/orchestration/runs/run-read-1"],
      ["PATCH", "/internal/orchestration/pending-decisions"],
      ["DELETE", "/internal/editorial/items/news-read-1"],
    ] as const;
    for (const [method, path] of attempts) {
      const response = await requestWithMethod(
        context.url,
        path,
        READ_SECRET,
        method,
      );
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(
        await errorCode(response),
        "EDITORIAL_ORCHESTRATION_API_FORBIDDEN",
      );
    }
  });

  test("validates parameters strictly and enforces the maximum limit", async () => {
    const context = await start();
    const invalid = [
      "/internal/editorial/items?state=UNKNOWN",
      "/internal/editorial/items?limit=0",
      "/internal/editorial/items?limit=101",
      "/internal/editorial/items?limit=1&limit=2",
      "/internal/editorial/items?unexpected=true",
      "/internal/editorial/drafts/draft-read-1?version=-1",
    ];
    for (const path of invalid) {
      assert.equal((await request(context.url, path, READ_SECRET)).status, 400, path);
    }
    assert.equal((await request(
      context.url,
      "/internal/editorial/items?limit=100",
      READ_SECRET,
    )).status, 200);
    assert.equal(context.repository.lastListLimit, 101);
  });

  test("returns stable 404 errors for missing items and drafts", async () => {
    const context = await start();
    const item = await request(
      context.url,
      "/internal/editorial/items/missing-item",
      READ_SECRET,
    );
    const draft = await request(
      context.url,
      "/internal/editorial/drafts/missing-draft",
      READ_SECRET,
    );
    assert.equal(item.status, 404);
    assert.equal(await errorCode(item), "EDITORIAL_READ_ITEM_NOT_FOUND");
    assert.equal(draft.status, 404);
    assert.equal(await errorCode(draft), "EDITORIAL_READ_DRAFT_NOT_FOUND");
  });

  test("does not expose unexpected errors, credentials or connection strings", async () => {
    const audit: unknown[] = [];
    const context = await start({
      repository: new FakeReadRepository(true),
      audit: (event) => audit.push(event),
    });
    const response = await request(context.url, "/internal/health", READ_SECRET);
    const output = JSON.stringify(await response.json());
    assert.equal(response.status, 500);
    assert.doesNotMatch(output, /postgres|password|READ_SECRET|read-secret/i);
    assert.doesNotMatch(JSON.stringify(audit), /read-secret|Bearer|postgresql:\/\//i);
  });

  test("rate limits requests with a stable 429 response", async () => {
    const context = await start({ rateLimit: 2 });
    assert.equal((await request(context.url, "/internal/health", READ_SECRET)).status, 200);
    assert.equal((await request(context.url, "/internal/health", READ_SECRET)).status, 200);
    const blocked = await request(context.url, "/internal/health", READ_SECRET);
    assert.equal(blocked.status, 429);
    assert.equal(await errorCode(blocked),
      "EDITORIAL_ORCHESTRATION_API_RATE_LIMIT");
  });

  test("times out a slow read with a stable error", async () => {
    const repository = new FakeReadRepository();
    repository.healthDelayMs = 150;
    const context = await start({ repository, timeoutMs: 100 });
    const response = await request(context.url, "/internal/health", READ_SECRET);
    assert.equal(response.status, 504);
    assert.equal(await errorCode(response),
      "EDITORIAL_ORCHESTRATION_API_TIMEOUT");
  });
});

class FakeReadRepository implements EditorialReadRepository {
  mutations = 0;
  lastListLimit = 0;
  healthDelayMs = 0;

  private readonly failHealth: boolean;

  constructor(failHealth = false) {
    this.failHealth = failHealth;
  }

  async health() {
    if (this.healthDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.healthDelayMs));
    }
    if (this.failHealth) {
      throw new Error("DO_NOT_LEAK_INTERNAL_DATABASE_DETAIL");
    }
    return { database: "available" as const };
  }

  async systemStatus() {
    return {
      database: "available" as const,
      itemsByState: { RECEIVED: 1 },
      pendingHumanDecisions: 0,
    };
  }

  async listItems(input: Parameters<EditorialReadRepository["listItems"]>[0]) {
    this.lastListLimit = input.limit;
    return [{
      newsId: ITEM.id,
      state: ITEM.state,
      source: ITEM.source,
      title: ITEM.title,
      canonicalUrl: ITEM.canonicalUrl,
      publishedAt: ITEM.publishedAt,
      receivedAt: ITEM.receivedAt,
      relevanceScore: null,
      currentDraftVersionId: ITEM.currentDraftVersionId,
      updatedAt: ITEM.receivedAt,
    }];
  }

  async findItem(newsId: string) {
    return newsId === ITEM.id ? ITEM : undefined;
  }

  async listEvidence(
    input: Parameters<EditorialReadRepository["listEvidence"]>[0],
  ) {
    if (input.newsId !== ITEM.id) return undefined;
    return [{
      evidenceId: "evidence-read-1",
      claimId: "claim-read-1",
      claim: "A factual claim.",
      sourceId: "official-source",
      canonicalUrl: "https://example.com/evidence",
      authority: "PRIMARY_OFFICIAL",
      evidenceType: "RELEASE_NOTE",
      retrievedAt: ITEM.receivedAt,
      supportsClaim: true,
      contradictsClaim: false,
    }];
  }

  async findDraft(input: Parameters<EditorialReadRepository["findDraft"]>[0]) {
    return input.draftId === DRAFT.draftId ? DRAFT : undefined;
  }
}

const ITEM: EditorialNews = {
  id: "news-read-1",
  source: {
    id: "official-source",
    name: "Official source",
    url: "https://example.com",
    isOfficial: true,
  },
  title: "Read-only item",
  originalUrl: "https://example.com/item",
  canonicalUrl: "https://example.com/item",
  publishedAt: "2026-07-29T10:00:00.000Z",
  eventAt: "2026-07-29T10:00:00.000Z",
  receivedAt: "2026-07-29T10:01:00.000Z",
  state: "RECEIVED",
  duplicateOfNewsId: null,
  relevance: null,
  verification: null,
  draftVersions: [],
  currentDraftVersionId: null,
  approvalRequests: [],
  currentApprovalRequestId: null,
  decisions: [],
  processedCommands: [],
  auditEvents: [],
};

const DRAFT: EditorialDraftView = {
  draftId: "draft-read-1",
  newsId: ITEM.id,
  version: 1,
  sourceDraftId: null,
  format: "WEBSITE_NEWS_BRIEF",
  language: "pt-BR",
  title: "Draft title",
  body: "Draft body",
  validationStatus: "VALID",
  warnings: [],
  citations: [],
  createdAt: ITEM.receivedAt,
};

async function start(overrides: {
  repository?: FakeReadRepository;
  audit?: OrchestrationHttpServerOptions["audit"];
  rateLimit?: number;
  timeoutMs?: number;
} = {}) {
  const repository = overrides.repository ?? new FakeReadRepository();
  const readService = new EditorialReadService(repository);
  const runtime = {
    readService,
    service: {
      startScheduledRun: async () => null as never,
      getRun: async () => null as never,
      resumeRun: async () => null as never,
      getPendingHumanDecisions: async () => [],
      registerExternalDecision: async () => null as never,
    },
  };
  const server = createOrchestrationHttpServer({
    runtime,
    credentials: [
      { id: "reader", secret: READ_SECRET, scopes: ["editorial:read"] },
      { id: "writer", secret: WRITE_SECRET, scopes: ["orchestration:write"] },
      {
        id: "operational",
        secret: OPERATIONAL_SECRET,
        scopes: ["orchestration:write", "editorial:read"],
      },
    ],
    dryRun: true,
    ...(overrides.audit === undefined ? { audit: () => undefined } : {
      audit: overrides.audit,
    }),
    ...(overrides.rateLimit === undefined ? {} : {
      rateLimit: overrides.rateLimit,
    }),
    ...(overrides.timeoutMs === undefined ? {} : {
      timeoutMs: overrides.timeoutMs,
    }),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, repository };
}

function request(url: string, path: string, secret: string) {
  return requestWithMethod(url, path, secret, "GET");
}

function requestWithMethod(
  url: string,
  path: string,
  secret: string,
  method: string,
) {
  return fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}` },
  });
}

async function errorCode(response: Response) {
  const body = await response.json() as {
    readonly error: { readonly code: string };
  };
  return body.error.code;
}
