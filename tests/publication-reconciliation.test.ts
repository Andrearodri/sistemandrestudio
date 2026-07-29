import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  DeterministicPublicPublicationVerifier,
  InMemoryPublicationReconciliationRepository,
  LocalPublicationExporter,
  LocalWebsitePublicationPackageReader,
  PublicationReconciliationError,
  PublicationReconciliationService,
  SafePublicPublicationHttpClient,
  buildPublicationPackage,
  reconciliationIdempotencyKey,
  type PublicationContext,
  type PublicPublicationVerification,
  type PublicPublicationVerifier,
  type ReconciliationSource,
} from "../packages/application/src/index.ts";

const roots: string[] = [];
const now = "2026-07-28T12:00:00.000Z";
const base = "https://andrestudio.dev.br";
const articleUrl =
  `${base}/blog/orbit-2-0-foi-anunciado-oficialmente/`;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("safe public publication verification", () => {
  test("verifies a complete public article with non-blocking warnings", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier().verify(input(fixture.source));
    assert.equal(verification.status, "VERIFIED_WITH_WARNINGS");
    assert.deepEqual(verification.warnings, [
      "PUBLIC_ARTICLE_CONTAINS_DRAFT_LANGUAGE",
      "HOMEPAGE_LATEST_ARTICLE_OUTDATED",
    ]);
    assert.equal(check(verification, "ARTICLE_CANONICAL"), "PASS");
    assert.equal(check(verification, "ARTICLE_JSON_LD"), "PASS");
    assert.equal(check(verification, "BREADCRUMB_JSON_LD"), "PASS");
    assert.equal(check(verification, "SITEMAP_ARTICLE_URL"), "PASS");
  });

  test("returns VERIFIED when the home is current and draft language is absent", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({
      homeCurrent: true,
      draftLanguage: false,
    }).verify(input(fixture.source));
    assert.equal(verification.status, "VERIFIED");
    assert.deepEqual(verification.warnings, []);
  });

  test("confirms the apex domain through the www document canonical", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({ wwwDocumentCanonical: true }).verify(
      input(fixture.source),
    );
    assert.equal(check(verification, "CANONICAL_DOMAIN_CONFIRMED"), "PASS");
    assert.notEqual(verification.status, "FAILED");
  });

  test("is deterministic for the same public bytes", async () => {
    const fixture = await sourceFixture();
    const publicVerifier = verifier();
    const left = await publicVerifier.verify(input(fixture.source));
    const right = await publicVerifier.verify(input(fixture.source));
    assert.equal(left.verificationId, right.verificationId);
    assert.equal(left.contentFingerprint, right.contentFingerprint);
    assert.deepEqual(left.checks, right.checks);
  });

  for (const [name, mutate, expectedCode] of [
    ["article title", { wrongTitle: true }, "ARTICLE_TITLE"],
    ["canonical", { wrongCanonical: true }, "ARTICLE_CANONICAL"],
    ["official citation", { missingSource: true }, "ARTICLE_OFFICIAL_SOURCE"],
    ["Article JSON-LD", { missingArticleJsonLd: true }, "ARTICLE_JSON_LD"],
    ["breadcrumb JSON-LD", { missingBreadcrumb: true }, "BREADCRUMB_JSON_LD"],
    ["blog link", { missingBlogLink: true }, "BLOG_ARTICLE_LINK"],
    ["sitemap URL", { missingSitemap: true }, "SITEMAP_ARTICLE_URL"],
    ["previous articles", { missingPrevious: true }, "BLOG_PREVIOUS_ARTICLES"],
  ] as const) {
    test(`fails when ${name} is invalid`, async () => {
      const fixture = await sourceFixture();
      const verification = await verifier(mutate).verify(input(fixture.source));
      assert.equal(verification.status, "FAILED");
      assert.equal(check(verification, expectedCode), "FAIL");
    });
  }

  test("fails safely on an article HTTP error", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({ articleStatus: 404 }).verify(
      input(fixture.source),
    );
    assert.equal(verification.status, "FAILED");
    assert.equal(check(verification, "ARTICLE_REACHABLE"), "FAIL");
  });

  test("fails safely on an unexpected article content type", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({ articleContentType: "image/png" })
      .verify(input(fixture.source));
    assert.equal(verification.status, "FAILED");
    assert.equal(check(verification, "ARTICLE_REACHABLE"), "FAIL");
  });

  test("fails safely when a response exceeds the configured limit", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({ oversizedArticle: true }).verify(
      input(fixture.source),
    );
    assert.equal(verification.status, "FAILED");
    assert.equal(check(verification, "ARTICLE_REACHABLE"), "FAIL");
  });

  test("rejects private DNS destinations before fetch", async () => {
    const fixture = await sourceFixture();
    let calls = 0;
    const client = new SafePublicPublicationHttpClient(
      async () => {
        calls += 1;
        return response("ok", "text/html");
      },
      async () => [{ address: "127.0.0.1" }],
    );
    await assert.rejects(
      client.fetchText(articleUrl, "HTML"),
      code("PUBLICATION_PUBLIC_DESTINATION_BLOCKED"),
    );
    assert.equal(calls, 0);
    assert.equal(fixture.source.pkg.status, "READY_FOR_PUBLICATION");
  });

  test("blocks a redirect outside the host allow-list", async () => {
    const client = new SafePublicPublicationHttpClient(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/private" },
        }),
      publicDns,
    );
    await assert.rejects(
      client.fetchText(articleUrl, "HTML"),
      code("PUBLICATION_PUBLIC_DESTINATION_BLOCKED"),
    );
  });

  test("blocks excessive redirects", async () => {
    const client = new SafePublicPublicationHttpClient(
      async (url) =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              `${base}/redirect-${new URL(String(url)).pathname.length}`,
          },
        }),
      publicDns,
    );
    await assert.rejects(
      client.fetchText(articleUrl, "HTML"),
      code("PUBLICATION_PUBLIC_REDIRECT_BLOCKED"),
    );
  });

  for (const invalidUrl of [
    "http://andrestudio.dev.br/blog/x/",
    "https://andrestudiodev.duckdns.org/blog/x/",
    "https://user:secret@andrestudio.dev.br/blog/x/",
    "https://andrestudio.dev.br:444/blog/x/",
  ]) {
    test(`blocks unsafe URL ${new URL(invalidUrl).protocol}//${new URL(invalidUrl).hostname}`, async () => {
      const client = new SafePublicPublicationHttpClient(
        async () => response("never", "text/html"),
        publicDns,
      );
      await assert.rejects(
        client.fetchText(invalidUrl, "HTML"),
        code("PUBLICATION_PUBLIC_DESTINATION_BLOCKED"),
      );
    });
  }

  test("fails when an Open Graph image is unreachable", async () => {
    const fixture = await sourceFixture();
    const verification = await verifier({ imageStatus: 404 }).verify(
      input(fixture.source),
    );
    assert.equal(verification.status, "FAILED");
    assert.equal(check(verification, "OPEN_GRAPH_IMAGE_REACHABLE"), "FAIL");
  });
});

