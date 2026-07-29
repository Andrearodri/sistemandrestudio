import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { Pool } from "pg";

import {
  PostgresEditorialDraftRepository,
  PostgresEditorialNewsRepository,
  PostgresHumanEditorialReviewRepository,
  PostgresPublicationPackageRepository,
  PostgresPublicationReconciliationRepository,
  PostgresVerificationRepository,
  assertSafeTestDatabase,
  createDatabasePool,
  loadDatabaseConfig,
  resetTestDatabase,
} from "../../database/src/index.ts";
import {
  EditorialDraftWorkflowService,
  EditorialWorkflowService,
  HumanEditorialReviewService,
  LocalPublicationExporter,
  LocalWebsitePublicationPackageReader,
  PublicationPackageService,
  PublicationReconciliationError,
  PublicationReconciliationService,
  VerificationWorkflowService,
  createApprovedWorkflowFixture,
  reconciliationIdempotencyKey,
  type PublicPublicationVerifier,
} from "../src/index.ts";

const config = loadDatabaseConfig();
assertSafeTestDatabase(config.database);
let pool: Pool;
const roots: string[] = [];
const at = "2026-07-28T12:00:00.000Z";

before(async () => {
  pool = createDatabasePool(config);
  await resetTestDatabase(pool, config);
});

beforeEach(async () => {
  await pool.query(`TRUNCATE
    publication_verification_checks,
    publication_public_verifications,
    publication_reconciliations,
    website_publication_plan_prerequisites,
    website_publication_plan_operations,
    website_publication_plans,
    publication_package_citations,
    publication_package_files,
    publication_packages,
    editorial_revision_requests,
    editorial_review_decisions,
    editorial_draft_validations,
    editorial_draft_citations,
    editorial_drafts,
    editorial_brief_facts,
    editorial_brief_claims,
    editorial_briefs,
    verification_claim_results,
    verification_results,
    verification_evidence,
    verification_claims,
    verification_runs,
    approval_actions,
    processed_commands,
    audit_events,
    editorial_relevance_results,
    approval_requests,
    draft_versions,
    editorial_news CASCADE`);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
  await pool.end();
});

