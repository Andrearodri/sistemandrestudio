import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  VerificationClaim,
} from "../../content-engine/src/index.ts";
import {
  getOfficialSource,
} from "../../sources/src/index.ts";
import type {
  OfficialPagePolicyDefinition,
} from "../../sources/src/index.ts";
import {
  DEFAULT_EVIDENCE_LIMITS,
  EvidenceAcquisitionError,
  OfficialEvidenceAcquisitionService,
  OfficialPageClient,
  buildEvidenceCandidates,
  classifyOfficialPage,
  deriveEvidenceContentIdentity,
  extractOfficialPage,
  isForbiddenAddress,
  selectOperationalEvidenceItems,
} from "../src/index.ts";
import type {
  EvidenceAcquisitionRepository,
  EvidenceAcquisitionResult,
  OfficialPageFetch,
  PreparedEvidenceAcquisition,
  StoredRadarItem,
} from "../src/index.ts";
import {
  CHANGELOG_PAGE,
  CONTRADICTORY_PAGE,
  FIXTURE_TIME,
  INVALID_JSON_LD_PAGE,
  JAVASCRIPT_REQUIRED_PAGE,
  OLD_UPDATED_PAGE,
  OFFICIAL_DOCUMENTATION,
  PROMOTIONAL_PAGE,
  PROMPT_INJECTION_PAGE,
  SIMPLE_OFFICIAL_ARTICLE,
} from "./fixtures.ts";

const policy: OfficialPagePolicyDefinition = {
  version: "official-page-policy-v1",
  entryHosts: ["official.example"],
  redirectHosts: ["official.example", "docs.official.example"],
  additionalOfficialHosts: ["docs.official.example"],
  allowedPathPrefixes: ["/"],
  blockedPathPrefixes: ["/login", "/search"],
  maxPagesPerItem: 3,
  maxRelatedPages: 2,
  maxDepth: 1,
};
const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("OfficialPageClient security boundary", () => {
  test("accepts a bounded HTTPS page on the explicit entry host", async () => {
    const client = clientReturning(SIMPLE_OFFICIAL_ARTICLE);
    const page = await client.fetchPage(
      "https://official.example/releases/orbit-2",
      policy,
      DEFAULT_EVIDENCE_LIMITS,
      FIXTURE_TIME,
    );
    assert.equal(page.statusCode, 200);
    assert.equal(page.redirectCount, 0);
  });

  test("rejects arbitrary hosts, HTTP, credentials and blocked paths", async () => {
    const client = clientReturning(SIMPLE_OFFICIAL_ARTICLE);
    for (const url of [
      "https://external.example/item",
      "http://official.example/item",
      "https://user:secret@official.example/item",
      "https://official.example/login",
    ]) {
      await assert.rejects(
        client.fetchPage(url, policy, DEFAULT_EVIDENCE_LIMITS, FIXTURE_TIME),
        EvidenceAcquisitionError,
      );
    }
  });

  test("rejects non-standard ports", async () => {
    await assert.rejects(
      clientReturning(SIMPLE_OFFICIAL_ARTICLE).fetchPage(
        "https://official.example:8443/item",
        policy,
        DEFAULT_EVIDENCE_LIMITS,
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_NOT_ALLOWED",
    );
  });

  test("rejects localhost, private, reserved and encoded addresses", () => {
    for (const address of [
      "localhost", "127.0.0.1", "10.0.0.1", "172.16.0.1",
      "192.168.0.1", "169.254.1.1", "0.0.0.0", "::1", "fd00::1",
      "fe80::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1",
      "192.0.2.1", "192.88.99.1", "198.51.100.1", "203.0.113.1",
    ]) {
      assert.equal(isForbiddenAddress(address), true, address);
    }
    assert.equal(isForbiddenAddress("192.0.66.2"), false);
  });

  test("rejects a permitted hostname resolving to a private address", async () => {
    const client = new OfficialPageClient(
      fetchOk(SIMPLE_OFFICIAL_ARTICLE),
      async () => [{ address: "10.0.0.7" }],
    );
    await assert.rejects(
      client.fetchPage(
        "https://official.example/item",
        policy,
        DEFAULT_EVIDENCE_LIMITS,
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_PRIVATE_ADDRESS",
    );
  });

  test("follows an explicitly allowed redirect", async () => {
    let calls = 0;
    const client = new OfficialPageClient(
      (async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, {
              status: 302,
              headers: {
                location: "https://docs.official.example/orbit",
              },
            })
          : htmlResponse(OFFICIAL_DOCUMENTATION);
      }) as typeof fetch,
      publicResolver,
    );
    const result = await client.fetchPage(
      "https://official.example/item",
      policy,
      DEFAULT_EVIDENCE_LIMITS,
      FIXTURE_TIME,
    );
    assert.equal(result.finalUrl, "https://docs.official.example/orbit");
    assert.equal(result.redirectCount, 1);
  });

  test("rejects redirect to an unregistered domain", async () => {
    const client = new OfficialPageClient(
      (async () => new Response(null, {
        status: 302,
        headers: { location: "https://external.example/item" },
      })) as typeof fetch,
      publicResolver,
    );
    await assert.rejects(
      client.fetchPage(
        "https://official.example/item",
        policy,
        DEFAULT_EVIDENCE_LIMITS,
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED",
    );
  });

  test("rejects binary content types", async () => {
    const client = new OfficialPageClient(
      (async () => new Response("binary", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      })) as typeof fetch,
      publicResolver,
    );
    await assert.rejects(
      client.fetchPage(
        "https://official.example/item",
        policy,
        DEFAULT_EVIDENCE_LIMITS,
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_CONTENT_TYPE_NOT_ALLOWED",
    );
  });

  test("rejects declared and streamed oversized content", async () => {
    const declared = new OfficialPageClient(
      (async () => new Response("small", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-length": "1000001",
        },
      })) as typeof fetch,
      publicResolver,
    );
    await assert.rejects(
      declared.fetchPage(
        "https://official.example/item",
        policy,
        DEFAULT_EVIDENCE_LIMITS,
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_TOO_LARGE",
    );

    const streamed = clientReturning("x".repeat(101));
    await assert.rejects(
      streamed.fetchPage(
        "https://official.example/item",
        policy,
        { ...DEFAULT_EVIDENCE_LIMITS, maxResponseBytes: 100 },
        FIXTURE_TIME,
      ),
      EvidenceAcquisitionError,
    );
  });

  test("returns a stable timeout/network error", async () => {
    const client = new OfficialPageClient(
      (async () => {
        throw new Error("network");
      }) as typeof fetch,
      publicResolver,
    );
    await assert.rejects(
      client.fetchPage(
        "https://official.example/item",
        policy,
        { ...DEFAULT_EVIDENCE_LIMITS, maxRetries: 0 },
        FIXTURE_TIME,
      ),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_TIMEOUT",
    );
  });
});

