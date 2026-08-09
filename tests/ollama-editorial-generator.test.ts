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
    const generated = await generator.generate({ brief: brief(), format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" });
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

  test("rejects every non-string subtitle shape", async () => {
    for (const subtitle of [{ nested: true }, ["nested"], 42, true, null]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Atlas 2.0", subtitle, body: "Atlas 2.0 foi anunciado oficialmente." }) } }] }), { status: 200 });
      const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
      await assert.rejects(
        generator.generate({ brief: brief(), format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" }),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "OLLAMA_RESPONSE_INVALID" && /subtitle must be plain text|subtitle is empty/u.test(error.message),
      );
    }
  });

  test("rejects a missing required subtitle", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Atlas 2.0", body: "Atlas 2.0 foi anunciado oficialmente." }) } }] }), { status: 200 });
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await assert.rejects(
      generator.generate({ brief: brief(), format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" }),
      { code: "OLLAMA_SUBTITLE_REQUIRED" },
    );
  });

  test("rejects a website brief below the safe 180-word floor", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "WebMCP anunciado",
      subtitle: "Resumo factual curto.",
      body: `${Array.from({ length: 172 }, (_, index) => `palavra${index}`).join(" ")} https://example.com/atlas`,
    }) } }] }), { status: 200 });
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await assert.rejects(
      generator.generate({ brief: brief(), format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 3_000, editorialIdentityVersion: "v1" }),
      { code: "OLLAMA_EDITORIAL_LENGTH_INVALID" },
    );
  });

  test("generates one bounded evidence-only revision with 4096 context and 500 output tokens", async () => {
    let request: unknown;
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: "Radar Researcher: anúncio oficial",
        subtitle: "Resumo factual. Sem teste prático.",
        body: "Radar Researcher foi oficialmente anunciado.\n\nRadar Researcher é uma ferramenta de IA para explorar dados da Internet em linguagem simples.\n\nFonte oficial: https://blog.cloudflare.com/introducing-radar-researcher/ Radar Researcher was officially announced.",
      }) } }] }), { status: 200 });
    };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    const generated = await generator.generateRevision({
      previousTitle: "Radar Researcher Oficialmente Anunciado",
      previousBody: "O Radar Researcher foi oficialmente anunciado.",
      officialSourceTitle: "Introducing Radar Researcher: An AI tool for exploring Internet data in plain language",
      officialSourceName: "Cloudflare Blog",
      officialLink: "https://blog.cloudflare.com/introducing-radar-researcher/",
      supportedFacts: [
        "Radar Researcher was officially announced.",
        "Radar Researcher is an AI tool for exploring Internet data in plain language.",
      ],
      revisionInstructions: ["Ampliar sem inventar."],
      maximumCharacters: 2_400,
    });
    assert.match(generated.title, /Radar Researcher/);
    const payload = request as Record<string, unknown>;
    assert.equal(payload.max_tokens, 500);
    assert.deepEqual(payload.options, { num_ctx: 4096 });
    assert.equal(payload.temperature, 0.2);
    assert.equal("tools" in payload, false);
  });

  test("generates a daily radar summary with 4096 context and at most 160 output tokens", async () => {
    let request: unknown;
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Official item", body: "O anúncio foi confirmado. A novidade pode ser útil para desenvolvedores." }) } }] }), { status: 200 });
    };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    const summary = await generator.generateRadarSummary({ title: "Official item", sourceName: "Official source", officialLink: "https://example.com/item", supportedFacts: ["The item was announced."] });
    assert.match(summary, /desenvolvedores/);
    const payload = request as Record<string, unknown>;
    assert.equal(payload.max_tokens, 160);
    assert.deepEqual(payload.options, { num_ctx: 4096 });
    assert.equal(payload.temperature, 0.2);
    assert.equal("tools" in payload, false);
  });
});
