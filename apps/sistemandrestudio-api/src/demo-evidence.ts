import {
  ANDRE_STUDIO_VERIFICATION_POLICY_V1,
  evaluateVerification,
} from "../../../packages/content-engine/src/index.ts";
import type {
  VerificationClaim,
} from "../../../packages/content-engine/src/index.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  buildEvidenceCandidates,
  extractOfficialPage,
} from "../../../packages/evidence/src/index.ts";
import {
  CHANGELOG_PAGE,
  CONTRADICTORY_PAGE,
  FIXTURE_TIME,
  OLD_UPDATED_PAGE,
  PROMOTIONAL_PAGE,
  SIMPLE_OFFICIAL_ARTICLE,
} from "../../../packages/evidence/test/fixtures.ts";

const scenarios = [
  {
    name: "artigo oficial fictício",
    body: SIMPLE_OFFICIAL_ARTICLE,
    url: "https://fixture.official.invalid/releases/orbit-2",
    claims: [launchClaim("launch")],
  },
  {
    name: "changelog fictício",
    body: CHANGELOG_PAGE,
    url: "https://fixture.official.invalid/changelog/orbit-2",
    claims: [{
      id: "claim-version",
      text: "Orbit version 2.0 was released.",
      type: "VERSION_RELEASE" as const,
      importance: "PRIMARY" as const,
      expectedSubject: "Orbit",
    }],
  },
  {
    name: "promoção sem prova",
    body: PROMOTIONAL_PAGE,
    url: "https://fixture.official.invalid/promo/orbit",
    claims: [{
      id: "claim-performance",
      text: "Orbit is twice as fast.",
      type: "PERFORMANCE_CLAIM" as const,
      importance: "PRIMARY" as const,
      expectedSubject: "Orbit",
    }],
  },
  {
    name: "contradição explícita",
    body: CONTRADICTORY_PAGE,
    url: "https://fixture.official.invalid/status/orbit",
    claims: [launchClaim("contradiction")],
  },
  {
    name: "evento antigo atualizado",
    body: OLD_UPDATED_PAGE,
    url: "https://fixture.official.invalid/releases/orbit-1",
    claims: [launchClaim("old")],
  },
] as const;

const reports = scenarios.map((scenario, index) => {
  const page = extractOfficialPage({
    requestedUrl: scenario.url,
    finalUrl: scenario.url,
    statusCode: 200,
    contentType: "text/html",
    responseBytes: Buffer.byteLength(scenario.body),
    redirectCount: 0,
    body: scenario.body,
    fetchedAt: FIXTURE_TIME,
  }, "PRIMARY_ARTICLE", DEFAULT_EVIDENCE_LIMITS);
  const candidates = buildEvidenceCandidates(
    "fixture-official-source",
    scenario.claims,
    [page],
    DEFAULT_EVIDENCE_LIMITS,
  );
  const result = evaluateVerification({
    verificationId: `fixture-verification-${index}`,
    newsId: `fixture-news-${index}`,
    claims: scenario.claims,
    evidence: candidates.map((candidate) => candidate.evidence),
    allowedSourceIds: ["fixture-official-source"],
    allowedSources: [{
      id: "fixture-official-source",
      allowedHosts: ["fixture.official.invalid"],
    }],
    policy: ANDRE_STUDIO_VERIFICATION_POLICY_V1,
    evaluatedAt: FIXTURE_TIME,
  });
  return {
    pagina: scenario.name,
    tipo: page.pageType,
    claims: scenario.claims.length,
    evidencias: candidates.length,
    status: result.status,
    confianca: result.confidence,
    decisao: result.editorialDecision,
  };
});

console.table(reports);

function launchClaim(suffix: string): VerificationClaim {
  return {
    id: `claim-launch-${suffix}`,
    text: "Acme launched Orbit.",
    type: "PRODUCT_LAUNCH",
    importance: "PRIMARY",
    expectedSubject: "Orbit",
  };
}