describe("static official page extraction", () => {
  test("extracts bounded metadata, dates, headings and text", () => {
    const page = extract(SIMPLE_OFFICIAL_ARTICLE);
    assert.equal(page.title, "Acme launches Orbit 2.0");
    assert.equal(page.metadata.publishedAt, "2026-07-24T10:00:00.000Z");
    assert.equal(page.metadata.updatedAt, "2026-07-24T11:00:00.000Z");
    assert.equal(page.metadata.version, "2.0");
    assert.equal(page.metadata.openGraph["og:site_name"], "Acme");
    assert.equal(page.metadata.twitter["twitter:card"], "summary");
    assert.ok(page.headings.includes("What changed"));
    assert.equal(page.minimalText.includes("Unrelated navigation"), false);
    assert.equal(page.minimalText.includes("Repeated footer"), false);
  });

  test("keeps canonical metadata as data but trusts fetched URL as origin", () => {
    const page = extract(SIMPLE_OFFICIAL_ARTICLE);
    assert.equal(
      page.metadata.canonicalUrl,
      "https://official.example/releases/orbit-2",
    );
    assert.equal(page.canonicalUrl, "https://official.example/item");
  });

  test("extracts safe JSON-LD and ignores invalid JSON-LD", () => {
    assert.equal(extract(SIMPLE_OFFICIAL_ARTICLE).metadata.jsonLd.length, 1);
    assert.equal(extract(INVALID_JSON_LD_PAGE).metadata.jsonLd.length, 0);
    assert.equal(extract(INVALID_JSON_LD_PAGE).title, "Orbit 2.0 release notes");
  });

  test("detects a page requiring JavaScript", () => {
    assert.throws(
      () => extract(JAVASCRIPT_REQUIRED_PAGE),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_JAVASCRIPT_REQUIRED",
    );
  });

  test("classifies deterministic page types", () => {
    assert.equal(
      extract(SIMPLE_OFFICIAL_ARTICLE).pageType,
      "OFFICIAL_BLOG_POST",
    );
    assert.equal(
      extract(CHANGELOG_PAGE, "https://official.example/changelog").pageType,
      "OFFICIAL_CHANGELOG",
    );
    assert.equal(
      extract(
        OFFICIAL_DOCUMENTATION,
        "https://docs.official.example/reference",
      ).pageType,
      "OFFICIAL_DOCUMENTATION",
    );
    assert.equal(
      classifyOfficialPage(
        "https://official.example/security/CVE-2026-1234",
        "Security advisory",
        [],
        emptyMetadata(),
      ),
      "OFFICIAL_SECURITY_ADVISORY",
    );
    assert.equal(
      classifyOfficialPage(
        "https://official.example/blog/community",
        "A milestone built by the community",
        ["Security", "Company", "Resources"],
        { ...emptyMetadata(), articleType: "BlogPosting" },
      ),
      "OFFICIAL_BLOG_POST",
    );
  });

  test("discovers only directly related typed links", () => {
    const page = extract(SIMPLE_OFFICIAL_ARTICLE);
    assert.deepEqual(page.relatedLinks, [{
      url: "https://docs.official.example/orbit/2.0",
      relationship: "OFFICIAL_DOCUMENTATION",
    }]);
  });

  test("produces the same hash for the same bounded content", () => {
    assert.equal(
      extract(SIMPLE_OFFICIAL_ARTICLE).contentHash,
      extract(SIMPLE_OFFICIAL_ARTICLE).contentHash,
    );
    assert.notEqual(
      extract(SIMPLE_OFFICIAL_ARTICLE).contentHash,
      extract(SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally"))
        .contentHash,
    );
  });
});

describe("deterministic evidence association", () => {
  test("supports a product launch with official language and date", () => {
    const candidates = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(SIMPLE_OFFICIAL_ARTICLE)],
      DEFAULT_EVIDENCE_LIMITS,
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.evidence.supportsClaim, true);
    assert.equal(
      candidates[0]?.associationRule,
      "OFFICIAL_LAUNCH_LANGUAGE_WITH_DATE",
    );
  });

  test("supports a matching version from a changelog", () => {
    const candidates = buildEvidenceCandidates(
      "fixture-source",
      [{
        id: "claim-version",
        text: "Orbit version 2.0 was released.",
        type: "VERSION_RELEASE",
        importance: "PRIMARY",
        expectedSubject: "Orbit",
      }],
      [extract(CHANGELOG_PAGE, "https://official.example/changelog")],
      DEFAULT_EVIDENCE_LIMITS,
    );
    assert.equal(candidates[0]?.evidence.supportsClaim, true);
    assert.equal(candidates[0]?.evidence.sourceAuthority, "OFFICIAL_CHANGELOG");
  });

  test("does not confirm promotional performance language", () => {
    const candidates = buildEvidenceCandidates(
      "fixture-source",
      [{
        id: "claim-performance",
        text: "Orbit is twice as fast.",
        type: "PERFORMANCE_CLAIM",
        importance: "PRIMARY",
        expectedSubject: "Orbit",
      }],
      [extract(PROMOTIONAL_PAGE)],
      DEFAULT_EVIDENCE_LIMITS,
    );
    assert.equal(candidates.length, 0);
  });

  test("requires metric and methodology for performance", () => {
    const page = extract(PROMOTIONAL_PAGE.replace(
      "amazing, revolutionary and unmatched performance.",
      "a measured 2x result using a documented benchmark methodology.",
    ));
    const candidates = buildEvidenceCandidates(
      "fixture-source",
      [{
        id: "claim-performance",
        text: "Orbit reaches a measured 2x result.",
        type: "PERFORMANCE_CLAIM",
        importance: "PRIMARY",
        expectedSubject: "Orbit",
      }],
      [page],
      DEFAULT_EVIDENCE_LIMITS,
    );
    assert.equal(candidates[0]?.evidence.supportsClaim, true);
  });

  test("detects only explicit contradictions", () => {
    const candidates = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(CONTRADICTORY_PAGE)],
      DEFAULT_EVIDENCE_LIMITS,
    );
    assert.equal(candidates[0]?.evidence.contradictsClaim, true);
    assert.equal(candidates[0]?.evidence.supportsClaim, false);
  });

  test("preserves the old event date despite a recent update", () => {
    const candidate = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(OLD_UPDATED_PAGE)],
      DEFAULT_EVIDENCE_LIMITS,
    )[0];
    assert.equal(
      candidate?.evidence.eventDate,
      "2024-01-01T10:00:00.000Z",
    );
    assert.equal(
      candidate?.evidence.updatedAt,
      "2026-07-24T10:00:00.000Z",
    );
  });

  test("treats prompt injection as inert excerpt data", () => {
    const candidate = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(PROMPT_INJECTION_PAGE)],
      DEFAULT_EVIDENCE_LIMITS,
    )[0];
    assert.equal(candidate?.evidence.supportsClaim, true);
    assert.equal(candidate?.evidence.structuredFacts["pageType"], "OFFICIAL_RELEASE");
  });

  test("is deterministic and obeys candidate/excerpt limits", () => {
    const first = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(SIMPLE_OFFICIAL_ARTICLE)],
      { ...DEFAULT_EVIDENCE_LIMITS, maxExcerptLength: 40 },
    );
    const second = buildEvidenceCandidates(
      "fixture-source",
      [launchClaim()],
      [extract(SIMPLE_OFFICIAL_ARTICLE)],
      { ...DEFAULT_EVIDENCE_LIMITS, maxExcerptLength: 40 },
    );
    assert.deepEqual(first, second);
    assert.ok((first[0]?.evidence.excerpt?.length ?? 0) <= 40);
  });
});