describe("publication reconciliation with PostgreSQL", () => {
  test("persists reconciliation, verification and checks atomically", async () => {
    const fixture = await ready("persist");
    const result = await fixture.service.reconcileExternalPublication(
      fixture.input,
    );
    assert.equal(result.replayed, false);
    assert.equal(await count("publication_reconciliations"), 1);
    assert.equal(await count("publication_public_verifications"), 1);
    assert.equal(await count("publication_verification_checks"), 3);
  });

  test("transitions package and editorial aggregate to PUBLISHED", async () => {
    const fixture = await ready("state");
    await fixture.service.reconcileExternalPublication(fixture.input);
    const pkg = await new PostgresPublicationPackageRepository(pool).get(
      fixture.publicationId,
    );
    const news = await new PostgresEditorialNewsRepository(pool).getById(
      fixture.newsId,
    );
    assert.equal(pkg?.status, "PUBLISHED");
    assert.equal(news.state, "PUBLISHED");
  });

  test("records the five required audit events without pretending a deploy", async () => {
    const fixture = await ready("audit");
    await fixture.service.reconcileExternalPublication(fixture.input);
    const events = await reconciliationEvents(fixture.publicationId);
    assert.deepEqual(events.map((event) => event.action), [
      "PUBLICATION_RECONCILIATION_REQUESTED",
      "PUBLICATION_PUBLIC_VERIFICATION_STARTED",
      "PUBLICATION_PUBLIC_VERIFICATION_COMPLETED",
      "PUBLICATION_EXTERNALLY_CONFIRMED",
      "PUBLICATION_MARKED_AS_PUBLISHED",
    ]);
    assert.ok(events.every((event) =>
      event.origin === "MANUAL_SUPERVISED_DEPLOY"
    ));
  });

  test("recovers the complete record and ordered checks", async () => {
    const fixture = await ready("recover");
    const created = await fixture.service.reconcileExternalPublication(
      fixture.input,
    );
    const recovered = await new PostgresPublicationReconciliationRepository(
      pool,
    ).get(created.reconciliation.reconciliationId);
    assert.equal(
      recovered?.functionalFingerprint,
      created.reconciliation.functionalFingerprint,
    );
    assert.deepEqual(
      recovered?.verification.checks.map((check) => check.position),
      [0, 1, 2],
    );
  });

  test("replays with no additional rows or audit events", async () => {
    const fixture = await ready("replay");
    const first = await fixture.service.reconcileExternalPublication(
      fixture.input,
    );
    const eventCount = await reconciliationEventCount(fixture.publicationId);
    const replay = await fixture.service.reconcileExternalPublication(
      fixture.input,
    );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(await count("publication_reconciliations"), 1);
    assert.equal(
      await reconciliationEventCount(fixture.publicationId),
      eventCount,
    );
  });

  test("recovers and replays after reconnecting", async () => {
    const fixture = await ready("reconnect");
    const created = await fixture.service.reconcileExternalPublication(
      fixture.input,
    );
    const events = await reconciliationEventCount(fixture.publicationId);
    await pool.end();
    pool = createDatabasePool(config);
    const repository = new PostgresPublicationReconciliationRepository(pool);
    const recovered = await repository.get(
      created.reconciliation.reconciliationId,
    );
    const replay = await new PublicationReconciliationService(
      repository,
      staticVerifier(),
      new LocalWebsitePublicationPackageReader(fixture.root),
      () => at,
    ).reconcileExternalPublication(fixture.input);
    assert.equal(recovered?.finalState, "PUBLISHED");
    assert.equal(replay.replayed, true);
    assert.equal(await reconciliationEventCount(fixture.publicationId), events);
  });

  test("rejects the same key with an incompatible URL", async () => {
    const fixture = await ready("conflict");
    await fixture.service.reconcileExternalPublication(fixture.input);
    await assert.rejects(
      fixture.service.reconcileExternalPublication({
        ...fixture.input,
        publicUrl: `https://www.andrestudio.dev.br${
          new URL(fixture.input.publicUrl).pathname
        }`,
      }),
      code("PUBLICATION_RECONCILIATION_IDEMPOTENCY_CONFLICT"),
    );
    assert.equal(await count("publication_reconciliations"), 1);
  });

  test("serializes concurrent reconciliation of one identity", async () => {
    const fixture = await ready("concurrent");
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: PublicPublicationVerifier = {
      async verify(request) {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothReady;
        return staticVerifier().verify(request);
      },
    };
    const service = new PublicationReconciliationService(
      new PostgresPublicationReconciliationRepository(pool),
      delayed,
      new LocalWebsitePublicationPackageReader(fixture.root),
      () => at,
    );
    const results = await Promise.all([
      service.reconcileExternalPublication(fixture.input),
      service.reconcileExternalPublication(fixture.input),
    ]);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(await count("publication_reconciliations"), 1);
    assert.equal(await reconciliationEventCount(fixture.publicationId), 5);
  });

  test("rolls back every row and state when a check conflicts", async () => {
    const fixture = await ready("rollback", staticVerifier(true));
    await assert.rejects(
      fixture.service.reconcileExternalPublication(fixture.input),
    );
    assert.equal(await count("publication_reconciliations"), 0);
    assert.equal(await count("publication_public_verifications"), 0);
    assert.equal(await count("publication_verification_checks"), 0);
    assert.equal(
      (await new PostgresPublicationPackageRepository(pool).get(
        fixture.publicationId,
      ))?.status,
      "READY_FOR_PUBLICATION",
    );
    assert.equal(
      (await new PostgresEditorialNewsRepository(pool).getById(fixture.newsId))
        .state,
      "READY_FOR_PUBLICATION",
    );
  });

  test("FAILED verification blocks persistence and PUBLISHED", async () => {
    const failed: PublicPublicationVerifier = {
      async verify(request) {
        return {
          ...(await staticVerifier().verify(request)),
          status: "FAILED",
        };
      },
    };
    const fixture = await ready("failed", failed);
    await assert.rejects(
      fixture.service.reconcileExternalPublication(fixture.input),
      code("PUBLICATION_PUBLIC_VERIFICATION_FAILED"),
    );
    assert.equal(await count("publication_reconciliations"), 0);
    assert.equal(
      (await new PostgresPublicationPackageRepository(pool).get(
        fixture.publicationId,
      ))?.status,
      "READY_FOR_PUBLICATION",
    );
  });

  test("database constraints block a package PUBLISHED without reconciliation", async () => {
    const fixture = await ready("constraint");
    await assert.rejects(
      pool.query(
        `UPDATE publication_packages SET status = 'PUBLISHED' WHERE id = $1`,
        [fixture.publicationId],
      ),
    );
    assert.equal(
      (await new PostgresPublicationPackageRepository(pool).get(
        fixture.publicationId,
      ))?.status,
      "READY_FOR_PUBLICATION",
    );
  });

  test("preserves package identity, hashes and local bytes", async () => {
    const fixture = await ready("preserve");
    const before = await new PostgresPublicationPackageRepository(pool).get(
      fixture.publicationId,
    );
    const source = await new PostgresPublicationReconciliationRepository(pool)
      .loadSource(fixture.publicationId);
    const file = source!.files[0]!;
    const bytes = await readFile(join(fixture.root, file.relativePath), "utf8");
    await fixture.service.reconcileExternalPublication(fixture.input);
    const after = await new PostgresPublicationPackageRepository(pool).get(
      fixture.publicationId,
    );
    assert.equal(after?.publicationId, before?.publicationId);
    assert.equal(after?.contentHash, before?.contentHash);
    assert.equal(after?.functionalFingerprint, before?.functionalFingerprint);
    assert.equal(
      await readFile(join(fixture.root, file.relativePath), "utf8"),
      bytes,
    );
  });

  test("stores manual origin, operator, website commit and descriptive target", async () => {
    const fixture = await ready("metadata");
    const record = (await fixture.service.reconcileExternalPublication(
      fixture.input,
    )).reconciliation;
    assert.equal(record.executionOrigin, "MANUAL_SUPERVISED_DEPLOY");
    assert.equal(record.operatorId, "andre-local");
    assert.equal(record.websiteCommit, "7ea0d4a");
    assert.equal(
      record.deploymentTargetLabel,
      "EC2 Docker Nginx static website",
    );
  });

  test("lists completed reconciliations and removes packages from ready list", async () => {
    const fixture = await ready("list");
    await fixture.service.reconcileExternalPublication(fixture.input);
    assert.equal((await fixture.service.listReconciliations()).length, 1);
    assert.equal((await fixture.service.listReadyForReconciliation()).length, 0);
  });

  test("preserves prior package history while appending reconciliation history", async () => {
    const fixture = await ready("history");
    const before = await pool.query<{ readonly count: string }>(
      `SELECT count(*) FROM audit_events WHERE news_id = $1`,
      [fixture.newsId],
    );
    await fixture.service.reconcileExternalPublication(fixture.input);
    const after = await pool.query<{ readonly count: string }>(
      `SELECT count(*) FROM audit_events WHERE news_id = $1`,
      [fixture.newsId],
    );
    assert.equal(Number(after.rows[0]?.count), Number(before.rows[0]?.count) + 5);
  });
});