describe("publication reconciliation service", () => {
  test("lists only ready website publication packages", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
      {
        ...fixture.source,
        pkg: {
          ...fixture.source.pkg,
          publicationId: "not-ready",
          status: "PUBLISHED",
        },
      },
    ]);
    assert.equal((await repo.listReadyForReconciliation()).length, 1);
  });

  test("verifies without changing state", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
    ]);
    const service = serviceFor(fixture, repo);
    const result = await service.verifyPublicPublication({
      publicationId: fixture.source.pkg.publicationId,
      publicUrl: articleUrl,
    });
    assert.equal(result.status, "VERIFIED_WITH_WARNINGS");
    assert.equal((await repo.listReadyForReconciliation()).length, 1);
    assert.equal((await repo.list()).length, 0);
  });

  test("reconciles a supervised manual deployment and marks it published", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
    ]);
    const result = await serviceFor(fixture, repo)
      .reconcileExternalPublication(reconcileInput(fixture.source));
    assert.equal(result.replayed, false);
    assert.equal(result.reconciliation.previousState, "READY_FOR_PUBLICATION");
    assert.equal(result.reconciliation.finalState, "PUBLISHED");
    assert.equal(
      result.reconciliation.executionOrigin,
      "MANUAL_SUPERVISED_DEPLOY",
    );
    assert.equal((await repo.listReadyForReconciliation()).length, 0);
  });

  test("replays the same reconciliation without verifying again", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
    ]);
    let calls = 0;
    const service = serviceFor(fixture, repo, {
      async verify(request) {
        calls += 1;
        return verifier().verify(request);
      },
    });
    const request = reconcileInput(fixture.source);
    const first = await service.reconcileExternalPublication(request);
    const replay = await service.reconcileExternalPublication(request);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
    assert.equal((await repo.list()).length, 1);
  });

  test("rejects an idempotency key reused with another URL", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
    ]);
    const service = serviceFor(fixture, repo);
    const request = reconcileInput(fixture.source);
    await service.reconcileExternalPublication(request);
    await assert.rejects(
      service.reconcileExternalPublication({
        ...request,
        publicUrl: `https://www.andrestudio.dev.br${
          new URL(articleUrl).pathname
        }`,
      }),
      code("PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT"),
    );
  });

  test("blocks system-executed origin", async () => {
    const fixture = await sourceFixture();
    const service = serviceFor(
      fixture,
      new InMemoryPublicationReconciliationRepository([fixture.source]),
    );
    await assert.rejects(
      service.reconcileExternalPublication({
        ...reconcileInput(fixture.source),
        origin: "SYSTEM_EXECUTED",
      }),
      code("PUBLICATION_RECONCILIATION_ORIGIN_INVALID"),
    );
  });

  test("blocks an incompatible draft", async () => {
    const fixture = await sourceFixture();
    const service = serviceFor(
      fixture,
      new InMemoryPublicationReconciliationRepository([fixture.source]),
    );
    await assert.rejects(
      service.reconcileExternalPublication({
        ...reconcileInput(fixture.source),
        draftId: "different-draft",
      }),
      code("PUBLICATION_RECONCILIATION_PACKAGE_INVALID"),
    );
  });

  test("blocks FAILED verification with no reconciliation", async () => {
    const fixture = await sourceFixture();
    const repo = new InMemoryPublicationReconciliationRepository([
      fixture.source,
    ]);
    const service = serviceFor(fixture, repo, {
      async verify(request) {
        return {
          ...(await verifier().verify(request)),
          status: "FAILED",
        };
      },
    });
    await assert.rejects(
      service.reconcileExternalPublication(reconcileInput(fixture.source)),
      code("PUBLICATION_PUBLIC_VERIFICATION_FAILED"),
    );
    assert.equal((await repo.list()).length, 0);
    assert.equal((await repo.listReadyForReconciliation()).length, 1);
  });

  test("records that confirmation time is not original deployment time", async () => {
    const fixture = await sourceFixture();
    const result = await serviceFor(
      fixture,
      new InMemoryPublicationReconciliationRepository([fixture.source]),
    ).reconcileExternalPublication(reconcileInput(fixture.source));
    assert.ok(
      result.reconciliation.warnings.includes(
        "CONFIRMATION_TIME_NOT_ORIGINAL_DEPLOY_TIME",
      ),
    );
  });

  test("accepts an explicit confirmation time without that warning", async () => {
    const fixture = await sourceFixture();
    const result = await serviceFor(
      fixture,
      new InMemoryPublicationReconciliationRepository([fixture.source]),
    ).reconcileExternalPublication({
      ...reconcileInput(fixture.source),
      confirmedAt: "2026-07-27T20:00:00.000Z",
    });
    assert.ok(
      !result.reconciliation.warnings.includes(
        "CONFIRMATION_TIME_NOT_ORIGINAL_DEPLOY_TIME",
      ),
    );
  });

  test("rejects a tampered exported file before public verification", async () => {
    const fixture = await sourceFixture();
    const markdown = fixture.source.files.find((file) =>
      file.role === "CONTENT_MARKDOWN"
    )!;
    await writeFile(join(fixture.root, markdown.relativePath), "tampered");
    let calls = 0;
    const service = serviceFor(
      fixture,
      new InMemoryPublicationReconciliationRepository([fixture.source]),
      {
        async verify(request) {
          calls += 1;
          return verifier().verify(request);
        },
      },
    );
    await assert.rejects(
      service.reconcileExternalPublication(reconcileInput(fixture.source)),
    );
    assert.equal(calls, 0);
  });
});