describe("OfficialEvidenceAcquisitionService", () => {
  test("acquires a stored item and produces a confirmed factual result", async () => {
    const repository = new MemoryAcquisitionRepository();
    const service = new OfficialEvidenceAcquisitionService(
      repository,
      new OfficialPageClient(
        fetchOk(SIMPLE_OFFICIAL_ARTICLE),
        publicResolver,
      ),
    );
    const result = await service.acquire(acquisitionInput());
    assert.equal(result.verificationStatus, "CONFIRMED");
    assert.equal(result.currentState, "VERIFIED");
    assert.equal(result.evidence, 1);
  });

  test("returns persistent-style replay for identical page content", async () => {
    const repository = new MemoryAcquisitionRepository();
    const service = new OfficialEvidenceAcquisitionService(
      repository,
      new OfficialPageClient(fetchOk(SIMPLE_OFFICIAL_ARTICLE), publicResolver),
    );
    assert.equal((await service.acquire(acquisitionInput())).replayed, false);
    assert.equal((await service.acquire(acquisitionInput())).replayed, true);
  });

  test("detects an idempotency conflict when page content changes", async () => {
    const repository = new MemoryAcquisitionRepository();
    let body = SIMPLE_OFFICIAL_ARTICLE;
    const service = new OfficialEvidenceAcquisitionService(
      repository,
      new OfficialPageClient(
        (async () => htmlResponse(body)) as typeof fetch,
        publicResolver,
      ),
    );
    await service.acquire(acquisitionInput());
    body = SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally");
    await assert.rejects(
      service.acquire(acquisitionInput()),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
    );
  });

  test("does not accept an arbitrary URL from the command", async () => {
    const input = acquisitionInput();
    assert.equal("url" in input, false);
  });

  test("cancels the whole item at its limit and never persists afterward", async () => {
    const repository = new MemoryAcquisitionRepository();
    const client = new OfficialPageClient(
      ((_: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        })) as typeof fetch,
      publicResolver,
    );
    const service = new OfficialEvidenceAcquisitionService(
      repository,
      client,
      {
        ...DEFAULT_EVIDENCE_LIMITS,
        itemTimeoutMs: 10,
        requestTimeoutMs: 1_000,
        maxRetries: 0,
      },
    );

    await assert.rejects(
      service.acquire(acquisitionInput()),
      (error) =>
        error instanceof EvidenceAcquisitionError &&
        error.code === "OFFICIAL_PAGE_TIMEOUT",
    );
    assert.equal(repository.atomicExecutions, 0);
  });

  test("content-versioned identity follows A, replay A, B, replay B", async () => {
    const repository = new MemoryAcquisitionRepository();
    let body = SIMPLE_OFFICIAL_ARTICLE;
    const service = new OfficialEvidenceAcquisitionService(
      repository,
      new OfficialPageClient(
        (async () => htmlResponse(body)) as typeof fetch,
        publicResolver,
      ),
    );
    const input = {
      ...acquisitionInput(),
      identityMode: "CONTENT_VERSIONED" as const,
    };

    const first = await service.acquire(input);
    const replayA = await service.acquire(input);
    body = SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regionally");
    const second = await service.acquire(input);
    const replayB = await service.acquire(input);

    assert.equal(first.acquisitionOutcome, "NEW_ACQUISITION_VERSION");
    assert.equal(replayA.acquisitionOutcome, "REPLAY");
    assert.equal(second.acquisitionOutcome, "NEW_ACQUISITION_VERSION");
    assert.equal(replayB.acquisitionOutcome, "REPLAY");
    assert.notEqual(first.currentContentHash, second.currentContentHash);
    assert.equal(repository.logicalAcquisitions, 2);
  });
});

