import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EditorialDraftWorkflowService,
  type EditorialDraftAtomicResult,
  type EditorialDraftContext,
  type EditorialDraftUnitOfWork,
} from "../packages/application/src/index.ts";
import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1,
  EditorialGenerationDiagnosticError,
  createEditorialBrief,
  createReceivedNews,
  evaluateVerification,
  type EditorialGeneratedText,
  type EditorialGenerationInput,
  type OllamaCallMetrics,
} from "../packages/content-engine/src/index.ts";
import { WebmcpTwoCallGenerator } from "../apps/sistemandrestudio-api/src/webmcp-homologation.ts";

const officialUrl = "https://blog.cloudflare.com/webmcp/";

function fixture(): { readonly context: EditorialDraftContext; readonly brief: ReturnType<typeof createEditorialBrief> } {
  const news = { ...createReceivedNews({ id: "webmcp-regression", source: { id: "cloudflare-blog", name: "Cloudflare Blog", url: officialUrl, isOfficial: true }, title: "WebMCP foi anunciado", originalUrl: officialUrl, publishedAt: "2026-08-08T10:00:00.000Z", eventAt: "2026-08-08T10:00:00.000Z", receivedAt: "2026-08-08T10:00:00.000Z" }), state: "VERIFIED" as const };
  const claims = [{ id: "webmcp-claim", text: "Cloudflare anunciou WebMCP.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "WebMCP" }];
  const evidence = [{ id: "webmcp-evidence", claimId: claims[0]!.id, sourceId: "cloudflare-blog", canonicalUrl: officialUrl, sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: news.receivedAt, eventDate: news.eventAt, excerpt: "Cloudflare anunciou WebMCP.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
  const verification = evaluateVerification({ verificationId: "webmcp-verification", newsId: news.id, claims, evidence, policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1, evaluatedAt: news.receivedAt });
  return { context: { news, verification, claims, evidence }, brief: createEditorialBrief({ news, verification, claims, evidence, createdAt: news.receivedAt }) };
}

function longBody(): string {
  const sentence = "Cloudflare anunciou WebMCP para oferecer uma forma de interação entre sites e agentes, conforme a evidência oficial. Isso pode ajudar desenvolvedores e empresas a compreenderem uma proposta de integração, sem prometer resultados ou experiência prática.";
  return `${Array.from({ length: 6 }, () => sentence).join(" ")} Essa descrição oficial orienta desenvolvedores e empresas sem prometer resultados concretos. Fonte oficial: ${officialUrl}`;
}

class FakeModel {
  readonly generatorVersion = "gemma4:e2b-it-qat";
  lastCallMetrics: OllamaCallMetrics | undefined;
  repairs = 0;
  private readonly repairedBody: string | undefined;
  constructor(repairedBody: string | undefined) { this.repairedBody = repairedBody; }
  async generate(_input: EditorialGenerationInput): Promise<EditorialGeneratedText> {
    this.lastCallMetrics = { promptTokenCount: 40, completionTokenCount: 50, effectiveOutputLimit: 768, terminationReason: "STOP" };
    return { title: "WebMCP no Cloudflare", subtitle: "Resumo factual. Sem experiência prática.", body: `WebMCP está em preview. Fonte oficial: ${officialUrl}` };
  }
  async repairWebsiteBrief(input: { readonly failureCodes: readonly string[] }): Promise<EditorialGeneratedText> {
    this.repairs += 1;
    assert.ok(input.failureCodes.length > 0);
    this.lastCallMetrics = { promptTokenCount: 60, completionTokenCount: 240, effectiveOutputLimit: 768, terminationReason: "STOP" };
    return { title: "WebMCP no Cloudflare", subtitle: "Resumo factual. Sem experiência prática.", body: this.repairedBody ?? `WebMCP está em preview. Fonte oficial: ${officialUrl}` };
  }
}

class ValidInitialModel extends FakeModel {
  override async generate(_input: EditorialGenerationInput): Promise<EditorialGeneratedText> {
    this.lastCallMetrics = { promptTokenCount: 40, completionTokenCount: 240, effectiveOutputLimit: 768, terminationReason: "STOP" };
    return { title: "WebMCP no Cloudflare", subtitle: "Resumo factual. Sem experiência prática.", body: longBody() };
  }
}

function inputFor(brief: ReturnType<typeof createEditorialBrief>): EditorialGenerationInput {
  return { brief, format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 3_000, editorialIdentityVersion: "test" };
}

function unitOfWork(context: EditorialDraftContext, onPersist: () => void): EditorialDraftUnitOfWork {
  return {
    loadContext: async () => context,
    executeAtomic: async (operation): Promise<EditorialDraftAtomicResult> => { onPersist(); return { draft: operation.draft, currentState: "PENDING_APPROVAL", replayed: false }; },
  };
}

describe("tracked WebMCP homologation executor", () => {
  test("validates the initial schema-valid response and performs one directed body repair", async () => {
    const { context, brief } = fixture();
    const model = new FakeModel(longBody());
    const generator = new WebmcpTwoCallGenerator(model, officialUrl);
    const result = await generator.generate(inputFor(brief));
    assert.equal(generator.calls, 2);
    assert.equal(model.repairs, 1);
    assert.equal(generator.validation.words220to240, true);
    assert.equal(generator.validation.noUnsupportedQualifier, true);
    assert.equal(result.body.includes("preview"), false);
    assert.ok(generator.wordCount >= 220 && generator.wordCount <= 240);
    assert.equal(context.news.state, "VERIFIED");
  });

  test("returns typed diagnostics and performs no persistence when repair remains invalid", async () => {
    const { context, brief } = fixture();
    let persisted = 0;
    const model = new FakeModel(undefined);
    const generator = new WebmcpTwoCallGenerator(model, officialUrl);
    const service = new EditorialDraftWorkflowService(unitOfWork(context, () => { persisted += 1; }), generator);
    await assert.rejects(service.createDraft({ newsId: context.news.id, verificationId: context.verification.verificationId, format: "WEBSITE_NEWS_BRIEF", idempotencyKey: "webmcp-failure", expectedVersion: 0, commandId: "webmcp-failure", approvalRequestId: "webmcp-failure:approval", actor: { type: "SYSTEM", id: "test" }, occurredAt: context.news.receivedAt }), (error) => error instanceof Error && "diagnostics" in error && (error as { diagnostics?: readonly { attempt?: number; wordCount?: number; codes?: readonly string[] }[] }).diagnostics?.[1]?.attempt === 2 && (error as { diagnostics?: readonly { wordCount?: number }[] }).diagnostics?.[1]?.wordCount !== undefined);
    assert.equal(persisted, 0);
    assert.equal(generator.calls, 2);
  });

  test("persists exactly once only after a valid initial generation", async () => {
    const { context, brief } = fixture();
    let persisted = 0;
    const model = new ValidInitialModel(longBody());
    const generator = new WebmcpTwoCallGenerator(model, officialUrl);
    const service = new EditorialDraftWorkflowService(unitOfWork(context, () => { persisted += 1; }), generator);
    const result = await service.createDraft({ newsId: context.news.id, verificationId: context.verification.verificationId, format: "WEBSITE_NEWS_BRIEF", idempotencyKey: "webmcp-success", expectedVersion: 0, commandId: "webmcp-success", approvalRequestId: "webmcp-success:approval", actor: { type: "SYSTEM", id: "test" }, occurredAt: context.news.receivedAt });
    assert.equal(result.draft.validationStatus, "VALID");
    assert.equal(persisted, 1);
    assert.equal(generator.calls, 1);
  });
});
