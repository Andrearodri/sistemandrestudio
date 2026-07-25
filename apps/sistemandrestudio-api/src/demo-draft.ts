import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1, createEditorialBrief, createReceivedNews,
  evaluateVerification, generateEditorialDraft, transition, HIGH_RELEVANCE,
} from "../../../packages/content-engine/src/index.ts";

const occurredAt = "2026-07-25T12:00:00.000Z";
let news = createReceivedNews({ id: "demo-draft-news", source: { id: "demo-official", name: "Fonte Oficial de Demonstração", url: "https://example.invalid", isOfficial: true }, title: "Orbit 2.0 foi anunciado", originalUrl: "https://example.invalid/orbit", publishedAt: occurredAt, eventAt: occurredAt, receivedAt: occurredAt });
for (const [command, eventId] of [[{ type: "NormalizeNews", normalizedTitle: news.title, canonicalUrl: news.originalUrl }, "normalize"], [{ type: "ScoreNews", relevance: HIGH_RELEVANCE }, "score"], [{ type: "RequestVerification" }, "request"]] as const) news = transition(news, command, { eventId, actor: { type: "SYSTEM", id: "demo" }, occurredAt }).entity;
const claims = [{ id: "demo-claim", text: "A Fonte Oficial anunciou o Orbit 2.0.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "Orbit" }];
const evidence = [{ id: "demo-evidence", claimId: "demo-claim", sourceId: "demo-official", canonicalUrl: "https://example.invalid/orbit", sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: occurredAt, eventDate: occurredAt, excerpt: "A Fonte Oficial anunciou o Orbit 2.0.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
const verification = evaluateVerification({ verificationId: "demo-verification", newsId: news.id, claims, evidence, policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1, evaluatedAt: occurredAt });
news = transition(news, { type: "ApproveVerification", verification: { outcome: "VERIFIED", confidence: "HIGH", claimType: "FACT", evidence: [], reason: "CONFIRMED", policyVersion: verification.policyVersion } }, { eventId: "verify", actor: { type: "SYSTEM", id: "demo" }, occurredAt }).entity;
const brief = createEditorialBrief({ news, verification, claims, evidence, createdAt: occurredAt });
for (const format of ["LINKEDIN_SHORT_POST", "WEBSITE_NEWS_BRIEF"] as const) {
  const draft = await generateEditorialDraft({ brief, format, language: "pt-BR", tone: "informativo", maxCharacters: 2000, editorialIdentityVersion: "andrestudio-dev-v1" });
  console.log(`\n${format}\nStatus factual: ${verification.status}\nElegibilidade: ${brief.editorialEligibility}\nTítulo: ${draft.title}\nCorpo: ${draft.body.slice(0, 240)}\nCitações: ${draft.sourceCitations.length}\nValidação: ${draft.validationStatus}`);
}
console.log("Estado final planejado após persistência: PENDING_APPROVAL");