async function sourceFixture(): Promise<{
  readonly root: string;
  readonly source: ReconciliationSource;
}> {
  const context: PublicationContext = {
    newsId: "news-orbit",
    newsVersion: 7,
    newsState: "APPROVED",
    draftVersion: 2,
    approvalDecisionId: "approval-orbit",
    reviewerId: "andre-local",
    approvedAt: "2026-07-27T10:00:00.000Z",
    draft: {
      draftId: "draft-orbit-v2",
      newsId: "news-orbit",
      briefId: "brief-orbit",
      format: "WEBSITE_NEWS_BRIEF",
      language: "pt-BR",
      title: "Orbit 2.0 foi anunciado oficialmente",
      subtitle: "Resumo factual",
      body: "Orbit 2.0 foi anunciado oficialmente.",
      sourceCitations: [{
        evidenceId: "evidence-orbit",
        claimId: "claim-orbit",
        sourceId: "official-orbit",
        canonicalUrl: "https://official.example/orbit",
        title: "Anúncio oficial",
      }],
      warnings: [],
      prohibitedClaimsChecked: true,
      validationStatus: "VALID",
      generatorId: "fixture",
      generatorVersion: "v1",
      createdAt: "2026-07-27T09:00:00.000Z",
    },
  };
  const root = await mkdtemp(join(tmpdir(), "publication-reconciliation-"));
  roots.push(root);
  const pkg = buildPublicationPackage(
    context,
    "WEBSITE_EXPORT",
    "2026-07-27T11:00:00.000Z",
  );
  const exported = await new LocalPublicationExporter(root).export(pkg);
  return {
    root,
    source: {
      pkg: {
        ...pkg,
        slug: "orbit-2-0-foi-anunciado-oficialmente",
        status: "READY_FOR_PUBLICATION",
      },
      files: exported.files.map(({ content: _content, ...file }) => file),
    },
  };
}