describe("content identity and operational selection", () => {
  test("identity is canonical, policy-aware and independent from retrieval time", () => {
    const page = extract(SIMPLE_OFFICIAL_ARTICLE);
    const input = {
      itemId: "item-1",
      canonicalUrl: "https://official.example/item#ignored",
      pages: [page],
      acquisitionPolicyVersion: "acquisition-v1",
      sourcePolicyVersion: "source-v1",
    };
    const first = deriveEvidenceContentIdentity(input);
    const reordered = deriveEvidenceContentIdentity({
      ...input,
      pages: [
        { ...page, fetchedAt: "2040-01-01T00:00:00.000Z" },
      ],
    });
    const policyChanged = deriveEvidenceContentIdentity({
      ...input,
      sourcePolicyVersion: "source-v2",
    });
    assert.equal(first.hash, reordered.hash);
    assert.notEqual(first.hash, policyChanged.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    assert.equal(first.hash.includes("-"), false);
  });

  test("whitespace and volatile response headers do not alter content identity", () => {
    const firstPage = extract(SIMPLE_OFFICIAL_ARTICLE);
    const whitespacePage = extract(
      SIMPLE_OFFICIAL_ARTICLE.replaceAll("><", ">\n  <"),
    );
    const headerPage = {
      ...firstPage,
      fetch: {
        ...firstPage.fetch,
        contentType: "text/html; charset=utf-8; volatile=ignored",
      },
    };
    const identity = (page: typeof firstPage) =>
      deriveEvidenceContentIdentity({
        itemId: "item-1",
        canonicalUrl: "https://official.example/item",
        pages: [page],
        acquisitionPolicyVersion: "acquisition-v1",
        sourcePolicyVersion: "source-v1",
      }).hash;
    assert.equal(identity(firstPage), identity(whitespacePage));
    assert.equal(identity(firstPage), identity(headerPage));
    assert.notEqual(
      identity(firstPage),
      identity(extract(SIMPLE_OFFICIAL_ARTICLE.replace("worldwide", "regional"))),
    );
  });

  test("selection excludes synthetic, invalid and disabled items deterministically", () => {
    const base = {
      sourceId: "github-blog",
      canonicalUrl: "https://github.blog/engineering/real-item",
      title: "A real engineering announcement",
      summary: "Official product information.",
      contentHash: "a".repeat(64),
      publishedAt: "2026-07-24T10:00:00.000Z",
      collectedAt: "2026-07-24T11:00:00.000Z",
      sourceEnabled: true,
    };
    const candidates = [
      { ...base, id: "real-1" },
      { ...base, id: "fixture-2", title: "Fixture item" },
      { ...base, id: "legacy-3", canonicalUrl: "not-a-url" },
      { ...base, id: "disabled-4", sourceEnabled: false },
      { ...base, id: "external-5", canonicalUrl: "https://example.com/item" },
      { ...base, id: "real-6", publishedAt: "2026-07-23T10:00:00.000Z" },
      { ...base, id: "real-7", publishedAt: "2026-07-22T10:00:00.000Z" },
      { ...base, id: "real-8", publishedAt: "2026-07-21T10:00:00.000Z" },
      { ...base, id: "real-9", publishedAt: "2026-07-20T10:00:00.000Z" },
      { ...base, id: "real-10", publishedAt: "2026-07-19T10:00:00.000Z" },
    ];
    const selected = selectOperationalEvidenceItems(candidates, 5);
    assert.deepEqual(
      selected.map((item) => item.id),
      ["real-1", "real-6", "real-7", "real-8", "real-9"],
    );
    assert.equal(new Set(selected.map((item) => item.id)).size, 5);
  });
});

function clientReturning(body: string): OfficialPageClient {
  return new OfficialPageClient(fetchOk(body), publicResolver);
}

function fetchOk(body: string): typeof fetch {
  return (async () => htmlResponse(body)) as typeof fetch;
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function fetched(
  body: string,
  url = "https://official.example/item",
): OfficialPageFetch {
  return {
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: "text/html; charset=utf-8",
    responseBytes: Buffer.byteLength(body),
    redirectCount: 0,
    body,
    fetchedAt: FIXTURE_TIME,
  };
}

function extract(
  body: string,
  url = "https://official.example/item",
) {
  return extractOfficialPage(
    fetched(body, url),
    "PRIMARY_ARTICLE",
    DEFAULT_EVIDENCE_LIMITS,
  );
}

function launchClaim(): VerificationClaim {
  return {
    id: "claim-launch",
    text: "Acme launched Orbit 2.0.",
    type: "PRODUCT_LAUNCH",
    importance: "PRIMARY",
    expectedSubject: "Orbit",
  };
}

function emptyMetadata() {
  return { openGraph: {}, twitter: {}, jsonLd: [] };
}

function acquisitionInput() {
  return {
    acquisitionId: "acquisition-unit",
    radarItemId: "source-item-unit",
    verificationId: "verification-unit",
    commandId: "command-unit",
    idempotencyKey: "evidence-unit",
    expectedVersion: 3,
    actor: { type: "SYSTEM" as const, id: "evidence-unit" },
    occurredAt: FIXTURE_TIME,
    claims: [launchClaim()],
  };
}

class MemoryAcquisitionRepository implements EvidenceAcquisitionRepository {
  atomicExecutions = 0;
  logicalAcquisitions = 0;
  readonly #processed = new Map<string, {
    readonly fingerprint: string;
    readonly result: EvidenceAcquisitionResult;
  }>();

  async findRadarItem(id: string): Promise<StoredRadarItem | undefined> {
    if (id !== "source-item-unit") return undefined;
    return {
      id,
      sourceId: "github-blog",
      canonicalUrl: "https://github.blog/releases/orbit-2",
      title: "Acme launches Orbit 2.0",
      publishedAt: "2026-07-24T10:00:00.000Z",
      editorialNewsId: "news-unit",
      currentState: "PENDING_VERIFICATION",
      currentVersion: 3,
    };
  }

  async executeAtomic(
    prepared: PreparedEvidenceAcquisition,
  ): Promise<EvidenceAcquisitionResult> {
    this.atomicExecutions += 1;
    const existing = this.#processed.get(prepared.input.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== prepared.acquisitionFingerprint) {
        throw new EvidenceAcquisitionError(
          "EVIDENCE_ACQUISITION_IDEMPOTENCY_CONFLICT",
          "conflict",
        );
      }
      return {
        ...existing.result,
        replayed: true,
        acquisitionOutcome: "REPLAY",
        eventsAdditional: 0,
      };
    }
    this.logicalAcquisitions += 1;
    const result: EvidenceAcquisitionResult = {
      acquisitionId: prepared.input.acquisitionId,
      radarItemId: prepared.item.id,
      newsId: prepared.item.editorialNewsId,
      pagesConsulted: prepared.pages.length,
      pageTypes: prepared.pages.map((page) => page.pageType),
      claims: prepared.input.claims.length,
      evidence: prepared.candidates.length,
      previousStatus: "INSUFFICIENT_EVIDENCE",
      verificationStatus: prepared.verification.result.status,
      confidence: prepared.verification.result.confidence,
      editorialDecision: prepared.verification.result.editorialDecision,
      previousState: "PENDING_VERIFICATION",
      currentState:
        prepared.verification.result.status === "CONFIRMED"
          ? "VERIFIED"
          : prepared.verification.result.status === "PARTIALLY_CONFIRMED"
            ? "PENDING_VERIFICATION"
            : "VERIFICATION_REJECTED",
      replayed: false,
      acquisitionOutcome: "NEW_ACQUISITION_VERSION",
      currentContentHash: prepared.contentIdentityHash,
      eventsAdditional: resultStateChanges(
        prepared.verification.result.status,
      ),
      policyVersion: "official-evidence-acquisition-v3",
    };
    this.#processed.set(prepared.input.idempotencyKey, {
      fingerprint: prepared.acquisitionFingerprint,
      result,
    });
    return result;
  }
}

function resultStateChanges(
  status: EvidenceAcquisitionResult["verificationStatus"],
): number {
  return status === "PARTIALLY_CONFIRMED" ? 0 : 1;
}