async function ready(
  suffix: string,
  verifier: PublicPublicationVerifier = staticVerifier(),
) {
  const drafted = await createDraft(suffix);
  await new HumanEditorialReviewService(
    new PostgresHumanEditorialReviewRepository(pool),
  ).approve({
    reviewId: `reconciliation-review-${suffix}`,
    draftId: drafted.draftId,
    expectedDraftVersion: 1,
    expectedNewsVersion: drafted.newsVersion,
    reviewerId: "andre-local",
    reviewedAt: "2026-07-28T10:00:00.000Z",
    idempotencyKey: `reconciliation-review-${suffix}`,
  });
  const root = await mkdtemp(join(tmpdir(), "publication-reconciliation-pg-"));
  roots.push(root);
  const exported = await new PublicationPackageService(
    new PostgresPublicationPackageRepository(pool),
    new LocalPublicationExporter(root),
  ).exportPackage({
    draftId: drafted.draftId,
    destination: "WEBSITE_EXPORT",
    reviewerId: "andre-local",
    createdAt: "2026-07-28T11:00:00.000Z",
    idempotencyKey: `reconciliation-publication-${suffix}`,
    commandId: `reconciliation-publication-${suffix}`,
  });
  const identity = {
    publicationId: exported.pkg.publicationId,
    draftId: drafted.draftId,
    operatorId: "andre-local",
    origin: "MANUAL_SUPERVISED_DEPLOY" as const,
    publicUrl: `https://andrestudio.dev.br/blog/${exported.pkg.slug}/`,
    canonicalUrl: `https://andrestudio.dev.br/blog/${exported.pkg.slug}/`,
    websiteCommit: "7ea0d4a",
  };
  const key = reconciliationIdempotencyKey(identity);
  const service = new PublicationReconciliationService(
    new PostgresPublicationReconciliationRepository(pool),
    verifier,
    new LocalWebsitePublicationPackageReader(root),
    () => at,
  );
  return {
    root,
    service,
    input: {
      ...identity,
      deploymentTarget: "EC2 Docker Nginx static website",
      idempotencyKey: key,
      commandId: key,
    },
    publicationId: exported.pkg.publicationId,
    newsId: drafted.newsId,
  };
}

