import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  EDITORIAL_OUTPUT_JSON_SCHEMA,
  OllamaEditorialTextGenerator,
  createEditorialBrief,
  createEditorialFactPacket,
  findProhibitedEditorialQualifiers,
  inspectWebsiteBriefOutput,
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
    assert.equal(payload.temperature, 0);
    assert.equal(payload.max_tokens, 300);
    assert.equal(payload.reasoning_effort, "none");
    assert.deepEqual(payload.format, EDITORIAL_OUTPUT_JSON_SCHEMA);
    assert.equal("response_format" in payload, false);
    assert.equal("tools" in payload, false);
    const messages = payload.messages as readonly { role: string; content: string }[];
    assert.equal(messages[0]?.role, "user");
    assert.match(messages[0]?.content ?? "", /subtitle deve ser uma frase curta em texto simples/u);
    assert.match(messages[0]?.content ?? "", /não use qualificadores de estágio ausentes/iu);
    assert.match(messages[0]?.content ?? "", /outputContract/);
    assert.equal(messages.length, 1);
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
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "OLLAMA_RESPONSE_INVALID" && /does not match the editorial JSON schema/u.test(error.message),
      );
    }
  });

  test("rejects a missing required subtitle", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Atlas 2.0", body: "Atlas 2.0 foi anunciado oficialmente." }) } }] }), { status: 200 });
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await assert.rejects(
      generator.generate({ brief: brief(), format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" }),
      { code: "OLLAMA_RESPONSE_INVALID", message: "Local Ollama response does not match the editorial JSON schema." },
    );
  });

  test("rejects non-JSON output without exposing model content", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "texto fora do JSON" } }] }), { status: 200 });
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await assert.rejects(
      generator.generate({ brief: brief(), format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 600, editorialIdentityVersion: "v1" }),
      { code: "OLLAMA_RESPONSE_INVALID", message: "Local Ollama must return one JSON object without surrounding text." },
    );
  });

  test("rejects a website brief below the safe 180-word floor", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      title: "WebMCP anunciado",
      subtitle: "Resumo factual curto.",
      body: `${Array.from({ length: 172 }, (_, index) => `palavra${index}`).join(" ")} https://example.com/atlas`,
    }) } }] }), { status: 200 });
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    const generated = await generator.generate({ brief: brief(), format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 3_000, editorialIdentityVersion: "v1" });
    const validation = inspectWebsiteBriefOutput(generated, ["https://example.com/atlas"]);
    assert.equal(validation.valid, false);
    assert.deepEqual(validation.failureCodes, ["OLLAMA_EDITORIAL_LENGTH_INVALID"]);
    assert.equal(validation.wordCount, 176);
  });

  test("uses the full website budget instead of the 160-token radar budget", async () => {
    let request: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "Atlas 2.0", subtitle: "Resumo factual simples.", body: `${Array.from({ length: 180 }, (_, index) => `palavra${index}`).join(" ")}` }) } }] }), { status: 200 });
    };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await generator.generate({ brief: brief(), format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 3_000, editorialIdentityVersion: "v1" });
    assert.equal(request?.max_tokens, 768);
    assert.deepEqual(request?.options, { num_ctx: 4096, num_predict: 768 });
    assert.notEqual(request?.max_tokens, 160);
    const schema = request?.format as { properties?: { body?: { minLength?: number; maxLength?: number } } };
    assert.equal(schema.properties?.body?.minLength, 1);
    assert.equal(schema.properties?.body?.maxLength, 12_000);
  });

  test("keeps prohibited qualifiers out of the WebMCP fact packet", () => {
    const packet = createEditorialFactPacket(brief());
    assert.deepEqual(packet.allowedQualifiers, []);
    assert.deepEqual(packet.prohibitedQualifiers, ["preview", "beta", "versão", "version", "disponibilidade"]);
    assert.deepEqual(findProhibitedEditorialQualifiers("WebMCP em preview e beta", packet), ["preview", "beta"]);
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
    assert.deepEqual(payload.options, { num_ctx: 4096, num_predict: 500 });
    assert.equal(payload.temperature, 0);
    assert.deepEqual(payload.format, EDITORIAL_OUTPUT_JSON_SCHEMA);
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
    assert.deepEqual(payload.options, { num_ctx: 4096, num_predict: 160 });
    assert.equal(payload.temperature, 0);
    assert.equal("tools" in payload, false);
  });

  test("repairs a valid structured object using only exact failures and word delta", async () => {
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const count = requests.length;
      const body = count === 1
        ? `${Array.from({ length: 170 }, (_, index) => `palavra${index}`).join(" ")}`
        : `${Array.from({ length: 185 }, (_, index) => `palavra${index}`).join(" ")}`;
      return new Response(JSON.stringify({ choices: [{ message: { content: count === 1 ? JSON.stringify({ title: "Atlas 2.0", subtitle: "Resumo factual simples.", body }) : JSON.stringify({ body }) } }] }), { status: 200 });
    };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    const input = { brief: brief(), format: "WEBSITE_NEWS_BRIEF" as const, language: "pt-BR" as const, tone: "informativo" as const, maxCharacters: 3_000, editorialIdentityVersion: "v1" };
    const first = await generator.generate(input);
    const firstValidation = inspectWebsiteBriefOutput(first, ["https://example.com/atlas"]);
    assert.equal(firstValidation.valid, false);
    const repaired = await generator.repairWebsiteBrief({ original: input, previous: first, failureCodes: firstValidation.failureCodes, wordCount: firstValidation.wordCount, wordDelta: firstValidation.wordDelta, factPacket: createEditorialFactPacket(input.brief) });
    assert.equal(repaired.title, first.title);
    assert.equal(repaired.subtitle, first.subtitle);
    assert.equal(inspectWebsiteBriefOutput(repaired, ["https://example.com/atlas"]).valid, true);
    assert.equal(requests.length, 2);
    const repairUser = JSON.parse(String((requests[1]?.messages as readonly { content: string }[])[0]?.content));
    assert.deepEqual(repairUser.failureCodes, ["OLLAMA_EDITORIAL_LENGTH_INVALID"]);
    assert.equal("previousDraft" in repairUser, false);
    assert.deepEqual(repairUser.previousFields, { title: "Atlas 2.0", subtitle: "Resumo factual simples." });
    assert.equal(repairUser.wordDelta, 4);
    assert.equal(requests[1]?.temperature, 0);
  });

  test("does not repair an invalid JSON object and never persists from the adapter", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }); };
    const generator = new OllamaEditorialTextGenerator({ baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat" });
    await assert.rejects(generator.generate({ brief: brief(), format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 3_000, editorialIdentityVersion: "v1" }), { code: "OLLAMA_RESPONSE_INVALID" });
    assert.equal(calls, 1);
  });
});