function serviceFor(
  fixture: { readonly root: string; readonly source: ReconciliationSource },
  repo: InMemoryPublicationReconciliationRepository,
  publicVerifier: PublicPublicationVerifier = verifier(),
) {
  return new PublicationReconciliationService(
    repo,
    publicVerifier,
    new LocalWebsitePublicationPackageReader(fixture.root),
    () => now,
  );
}

function reconcileInput(source: ReconciliationSource) {
  const identity = {
    publicationId: source.pkg.publicationId,
    draftId: source.pkg.draftId,
    operatorId: "andre-local",
    origin: "MANUAL_SUPERVISED_DEPLOY" as const,
    publicUrl: articleUrl,
    canonicalUrl: articleUrl,
    websiteCommit: "7ea0d4a",
  };
  const key = reconciliationIdempotencyKey(identity);
  return {
    ...identity,
    deploymentTarget: "EC2 Docker Nginx static website",
    idempotencyKey: key,
    commandId: key,
  };
}

function input(source: ReconciliationSource) {
  return {
    source,
    publicUrl: articleUrl,
    canonicalUrl: articleUrl,
    startedAt: now,
    completedAt: now,
  };
}

interface PageOptions {
  readonly homeCurrent?: boolean;
  readonly draftLanguage?: boolean;
  readonly wrongTitle?: boolean;
  readonly wrongCanonical?: boolean;
  readonly missingSource?: boolean;
  readonly missingArticleJsonLd?: boolean;
  readonly missingBreadcrumb?: boolean;
  readonly missingBlogLink?: boolean;
  readonly missingSitemap?: boolean;
  readonly missingPrevious?: boolean;
  readonly articleStatus?: number;
  readonly articleContentType?: string;
  readonly oversizedArticle?: boolean;
  readonly imageStatus?: number;
  readonly wwwDocumentCanonical?: boolean;
}

