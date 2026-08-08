import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  OllamaEditorialTextGenerator,
  createEditorialBrief,
} from "../packages/content-engine/src/index.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function brief() {
  const news = { id: "news-ollama", source: { id: "official", name: "Fonte Oficial", url: "https://example.com", isOfficial: true }, title: "Atlas 2.0", originalUrl: "https://example.com/atlas", publishedAt: "2026-08-08T00:00:00.000Z", eventAt: "2026-08-08T00:00:00.000Z", receivedAt: "2026-08-08T00:00:00.000Z" };
  const claims = [{ id: "claim-ollama", text: "Atlas 2.0 foi anunciado oficialmente.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "Atlas" }];
  const evidence = [{ id: "evidence-ollama", claimId: "claim-ollama", sourceId: "official", canonicalUrl: "https://example.com/atlas", sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: "2026-08-08T00:00:00.000Z", eventDate: "2026-08-08T00:00:00.000Z", excerpt: "Atlas 2.0 foi anunciado oficialmente.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
  const verification = { verificationId: "verification-ollama", newsId: news.id, status: "CONFIRMED" as const, confidence: 100, editorialDecision: "ALLOW_DRAFT_GENERATION" as const, evaluatedAt: "2026-08-08T00:00:00.000Z", claims: [{ claimId: "claim-ollama", status: "SUPPORTED" as const, confidence: 100, evidenceIds: ["evidence-ollama"], reason: "Official evidence" }], warnings: [] };
  return createEditorialBrief({ news: news as any, claims, evidence, verification: verification as any, createdAt: verification.evaluatedAt });
}

describe("local Ollama editorial generator", () => {
  test("uses only the loopback OpenAI-compatible endpoint without tools", async () => {
    let request: unknown;
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Atlas 2.0", subtitle: "Resumo factual", body: "Atlas 2.0 foi anunciado oficialmente." }) } }] }), { status: 200 });
    };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    const generated = await generator.generate({ brief: brief(), format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" });
    assert.equal(generated.title, "Atlas 2.0");
    assert.equal(generated.body, "Atlas 2.0 foi anunciado oficialmente.");
    const payload = request as Record<string, unknown>;
    assert.equal(payload.model, "gemma4:e2b-it-qat");
    assert.equal(payload.temperature, 0.2);
    assert.equal(payload.max_tokens, 300);
    assert.equal(payload.reasoning_effort, "none");
    assert.deepEqual(payload.response_format, { type: "json_object" });
    assert.equal("tools" in payload, false);
  });

  test("rejects a non-loopback provider URL", () => {
    assert.throws(() => new OllamaEditorialTextGenerator({ baseUrl: "https://example.com/v1", model: "gemma4:e2b-it-qat" }), { code: "LLM_BASE_URL_INVALID" });
  });
});
