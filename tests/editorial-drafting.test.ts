import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1, createEditorialBrief, createReceivedNews,
  DeterministicEditorialTextGenerator, evaluateVerification, generateEditorialDraft,
  validateEditorialDraft,
} from "../packages/content-engine/src/index.ts";

function fixture(status: "confirmed" | "preview" | "missing" = "confirmed") {
  const news = createReceivedNews({ id: `draft-${status}`, source: { id: "official", name: "Fonte Oficial", url: "https://example.com", isOfficial: true }, title: "Orbit 2.0 foi anunciado", originalUrl: "https://example.com/orbit", publishedAt: "2026-07-24T10:00:00.000Z", eventAt: "2026-07-24T10:00:00.000Z", receivedAt: "2026-07-24T10:00:00.000Z" });
  const claims = [{ id: `claim-${status}`, text: "A Fonte Oficial anunciou o Orbit 2.0.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "Orbit" }];
  const claim = claims[0]!;
  const evidence = status === "missing" ? [] : [{ id: `evidence-${status}`, claimId: claim.id, sourceId: "official", canonicalUrl: "https://example.com/orbit", sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: "2026-07-24T10:00:00.000Z", eventDate: "2026-07-24T10:00:00.000Z", excerpt: status === "preview" ? "Orbit 2.0 está disponível em preview." : "A Fonte Oficial anunciou o Orbit 2.0.", structuredFacts: { availability: status === "preview" ? "preview" : "announced" }, supportsClaim: true, contradictsClaim: false }];
  const verification = evaluateVerification({ verificationId: `verification-${status}`, newsId: news.id, claims, evidence, policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1, evaluatedAt: "2026-07-24T10:00:00.000Z" });
  return { news, claims, evidence, verification };
}

describe("controlled editorial drafting", () => {
  test("creates a deterministic brief from confirmed facts only", () => {
    const input = fixture();
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    assert.equal(brief.editorialEligibility, "ALLOW_DRAFT");
    assert.equal(brief.allowedFacts.length, 1);
    assert.equal(brief.prohibitedClaims.length, 0);
    assert.equal(brief.policyVersion, "andre-studio-editorial-draft-v1");
  });
  test("does not make a partial result eligible for the normal flow", () => {
    const input = fixture("missing");
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    assert.equal(brief.editorialEligibility, "BLOCK_DRAFT");
  });
  test("generates LinkedIn and website drafts with citations", async () => {
    const input = fixture();
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    const linkedin = await generateEditorialDraft({ brief, format: "LINKEDIN_SHORT_POST", language: "pt-BR", tone: "informativo", maxCharacters: 1000, editorialIdentityVersion: "v1" });
    const website = await generateEditorialDraft({ brief, format: "WEBSITE_NEWS_BRIEF", language: "pt-BR", tone: "informativo", maxCharacters: 2000, editorialIdentityVersion: "v1" });
    assert.equal(linkedin.validationStatus, "VALID");
    assert.equal(website.validationStatus, "VALID");
    assert.match(website.body, /Fontes/);
    assert.equal(linkedin.sourceCitations.length, 1);
  });
  test("preserves preview qualification as a restriction", () => {
    const input = fixture("preview");
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    assert.match(brief.allowedFacts[0]?.restrictions.join(" ") ?? "", /preview/i);
  });
  test("blocks sensationalist and citation-free drafts", () => {
    const input = fixture();
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    const result = validateEditorialDraft({ draftId: "bad", newsId: brief.newsId, briefId: brief.briefId, format: "LINKEDIN_SHORT_POST", language: "pt-BR", title: "O melhor do mundo", body: "Texto", sourceCitations: [], warnings: [], prohibitedClaimsChecked: false, validationStatus: "BLOCKED", generatorId: "test", generatorVersion: "v1", createdAt: brief.createdAt }, brief);
    assert.equal(result.status, "BLOCKED");
  });
  test("generator is deterministic and treats injection as inert data", async () => {
    const input = fixture();
    const brief = createEditorialBrief({ ...input, createdAt: "2026-07-24T10:00:00.000Z" });
    const generator = new DeterministicEditorialTextGenerator();
    const parameters = { brief, format: "LINKEDIN_SHORT_POST" as const, language: "pt-BR" as const, tone: "informativo" as const, maxCharacters: 1000, editorialIdentityVersion: "v1" };
    assert.deepEqual(await generator.generate(parameters), await generator.generate(parameters));
  });
});
