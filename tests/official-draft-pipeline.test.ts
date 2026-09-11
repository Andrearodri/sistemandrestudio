import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  diagnoseOfficialDraftEligibility,
  officialItemLogicalIdentity,
  OFFICIAL_DRAFT_PIPELINE_POLICY,
  EditorialDraftWorkflowError,
  EditorialDraftWorkflowService,
} from "../packages/application/src/index.ts";
import { ANDRE_STUDIO_VERIFICATION_POLICY_V1, EditorialGenerationDiagnosticError, createReceivedNews, evaluateVerification } from "../packages/content-engine/src/index.ts";

const identityInput = { sourceId: "google-developers-blog", externalId: "post-42", canonicalUrl: "https://developers.googleblog.com/item/#fragment", contentHash: "ABC123", eventIdentity: "2026-07-25" };

describe("official editorial draft pipeline policy", () => {
  test("diagnoses a historical confirmation without reopening it", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFICATION_REJECTED", latestVerificationStatus: "CONFIRMED", latestVerificationIsCurrent: false, confirmedClaims: 1, draftExists: false }), "VERIFICATION_HISTORICAL_ONLY"));
  test("blocks an aggregate that is not VERIFIED", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "PENDING_VERIFICATION", latestVerificationStatus: "PARTIALLY_CONFIRMED", latestVerificationIsCurrent: true, confirmedClaims: 1, draftExists: false }), "EDITORIAL_STATE_NOT_VERIFIED"));
  test("marks a current confirmed item eligible", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFIED", latestVerificationStatus: "CONFIRMED", latestVerificationIsCurrent: true, confirmedClaims: 1, draftExists: false }), "ELIGIBLE"));
  test("insufficient evidence never becomes eligible", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFICATION_REJECTED", latestVerificationStatus: "INSUFFICIENT_EVIDENCE", latestVerificationIsCurrent: true, confirmedClaims: 0, draftExists: false }), "AGGREGATE_TERMINAL"));
  test("contradicted content never becomes eligible", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFICATION_REJECTED", latestVerificationStatus: "CONTRADICTED", latestVerificationIsCurrent: true, confirmedClaims: 0, draftExists: false }), "AGGREGATE_TERMINAL"));
  test("an existing draft is reported as replay", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "PENDING_APPROVAL", latestVerificationStatus: "CONFIRMED", latestVerificationIsCurrent: true, confirmedClaims: 1, draftExists: true }), "DRAFT_ALREADY_EXISTS"));
  test("missing verification has a stable reason", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "PENDING_VERIFICATION", latestVerificationIsCurrent: false, confirmedClaims: 0, draftExists: false }), "CURRENT_VERIFICATION_MISSING"));
  test("confirmed result without supported claims is blocked", () => assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFIED", latestVerificationStatus: "CONFIRMED", latestVerificationIsCurrent: true, confirmedClaims: 0, draftExists: false }), "CONFIRMED_CLAIMS_MISSING"));
  test("logical identity is deterministic", () => assert.equal(officialItemLogicalIdentity(identityInput), officialItemLogicalIdentity(identityInput)));
  test("logical identity ignores URL fragments and host case", () => assert.equal(officialItemLogicalIdentity(identityInput), officialItemLogicalIdentity({ ...identityInput, canonicalUrl: "https://DEVELOPERS.GOOGLEBLOG.COM/item" })));
  test("logical identity changes with content", () => assert.notEqual(officialItemLogicalIdentity(identityInput), officialItemLogicalIdentity({ ...identityInput, contentHash: "different" })));
  test("logical identity changes with event version", () => assert.notEqual(officialItemLogicalIdentity(identityInput), officialItemLogicalIdentity({ ...identityInput, eventIdentity: "2026-07-26" })));
  test("logical identity prevents duplicating a historical item", () => assert.equal(new Set([officialItemLogicalIdentity(identityInput), officialItemLogicalIdentity(identityInput)]).size, 1));
  test("selection policy is limited to ten", () => assert.equal(OFFICIAL_DRAFT_PIPELINE_POLICY.maximumItems, 10));
  test("terminal historical LiteRT.js and Ray remain diagnostically blocked", () => {
    for (const item of ["LiteRT.js", "Ray 2.55"]) {
      assert.equal(diagnoseOfficialDraftEligibility({ state: "VERIFICATION_REJECTED", latestVerificationStatus: "CONFIRMED", latestVerificationIsCurrent: false, confirmedClaims: 1, draftExists: false }), "VERIFICATION_HISTORICAL_ONLY", item);
    }
  });
  test("application service blocks a fresh key for a non-verified aggregate", async () => {
    const news = createReceivedNews({ id: "blocked-news", source: { id: "official", name: "Official", url: "https://example.com", isOfficial: true }, title: "Blocked", originalUrl: "https://example.com/item", publishedAt: "2026-07-25T00:00:00.000Z", eventAt: "2026-07-25T00:00:00.000Z", receivedAt: "2026-07-25T00:00:00.000Z" });
    const service = new EditorialDraftWorkflowService({ loadContext: async () => ({ news, verification: { verificationId: "v", newsId: news.id, status: "CONFIRMED", editorialDecision: "ALLOW_DRAFT_GENERATION", confidence: 100, confidenceBreakdown: { claimCoverage: 100, authority: 100, dateQuality: 100, contradictionPenalty: 0 }, policyId: "p", policyVersion: "v1", evaluatedAt: news.receivedAt, claims: [], evidenceSummary: { total: 0, supporting: 0, contradicting: 0 }, warnings: [], blockingReasons: [] }, claims: [], evidence: [] }), executeAtomic: async () => { throw new Error("must not execute"); } });
    await assert.rejects(service.createDraft({ newsId: news.id, verificationId: "v", format: "LINKEDIN_SHORT_POST", idempotencyKey: "key", expectedVersion: 0, commandId: "command", approvalRequestId: "approval", actor: { type: "SYSTEM", id: "test" }, occurredAt: news.receivedAt }), (error) => error instanceof EditorialDraftWorkflowError && error.code === "EDITORIAL_DRAFT_NEWS_NOT_VERIFIED");
  });
  test("does not execute atomic persistence when structured generation fails", async () => {
    const baseNews = createReceivedNews({ id: "no-partial-llm", source: { id: "official", name: "Official", url: "https://example.com", isOfficial: true }, title: "Confirmed", originalUrl: "https://example.com/item", publishedAt: "2026-07-25T00:00:00.000Z", eventAt: "2026-07-25T00:00:00.000Z", receivedAt: "2026-07-25T00:00:00.000Z" });
    const news = { ...baseNews, state: "VERIFIED" as const };
    const claims = [{ id: "no-partial-claim", text: "Official announced the item.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "Item" }];
    const evidence = [{ id: "no-partial-evidence", claimId: claims[0]!.id, sourceId: "official", canonicalUrl: "https://example.com/item", sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: baseNews.receivedAt, eventDate: baseNews.eventAt, excerpt: "Official announced the item.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
    const verification = evaluateVerification({ verificationId: "no-partial-verification", newsId: news.id, claims, evidence, policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1, evaluatedAt: baseNews.receivedAt });
    let atomicCalls = 0;
    const service = new EditorialDraftWorkflowService({
      loadContext: async () => ({ news, verification, claims, evidence }),
      executeAtomic: async () => { atomicCalls += 1; throw new Error("must not persist"); },
    }, { generate: async () => { throw new EditorialGenerationDiagnosticError([{ stage: "INITIAL_GENERATION", attempt: 1, codes: ["INITIAL_SCHEMA_FAILED"], fields: ["subtitle"], parseResult: "SCHEMA_INVALID", durationMs: 5, callCount: 1 }]); } });
    await assert.rejects(service.createDraft({ newsId: news.id, verificationId: verification.verificationId, format: "WEBSITE_NEWS_BRIEF", idempotencyKey: "no-partial-key", expectedVersion: 0, commandId: "no-partial-command", approvalRequestId: "no-partial-approval", actor: { type: "SYSTEM", id: "test" }, occurredAt: baseNews.receivedAt }), (error) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EDITORIAL_DRAFT_GENERATION_FAILED" && "diagnostics" in error && (error as { diagnostics?: readonly { codes: readonly string[] }[] }).diagnostics?.[0]?.codes[0] === "INITIAL_SCHEMA_FAILED");
    assert.equal(atomicCalls, 0);
  });
  test("preserves a safe final-validation diagnostic when the generated body is blocked", async () => {
    const baseNews = createReceivedNews({ id: "final-validation-diagnostic", source: { id: "official", name: "Official", url: "https://example.com", isOfficial: true }, title: "Confirmed", originalUrl: "https://example.com/item", publishedAt: "2026-07-25T00:00:00.000Z", eventAt: "2026-07-25T00:00:00.000Z", receivedAt: "2026-07-25T00:00:00.000Z" });
    const news = { ...baseNews, state: "VERIFIED" as const };
    const claims = [{ id: "final-validation-claim", text: "Official announced the item.", type: "PRODUCT_LAUNCH" as const, importance: "PRIMARY" as const, expectedSubject: "Item" }];
    const evidence = [{ id: "final-validation-evidence", claimId: claims[0]!.id, sourceId: "official", canonicalUrl: "https://example.com/item", sourceAuthority: "PRIMARY_OFFICIAL" as const, evidenceType: "RELEASE_NOTE" as const, retrievedAt: baseNews.receivedAt, eventDate: baseNews.eventAt, excerpt: "Official announced the item.", structuredFacts: { announced: true }, supportsClaim: true, contradictsClaim: false }];
    const verification = evaluateVerification({ verificationId: "final-validation-verification", newsId: news.id, claims, evidence, policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1, evaluatedAt: baseNews.receivedAt });
    let atomicCalls = 0;
    const service = new EditorialDraftWorkflowService({
      loadContext: async () => ({ news, verification, claims, evidence }),
      executeAtomic: async () => { atomicCalls += 1; throw new Error("must not persist"); },
    }, { generate: async () => ({ title: "Item anunciado", subtitle: "Resumo factual.", body: "Item está em preview." }) });
    await assert.rejects(service.createDraft({ newsId: news.id, verificationId: verification.verificationId, format: "WEBSITE_NEWS_BRIEF", idempotencyKey: "final-validation-key", expectedVersion: 0, commandId: "final-validation-command", approvalRequestId: "final-validation-approval", actor: { type: "SYSTEM", id: "test" }, occurredAt: baseNews.receivedAt }), (error) => error instanceof EditorialDraftWorkflowError && error.code === "EDITORIAL_DRAFT_VALIDATION_FAILED" && error.diagnostics?.[0]?.stage === "FINAL_VALIDATION" && error.diagnostics?.[0]?.codes[0] === "UNSUPPORTED_QUALIFIER" && error.diagnostics?.[0]?.wordCount === 4);
    assert.equal(atomicCalls, 0);
  });
});