function verifier(options: PageOptions = {}) {
  const fetchImplementation: typeof globalThis.fetch = async (
    value,
    request,
  ) => {
    const url = new URL(String(value));
    if (url.hostname === "www.andrestudio.dev.br") {
      if (options.wwwDocumentCanonical) {
        return response(
          `<html><head><link rel="canonical" href="${base}/"></head></html>`,
          "text/html",
        );
      }
      return new Response(null, {
        status: 301,
        headers: { location: `${base}/` },
      });
    }
    if (request?.method === "HEAD") {
      return response("", "image/png", options.imageStatus ?? 200);
    }
    if (url.pathname === "/") {
      return response(
        `<html><body>${
          options.homeCurrent ? `<a href="${articleUrl}">novo</a>` : "home"
        }</body></html>`,
        "text/html",
      );
    }
    if (url.pathname === "/blog/") {
      return response(
        `<html><body>
          <a href="${
          options.missingBlogLink ? "/blog/missing/" : articleUrl
        }">Orbit 2.0 foi anunciado oficialmente</a>
          ${
          options.missingPrevious
            ? ""
            : `<a href="/blog/google-gemini-3-6-flash/">anterior</a>
               <a href="/blog/como-preparar-material-para-edicao-de-video/">anterior</a>`
        }
        </body></html>`,
        "text/html",
      );
    }
    if (url.pathname === "/sitemap.xml") {
      return response(
        `<?xml version="1.0"?><urlset><url><loc>${
          options.missingSitemap ? `${base}/blog/missing/` : articleUrl
        }</loc></url></urlset>`,
        "application/xml",
      );
    }
    if (url.pathname === "/robots.txt") {
      return response(`Sitemap: ${base}/sitemap.xml`, "text/plain");
    }
    if (url.pathname === "/assets/og.png") {
      return response("", "image/png");
    }
    if (url.pathname === new URL(articleUrl).pathname) {
      const title = options.wrongTitle
        ? "Outro conteúdo"
        : "Orbit 2.0 foi anunciado oficialmente";
      const canonical = options.wrongCanonical
        ? `${base}/blog/outra-rota/`
        : articleUrl;
      const source = options.missingSource
        ? ""
        : `<a href="https://official.example/orbit">Fonte oficial</a>`;
      const json = [
        ...(options.missingArticleJsonLd
          ? []
          : [{ "@type": "Article", headline: title }]),
        ...(options.missingBreadcrumb
          ? []
          : [{ "@type": "BreadcrumbList", itemListElement: [] }]),
      ];
      const html = `<html lang="pt-BR"><head>
        <title>${title} | AndréStudio.dev</title>
        <link rel="canonical" href="${canonical}">
        <meta name="description" content="Resumo factual">
        <meta name="author" content="André Rodrigues">
        <meta property="og:site_name" content="AndréStudio.dev">
        <meta property="og:image" content="${base}/assets/og.png">
        <meta property="article:published_time" content="2026-07-27T20:00:00Z">
        <meta property="article:section" content="Tecnologia">
        <script type="application/ld+json">${JSON.stringify(json)}</script>
        </head><body>${source}${
        options.draftLanguage === false ? "" : "Sujeito à revisão humana."
      }</body></html>`;
      return response(
        options.oversizedArticle ? "x" : html,
        options.articleContentType ?? "text/html",
        options.articleStatus ?? 200,
        options.oversizedArticle ? 1_000_001 : undefined,
      );
    }
    return response("not found", "text/plain", 404);
  };
  return new DeterministicPublicPublicationVerifier(
    new SafePublicPublicationHttpClient(fetchImplementation, publicDns),
  );
}

function response(
  body: string,
  contentType: string,
  status = 200,
  declaredLength?: number,
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      date: "Tue, 28 Jul 2026 12:00:00 GMT",
      ...(declaredLength === undefined
        ? {}
        : { "content-length": String(declaredLength) }),
    },
  });
}

async function publicDns() {
  return [{ address: "8.8.8.8" }] as const;
}

function check(
  verification: PublicPublicationVerification,
  name: string,
): string | undefined {
  return verification.checks.find((item) => item.code === name)?.status;
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof PublicationReconciliationError &&
    error.code === expected;
}
