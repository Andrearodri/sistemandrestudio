import { parseArgs } from "node:util";

import {
  DeterministicPublicPublicationVerifier,
  LocalWebsitePublicationPackageReader,
  PublicationReconciliationError,
  PublicationReconciliationService,
  reconciliationIdempotencyKey,
  SafePublicPublicationHttpClient,
  type PublicationReconciliation,
  type PublicPublicationVerification,
} from "../../../packages/application/src/index.ts";
import {
  createDatabasePool,
  loadDatabaseConfig,
  PostgresPublicationReconciliationRepository,
} from "../../../packages/database/src/index.ts";

const action = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    publication: { type: "string" },
    draft: { type: "string" },
    operator: { type: "string" },
    origin: { type: "string" },
    url: { type: "string" },
    canonical: { type: "string" },
    "website-commit": { type: "string" },
    "deployment-target": { type: "string" },
    "confirmed-at": { type: "string" },
    reconciliation: { type: "string" },
  },
  strict: true,
});

const pool = createDatabasePool(loadDatabaseConfig());
const repository = new PostgresPublicationReconciliationRepository(pool);
const service = new PublicationReconciliationService(
  repository,
  new DeterministicPublicPublicationVerifier(
    new SafePublicPublicationHttpClient(),
  ),
  new LocalWebsitePublicationPackageReader("output"),
);

try {
  if (action === "list-ready") {
    const records = await service.listReadyForReconciliation();
    console.log(JSON.stringify(records.map((source) => ({
      publicationPackage: source.pkg.publicationId,
      draft: source.pkg.draftId,
      draftVersion: source.pkg.draftVersion,
      state: source.pkg.status,
      destination: source.pkg.destination,
      title: source.pkg.title,
    })), null, 2));
  } else if (action === "verify-public") {
    required(values.publication, "--publication");
    required(values.url, "--url");
    const verification = await service.verifyPublicPublication({
      publicationId: values.publication,
      publicUrl: values.url,
      canonicalUrl: values.canonical ?? values.url,
    });
    console.log(JSON.stringify(verificationSummary(verification), null, 2));
    if (verification.status === "FAILED") process.exitCode = 2;
  } else if (action === "reconcile") {
    required(values.publication, "--publication");
    required(values.draft, "--draft");
    required(values.operator, "--operator");
    required(values.origin, "--origin");
    required(values.url, "--url");
    const canonicalUrl = values.canonical ?? values.url;
    const key = reconciliationIdempotencyKey({
      publicationId: values.publication,
      draftId: values.draft,
      operatorId: values.operator,
      origin: values.origin as "MANUAL_SUPERVISED_DEPLOY",
      publicUrl: values.url,
      canonicalUrl,
      ...(values["website-commit"] === undefined
        ? {}
        : { websiteCommit: values["website-commit"] }),
    });
    const result = await service.reconcileExternalPublication({
      publicationId: values.publication,
      draftId: values.draft,
      operatorId: values.operator,
      origin: values.origin as "MANUAL_SUPERVISED_DEPLOY",
      publicUrl: values.url,
      canonicalUrl,
      ...(values["website-commit"] === undefined
        ? {}
        : { websiteCommit: values["website-commit"] }),
      ...(values["deployment-target"] === undefined
        ? {}
        : { deploymentTarget: values["deployment-target"] }),
      ...(values["confirmed-at"] === undefined
        ? {}
        : { confirmedAt: values["confirmed-at"] }),
      idempotencyKey: key,
      commandId: key,
    });
    console.log(JSON.stringify(reconciliationSummary(
      result.reconciliation,
      result.replayed,
    ), null, 2));
  } else if (action === "show") {
    required(values.reconciliation, "--reconciliation");
    const record = await service.getReconciliation(values.reconciliation);
    if (record === undefined) {
      throw new PublicationReconciliationError(
        "PUBLICATION_RECONCILIATION_NOT_FOUND",
        "Reconciliation was not found.",
      );
    }
    console.log(JSON.stringify(reconciliationSummary(record, true), null, 2));
  } else if (action === "list") {
    const records = await service.listReconciliations();
    console.log(JSON.stringify(
      records.map((record) => reconciliationSummary(record, false)),
      null,
      2,
    ));
  } else {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_COMMAND_INVALID",
      "Unknown publication reconciliation command.",
    );
  }
} catch (error) {
  if (error instanceof PublicationReconciliationError) {
    console.error(JSON.stringify({ error: error.code, message: error.message }));
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await pool.end();
}

function required(
  value: string | undefined,
  name: string,
): asserts value is string {
  if (value === undefined || value.trim() === "") {
    throw new PublicationReconciliationError(
      "PUBLICATION_RECONCILIATION_INPUT_INVALID",
      `${name} is required.`,
    );
  }
}

function verificationSummary(verification: PublicPublicationVerification) {
  return {
    verificationId: verification.verificationId,
    status: verification.status,
    httpStatus: verification.httpStatus,
    finalUrl: verification.finalUrl,
    canonicalUrl: verification.canonicalUrl,
    https: checkStatus(verification, "ARTICLE_HTTPS_VALID"),
    domain: checkStatus(verification, "ARTICLE_DOMAIN_ALLOWED"),
    articleCanonical: checkStatus(verification, "ARTICLE_CANONICAL"),
    blog: checkStatus(verification, "BLOG_ARTICLE_LINK"),
    sitemap: checkStatus(verification, "SITEMAP_ARTICLE_URL"),
    jsonLdArticle: checkStatus(verification, "ARTICLE_JSON_LD"),
    jsonLdBreadcrumb: checkStatus(verification, "BREADCRUMB_JSON_LD"),
    warnings: verification.warnings,
    checks: verification.checks.map((check) => ({
      code: check.code,
      status: check.status,
      observed: check.observedSummary,
    })),
  };
}

function reconciliationSummary(
  reconciliation: PublicationReconciliation,
  replayed: boolean,
) {
  return {
    reconciliationId: reconciliation.reconciliationId,
    publicationPackage: reconciliation.publicationPackageId,
    draft: reconciliation.draftId,
    draftVersion: reconciliation.draftVersion,
    previousState: reconciliation.previousState,
    finalState: reconciliation.finalState,
    executionOrigin: reconciliation.executionOrigin,
    operator: reconciliation.operatorId,
    publicUrl: reconciliation.publicUrl,
    canonicalUrl: reconciliation.canonicalUrl,
    websiteCommit: reconciliation.websiteCommit,
    deploymentTarget: reconciliation.deploymentTargetLabel,
    verification: verificationSummary(reconciliation.verification),
    reconciliationStatus: reconciliation.reconciliationStatus,
    warnings: reconciliation.warnings,
    replayed,
  };
}

function checkStatus(
  verification: PublicPublicationVerification,
  code: string,
): string {
  return verification.checks.find((check) => check.code === code)?.status ??
    "NOT_EVALUATED";
}