async function createDraft(suffix: string) {
  const fixture = createApprovedWorkflowFixture(`reconciliation-${suffix}`);
  const editorial = new EditorialWorkflowService(
    new PostgresEditorialNewsRepository(pool),
  );
  await editorial.execute(fixture.receive);
  for (const command of fixture.commands.slice(0, 3)) {
    await editorial.execute(command);
  }
  const verificationId = `reconciliation-verification-${suffix}`;
  const claimId = `reconciliation-claim-${suffix}`;
  await new VerificationWorkflowService(
    new PostgresVerificationRepository(pool),
  ).evaluate({
    newsId: fixture.receive.newsId,
    verificationId,
    commandId: `reconciliation-v-command-${suffix}`,
    idempotencyKey: `reconciliation-v-key-${suffix}`,
    expectedVersion: 3,
    actor: { type: "SYSTEM", id: "test" },
    occurredAt: at,
    allowedSourceIds: ["official-test"],
    claims: [{
      id: claimId,
      text: "Orbit 2.0 foi anunciado oficialmente.",
      type: "PRODUCT_LAUNCH",
      importance: "PRIMARY",
      expectedSubject: "Orbit",
    }],
    evidence: [{
      id: `reconciliation-evidence-${suffix}`,
      claimId,
      sourceId: "official-test",
      canonicalUrl: "https://official.example/orbit",
      sourceAuthority: "PRIMARY_OFFICIAL",
      evidenceType: "RELEASE_NOTE",
      retrievedAt: at,
      eventDate: at,
      excerpt: "Orbit 2.0 foi anunciado oficialmente.",
      structuredFacts: { announced: true },
      supportsClaim: true,
      contradictsClaim: false,
    }],
  });
  const draft = await new EditorialDraftWorkflowService(
    new PostgresEditorialDraftRepository(pool),
  ).createDraft({
    newsId: fixture.receive.newsId,
    verificationId,
    format: "WEBSITE_NEWS_BRIEF",
    idempotencyKey: `reconciliation-draft-key-${suffix}`,
    commandId: `reconciliation-draft-command-${suffix}`,
    approvalRequestId: `reconciliation-approval-${suffix}`,
    expectedVersion: 4,
    actor: { type: "SYSTEM", id: "test" },
    occurredAt: at,
  });
  const news = await new PostgresEditorialNewsRepository(pool).getById(
    fixture.receive.newsId,
  );
  return {
    draftId: draft.draft.draftId,
    newsId: fixture.receive.newsId,
    newsVersion: news.auditEvents.length,
  };
}

