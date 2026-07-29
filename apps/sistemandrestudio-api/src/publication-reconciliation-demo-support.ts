import type { PublicPublicationVerifier } from "../../../packages/application/src/index.ts";

export function simulatedPublicVerifier(): PublicPublicationVerifier {
  return {
    async verify(request) {
      return {
        verificationId:
          `demo-verification-${request.source.pkg.publicationId.slice(-20)}`,
        publicationPackageId: request.source.pkg.publicationId,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        status: "VERIFIED_WITH_WARNINGS",
        httpStatus: 200,
        finalUrl: request.publicUrl,
        canonicalUrl: request.canonicalUrl,
        contentFingerprint: "d".repeat(64),
        warnings: ["HOMEPAGE_LATEST_ARTICLE_OUTDATED"],
        checks: [
          {
            position: 0,
            code: "ARTICLE_CANONICAL",
            status: "PASS",
            expectedValue: request.canonicalUrl,
            observedSummary: "simulated canonical matched",
            metadata: { fixture: true },
          },
          {
            position: 1,
            code: "SITEMAP_ARTICLE_URL",
            status: "PASS",
            observedSummary: "simulated sitemap matched",
            metadata: { fixture: true },
          },
          {
            position: 2,
            code: "HOMEPAGE_LATEST_ARTICLE_OUTDATED",
            status: "WARN",
            observedSummary: "simulated home is not current",
            metadata: { fixture: true },
          },
        ],
      };
    },
  };
}
