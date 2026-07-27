import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HumanEditorialReviewError,
  HumanEditorialReviewService,
  InMemoryHumanReviewRepository,
  type EditorialReviewPackage,
} from "../packages/application/src/index.ts";
import {
  isAllowedLocalizedFactEquivalent,
  LOCALIZED_FACT_PREDICATES,
} from "../packages/content-engine/src/index.ts";

const sourceFact = "Grounding with Parallel was officially announced.";
const targetFact = "Grounding with Parallel foi anunciado oficialmente.";
const citation = {
  evidenceId: "e-localized",
  claimId: "c-localized",
  sourceId: "google-developers-blog",
  canonicalUrl: "https://developers.googleblog.com/grounding-with-parallel/",
  title: "Official announcement",
};
const warning = {
  code: "HUMAN_REVIEW_REQUIRED",
  message: "Preserve this warning.",
};
const brief = {
  briefId: "brief-localized",
  newsId: "news-localized",
  verificationId: "verification-localized",
  relevanceScore: 80,
  relevancePriority: "HIGH",
  verificationStatus: "CONFIRMED",
  editorialEligibility: "ALLOW_DRAFT",
  policyId: "policy",
  policyVersion: "policy-v1",
  createdAt: "2026-07-27T00:00:00.000Z",
  subject: { product: "Grounding with Parallel" },
  confirmedClaims: [],
  restrictedClaims: [],
  prohibitedClaims: [],
  evidenceReferences: [citation],
  sourceReferences: [citation],
  allowedFacts: [
    {
      factId: "fact-localized",
      claimId: "c-localized",
      statement: sourceFact,
      evidenceIds: ["e-localized"],
      confidence: 75,
      restrictions: [],
    },
  ],
  warnings: [warning],
  requiredDisclosures: [],
  prohibitedStatements: [],
  suggestedAngles: [],
  suggestedFormats: ["WEBSITE_NEWS_BRIEF"],
} as const;
const draft = {
  draftId: "draft-localized",
  newsId: "news-localized",
  briefId: "brief-localized",
  format: "WEBSITE_NEWS_BRIEF",
  language: "pt-BR",
  title: sourceFact,
  subtitle: "Resumo factual baseado em evidências oficiais.",
  body: `O que aconteceu ${sourceFact} Limitações Rascunho factual sujeito à revisão humana. Fontes ${citation.canonicalUrl}`,
  sourceCitations: [citation],
  warnings: [warning],
  prohibitedClaimsChecked: true,
  validationStatus: "VALID_WITH_WARNINGS",
  generatorId: "deterministic",
  generatorVersion: "v1",
  createdAt: "2026-07-27T00:00:00.000Z",
} as const;
const reviewPackage: EditorialReviewPackage = {
  draft,
  brief,
  allowedFacts: brief.allowedFacts,
  prohibitedStatements: [],
  evidenceReferences: [citation],
  citations: [citation],
  warnings: [warning],
  validation: {
    status: "VALID_WITH_WARNINGS",
    warnings: [warning],
    blockingReasons: [],
    prohibitedClaimsChecked: true,
  },
  versionHistory: [
    { version: 1, draftId: draft.draftId, createdAt: draft.createdAt },
  ],
  reviewHistory: [],
};

function localizedMatch(revisedText = targetFact) {
  return isAllowedLocalizedFactEquivalent({
    allowedFact: sourceFact,
    revisedText,
    sourceLanguage: "en",
    targetLanguage: "pt-BR",
  });
}

async function submitRevision(overrides: {
  title?: string;
  subtitle?: string;
  body?: string;
  package?: EditorialReviewPackage;
} = {}) {
  const repository = new InMemoryHumanReviewRepository([
    overrides.package ?? reviewPackage,
  ]);
  const service = new HumanEditorialReviewService(repository);
  await service.requestRevision({
    reviewId: "request-localized",
    draftId: draft.draftId,
    expectedDraftVersion: 1,
    expectedNewsVersion: 1,
    reviewerId: "andre-local",
    reason: "Traduzir",
    revisionInstructions: ["Traduzir somente o predicado."],
    reviewedAt: "2026-07-27T00:01:00.000Z",
    idempotencyKey: "request-localized",
  });
  const result = await service.submitRevision({
    draftId: draft.draftId,
    reviewerId: "andre-local",
    revision: {
      title: overrides.title ?? targetFact,
      subtitle: overrides.subtitle ?? draft.subtitle,
      body:
        overrides.body ??
        draft.body.replaceAll(sourceFact, targetFact),
      acknowledgedInstructions: ["Traduzir somente o predicado."],
    },
    reviewedAt: "2026-07-27T00:02:00.000Z",
    idempotencyKey: "revise-localized",
  });
  return { result, service };
}

