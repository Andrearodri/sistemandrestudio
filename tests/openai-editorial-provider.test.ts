import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Response } from "openai/resources/responses/responses";
import {
  EDITORIAL_OUTPUT_JSON_SCHEMA,
  OpenAIEditorialProvider,
  OpenAIEditorialProviderError,
  OllamaEditorialTextGenerator,
  createEditorialBrief,
  createEditorialProvider,
  createEditorialFactPacket,
} from "../packages/content-engine/src/index.ts";
import type { OpenAIEditorialProviderClient } from "../packages/content-engine/src/index.ts";

function brief() {
  const news = {
    id: "news-webmcp",
    source: { id: "official", name: "Web Platform", url: "https://developer.chrome.com", isOfficial: true },
    title: "Give any website a WebMCP interface",
    originalUrl: "https://developer.chrome.com/blog/webmcp-epp",
    publishedAt: "2026-08-08T00:00:00.000Z",
    eventAt: "2026-08-08T00:00:00.000Z",
    receivedAt: "2026-08-08T00:00:00.000Z",
  };
  const claims = [{ id: "claim-webmcp", text: "WebMCP foi anunciado oficialmente.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "WebMCP" }];
  const evidence = [{ id: "evidence-webmcp", claimId: "claim-webmcp", sourceId: "official", canonicalUrl: news.originalUrl, sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: news.receivedAt, eventDate: news.eventAt, excerpt: "Give any website a WebMCP interface.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
  const evidenceId = evidence[0]?.id ?? "evidence-webmcp";
  const verification = { verificationId: "verification-webmcp", newsId: news.id, status: "CONFIRMED" as const, confidence: 100, editorialDecision: "ALLOW_DRAFT_GENERATION" as const, evaluatedAt: news.receivedAt, claims: [{ claimId: "claim-webmcp", status: "SUPPORTED" as const, confidence: 100, evidenceIds: [evidenceId], reason: "Official evidence" }], warnings: [] };
  return createEditorialBrief({ news: news as never, claims, evidence, verification: verification as never, createdAt: verification.evaluatedAt });
}

function input() {
  return { brief: brief(), format: "WEBSITE_NEWS_BRIEF" as const, language: "pt-BR" as const, tone: "informativo" as const, maxCharacters: 3_000, editorialIdentityVersion: "v1" };
}

function response(output: unknown, usage = { input_tokens: 42, output_tokens: 84 }): Response {
  return { output_text: JSON.stringify(output), usage, status: "completed" } as unknown as Response;
}

function fakeClient(handler: (request: Parameters<OpenAIEditorialProviderClient["responses"]["create"]>[0]) => Promise<Response>): OpenAIEditorialProviderClient {
  return { responses: { create: handler } };
}

describe("OpenAI Luna editorial provider", () => {
  test("keeps Radar on Ollama and selects Luna only for long form", () => {
    const ollama = createEditorialProvider("RADAR", { RADAR_LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://127.0.0.1:11434/v1", LLM_MODEL: "gemma4:e2b-it-qat" });
    assert.ok(ollama instanceof OllamaEditorialTextGenerator);
    assert.throws(() => createEditorialProvider("RADAR", { RADAR_LLM_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }), /fixed to Ollama/u);
    const luna = createEditorialProvider("LONG_FORM", { EDITORIAL_PROVIDER: "openai", OPENAI_API_KEY: "test-key", OPENAI_HARD_SPEND_LIMIT_USD: "1" });
    assert.ok(luna instanceof OpenAIEditorialProvider);
    assert.throws(() => createEditorialProvider("LONG_FORM", { EDITORIAL_PROVIDER: "openai", OPENAI_HARD_SPEND_LIMIT_USD: "1" }), { code: "OPENAI_API_KEY_MISSING" });
    assert.throws(() => createEditorialProvider("LONG_FORM", { EDITORIAL_PROVIDER: "openai", OPENAI_API_KEY: "test-key" }), { code: "OPENAI_HARD_SPEND_LIMIT_UNCONFIRMED" });
  });

  test("sends strict Responses structured output with the shared schema", async () => {
    let request: Parameters<OpenAIEditorialProviderClient["responses"]["create"]>[0] | undefined;
    const provider = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async (value) => { request = value; return response({ title: "WebMCP", subtitle: "Resumo factual.", body: "WebMCP foi anunciado oficialmente. Fonte: https://developer.chrome.com/blog/webmcp-epp" }); }));
    const generated = await provider.generate(input());
    assert.equal(generated.title, "WebMCP");
    assert.equal(provider.calls, 1);
    assert.equal(request?.model, "gpt-5.6-luna");
    assert.equal(request?.store, false);
    assert.deepEqual(request?.tools, []);
    assert.deepEqual(request?.reasoning, { effort: "low" });
    assert.equal(request?.max_output_tokens, 768);
    assert.deepEqual(request?.text?.format, { type: "json_schema", name: "editorial_output", schema: EDITORIAL_OUTPUT_JSON_SCHEMA, strict: true });
    const userText = String((request?.input as readonly { content?: readonly { text?: string }[] }[])[0]?.content?.[0]?.text ?? "");
    assert.match(userText, /factPacket/u);
    assert.match(userText, /subtitle/u);
  });

  test("returns sanitized usage and estimated cost for a valid response", async () => {
    const provider = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async () => response({ title: "WebMCP", subtitle: "Resumo factual.", body: "WebMCP foi anunciado." }, { input_tokens: 1_000, output_tokens: 2_000 })));
    await provider.generate(input());
    assert.deepEqual(provider.usage, { inputTokens: 1_000, outputTokens: 2_000, estimatedCostUsd: 0.0026 });
    assert.deepEqual(provider.lastCallMetrics, { promptTokenCount: 1_000, completionTokenCount: 2_000, effectiveOutputLimit: 768, terminationReason: "STOP" });
  });

  test("rejects invalid JSON and schema without exposing model output", async () => {
    const invalidJson = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async () => ({ output_text: "not-json", usage: { input_tokens: 1, output_tokens: 1 }, status: "completed" } as unknown as Response)));
    await assert.rejects(invalidJson.generate(input()), (error: unknown) => error instanceof OpenAIEditorialProviderError && error.code === "OPENAI_RESPONSE_INVALID" && !error.message.includes("not-json"));
    const invalidSchema = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async () => response({ title: "WebMCP", subtitle: { nested: true }, body: "WebMCP foi anunciado." })));
    await assert.rejects(invalidSchema.generate(input()), { code: "OPENAI_SCHEMA_INVALID" });
  });

  test("maps authentication, rate limit, server and timeout failures", async () => {
    for (const [error, code] of [[{ status: 401 }, "OPENAI_AUTHENTICATION_FAILED"], [{ status: 429 }, "OPENAI_RATE_LIMITED"], [{ status: 503 }, "OPENAI_SERVER_ERROR"], [new Error("request timed out"), "OPENAI_TIMEOUT"]] as const) {
      const provider = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async () => { throw error; }));
      await assert.rejects(provider.generate(input()), { code });
    }
  });

  test("allows only two calls, including one directed repair", async () => {
    const provider = new OpenAIEditorialProvider({ apiKey: "test-key" }, fakeClient(async (request) => {
      const text = String((request.input as readonly { content?: readonly { text?: string }[] }[])[0]?.content?.[0]?.text ?? "");
      return text.includes("Repare somente") ? response({ body: "WebMCP foi anunciado. Fonte: https://developer.chrome.com/blog/webmcp-epp" }) : response({ title: "WebMCP", subtitle: "Resumo factual.", body: "WebMCP foi anunciado." });
    }));
    const first = await provider.generate(input());
    await provider.repairWebsiteBrief({ original: input(), previous: first, failureCodes: ["WORD_COUNT_BELOW_MINIMUM"], wordCount: 4, wordDelta: 176, factPacket: createEditorialFactPacket(input().brief) });
    await assert.rejects(provider.generate(input()), { code: "OPENAI_CALL_LIMIT_REACHED" });
    assert.equal(provider.calls, 2);
  });

  test("does not create persistence or publication side effects", () => {
    const provider = createEditorialProvider("LONG_FORM", { EDITORIAL_PROVIDER: "openai", OPENAI_API_KEY: "test-key", OPENAI_HARD_SPEND_LIMIT_USD: "1" });
    assert.ok(provider instanceof OpenAIEditorialProvider);
    assert.equal(provider.calls, 0);
  });
});