function staticVerifier(duplicateCheck = false): PublicPublicationVerifier {
  return {
    async verify(request) {
      const checks = [
        {
          position: 0,
          code: "ARTICLE_CANONICAL",
          status: "PASS" as const,
          expectedValue: request.canonicalUrl,
          observedSummary: "canonical matched",
          metadata: {},
        },
        {
          position: 1,
          code: "SITEMAP_ARTICLE_URL",
          status: "PASS" as const,
          observedSummary: "sitemap matched",
          metadata: {},
        },
        {
          position: 2,
          code: duplicateCheck
            ? "SITEMAP_ARTICLE_URL"
            : "HOMEPAGE_LATEST_ARTICLE_OUTDATED",
          status: "WARN" as const,
          observedSummary: "home is not current",
          metadata: {},
        },
      ];
      return {
        verificationId:
          `verification-${request.source.pkg.publicationId.slice(-20)}`,
        publicationPackageId: request.source.pkg.publicationId,
        startedAt: request.startedAt,
        completedAt: request.completedAt,
        status: "VERIFIED_WITH_WARNINGS",
        httpStatus: 200,
        finalUrl: request.publicUrl,
        canonicalUrl: request.canonicalUrl,
        contentFingerprint: "a".repeat(64),
        warnings: ["HOMEPAGE_LATEST_ARTICLE_OUTDATED"],
        checks,
      };
    },
  };
}

async function count(table: string): Promise<number> {
  return Number(
    (await pool.query<{ readonly count: string }>(
      `SELECT count(*) FROM ${table}`,
    )).rows[0]?.count ?? 0,
  );
}

async function reconciliationEventCount(publicationId: string) {
  return Number((await pool.query<{ readonly count: string }>(
    `SELECT count(*)
     FROM audit_events
     WHERE technical_payload->>'publicationId' = $1
       AND technical_payload ? 'reconciliationId'
       AND action LIKE 'PUBLICATION_%'`,
    [publicationId],
  )).rows[0]?.count ?? 0);
}

async function reconciliationEvents(publicationId: string) {
  return (await pool.query<{
    readonly action: string;
    readonly origin: string;
  }>(
    `SELECT
       action,
       technical_payload->>'executionOrigin' AS origin
     FROM audit_events
     WHERE technical_payload->>'publicationId' = $1
       AND technical_payload ? 'reconciliationId'
       AND action LIKE 'PUBLICATION_%'
     ORDER BY CASE action
       WHEN 'PUBLICATION_RECONCILIATION_REQUESTED' THEN 1
       WHEN 'PUBLICATION_PUBLIC_VERIFICATION_STARTED' THEN 2
       WHEN 'PUBLICATION_PUBLIC_VERIFICATION_COMPLETED' THEN 3
       WHEN 'PUBLICATION_EXTERNALLY_CONFIRMED' THEN 4
       WHEN 'PUBLICATION_MARKED_AS_PUBLISHED' THEN 5
       ELSE 6
     END`,
    [publicationId],
  )).rows;
}

function code(expected: string) {
  return (error: unknown) =>
    error instanceof PublicationReconciliationError &&
    error.code === expected;
}