describe("closed localized editorial fact equivalence", () => {
  it("accepts the canonical English to pt-BR announcement", () => {
    const result = localizedMatch();
    assert.equal(result.matched, true);
    assert.equal(result.entity, "Grounding with Parallel");
    assert.equal(result.targetPredicate, "foi anunciado oficialmente");
  });

  it("accepts a safe terminal punctuation difference", () => {
    assert.equal(localizedMatch(targetFact.slice(0, -1)).matched, true);
  });

  it("accepts safe repeated-space normalization", () => {
    assert.equal(
      localizedMatch("Grounding  with   Parallel foi anunciado oficialmente.")
        .matched,
      true,
    );
  });

  it("rejects an altered entity", () => {
    const result = localizedMatch(
      "Grounding with Search foi anunciado oficialmente.",
    );
    assert.equal(result.matched, false);
    assert.equal(
      result.rejectionCode,
      "EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH",
    );
  });

  it("rejects a partially removed entity", () => {
    const result = localizedMatch("Grounding foi anunciado oficialmente.");
    assert.equal(result.matched, false);
    assert.equal(
      result.rejectionCode,
      "EDITORIAL_REVIEW_LOCALIZED_ENTITY_MISMATCH",
    );
  });

  for (const unsupported of [
    "Grounding with Parallel foi lançado.",
    "Grounding with Parallel já está disponível.",
    "Grounding with Parallel está disponível para todos.",
  ]) {
    it(`rejects unsupported predicate: ${unsupported}`, () => {
      const result = localizedMatch(unsupported);
      assert.equal(result.matched, false);
      assert.equal(
        result.rejectionCode,
        "EDITORIAL_REVIEW_LOCALIZED_PREDICATE_UNSUPPORTED",
      );
    });
  }

  it("contains only the single registered predicate", () => {
    assert.equal(LOCALIZED_FACT_PREDICATES.length, 1);
    assert.deepEqual(LOCALIZED_FACT_PREDICATES[0]?.targetPredicates, [
      "foi anunciado oficialmente",
    ]);
  });

  it("is deterministic", () => {
    assert.deepEqual(localizedMatch(), localizedMatch());
  });

  it("does not read the real clock", () => {
    const originalNow = Date.now;
    Date.now = () => {
      throw new Error("clock access forbidden");
    };
    try {
      assert.equal(localizedMatch().matched, true);
    } finally {
      Date.now = originalNow;
    }
  });

  it("does not access the network", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("network access forbidden");
    };
    try {
      assert.equal(localizedMatch().matched, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts the localized revision and reports its method", async () => {
    const { result } = await submitRevision();
    assert.equal(result.state, "PENDING_APPROVAL");
    assert.equal(
      result.validation.factPreservationMethod,
      "LOCALIZED_EQUIVALENT",
    );
    assert.equal(
      result.validation.equivalenceId,
      "official-announcement-en-to-pt-br-v1",
    );
  });

  it("reports VERBATIM when the original fact remains", async () => {
    const { result } = await submitRevision({
      title: "Título revisado",
      body: draft.body,
    });
    assert.equal(result.validation.factPreservationMethod, "VERBATIM");
  });

  it("preserves citations and mandatory warnings", async () => {
    const { result, service } = await submitRevision();
    const recovered = await service.getReviewPackage(result.draft.draftId);
    assert.deepEqual(recovered?.citations, [citation]);
    assert.deepEqual(recovered?.warnings, [warning]);
  });

  it("requires persisted citations", async () => {
    const withoutCitations = {
      ...reviewPackage,
      citations: [],
      evidenceReferences: [],
      draft: { ...draft, sourceCitations: [] },
    };
    await assert.rejects(
      submitRevision({ package: withoutCitations }),
      (error: HumanEditorialReviewError) =>
        error.code === "EDITORIAL_REVIEW_CITATION_MISSING" ||
        error.code === "EDITORIAL_REVIEW_UNAUTHORIZED_URL",
    );
  });

  for (const [label, body, code] of [
    [
      "new number",
      `${draft.body.replaceAll(sourceFact, targetFact)} Crescimento de 20%.`,
      "EDITORIAL_REVIEW_UNSUPPORTED_VERSION",
    ],
    [
      "new date",
      `${draft.body.replaceAll(sourceFact, targetFact)} Em 2026-08-01.`,
      "EDITORIAL_REVIEW_UNSUPPORTED_DATE",
    ],
    [
      "new version",
      `${draft.body.replaceAll(sourceFact, targetFact)} Versão v2.0.`,
      "EDITORIAL_REVIEW_UNSUPPORTED_VERSION",
    ],
    [
      "new URL",
      `${draft.body.replaceAll(sourceFact, targetFact)} https://evil.example`,
      "EDITORIAL_REVIEW_UNAUTHORIZED_URL",
    ],
    [
      "comparison",
      `${draft.body.replaceAll(sourceFact, targetFact)} É superior a concorrentes.`,
      "EDITORIAL_REVIEW_PROHIBITED_FACT",
    ],
    [
      "commercial benefit",
      `${draft.body.replaceAll(sourceFact, targetFact)} Aumenta a receita.`,
      "EDITORIAL_REVIEW_PROHIBITED_FACT",
    ],
    [
      "additional fact",
      `${draft.body.replaceAll(sourceFact, targetFact)} Também integra outro produto.`,
      "EDITORIAL_REVIEW_PROHIBITED_FACT",
    ],
  ] as const) {
    it(`rejects ${label}`, async () => {
      await assert.rejects(
        submitRevision({ body }),
        (error: HumanEditorialReviewError) => error.code === code,
      );
    });
  }

  it("rejects sensationalism", async () => {
    await assert.rejects(
      submitRevision({ title: `${targetFact} Vai mudar tudo.` }),
      (error: HumanEditorialReviewError) =>
        error.code === "EDITORIAL_REVIEW_CERTAINTY_ESCALATION",
    );
  });

  it("rejects HTML", async () => {
    await assert.rejects(submitRevision({ title: `<b>${targetFact}</b>` }));
  });

  it("rejects scripts", async () => {
    await assert.rejects(
      submitRevision({ body: `<script>${targetFact}</script>` }),
    );
  });
});
