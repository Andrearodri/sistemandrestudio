import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryPublicationReconciliationRepository,
  LocalPublicationExporter,
  LocalWebsitePublicationPackageReader,
  PublicationReconciliationService,
  buildPublicationPackage,
  reconciliationIdempotencyKey,
  type PublicationContext,
} from "../../../packages/application/src/index.ts";
import { simulatedPublicVerifier } from "./publication-reconciliation-demo-support.ts";

const root = await mkdtemp(join(tmpdir(), "publication-reconciliation-demo-"));
const context: PublicationContext = {
  newsId: "demo-reconciliation-news",
  newsVersion: 7,
  newsState: "APPROVED",
  draftVersion: 1,
  approvalDecisionId: "demo-reconciliation-approval",
  reviewerId: "andre-local",
  approvedAt: "2026-07-28T10:00:00.000Z",
  draft: {
    draftId: "demo-reconciliation-draft",
    newsId: "demo-reconciliation-news",
    briefId: "demo-reconciliation-brief",
    format: "WEBSITE_NEWS_BRIEF",
    language: "pt-BR",
    title: "Orbit 2.0 foi anunciado oficialmente",
    subtitle: "Fixture local",
    body: "Orbit 2.0 foi anunciado oficialmente.",
    sourceCitations: [{
      evidenceId: "demo-evidence",
      claimId: "demo-claim",
      sourceId: "official-demo",
      canonicalUrl: "https://official.example/orbit",
      title: "Fonte oficial",
    }],
    warnings: [],
    prohibitedClaimsChecked: true,
    validationStatus: "VALID",
    generatorId: "demo",
    generatorVersion: "v1",
    createdAt: "2026-07-28T09:00:00.000Z",
  },
};

try {
  const pkg = buildPublicationPackage(
    context,
    "WEBSITE_EXPORT",
    "2026-07-28T11:00:00.000Z",
  );
  const exported = await new LocalPublicationExporter(root).export(pkg);
  const ready = {
    pkg: { ...pkg, status: "READY_FOR_PUBLICATION" as const },
    files: exported.files.map(({ content: _content, ...file }) => file),
  };
  const repository = new InMemoryPublicationReconciliationRepository([ready]);
  const service = new PublicationReconciliationService(
    repository,
    simulatedPublicVerifier(),
    new LocalWebsitePublicationPackageReader(root),
    () => "2026-07-28T12:00:00.000Z",
  );
  const url = `https://andrestudio.dev.br/blog/${pkg.slug}/`;
  const identity = {
    publicationId: pkg.publicationId,
    draftId: pkg.draftId,
    operatorId: "andre-local",
    origin: "MANUAL_SUPERVISED_DEPLOY" as const,
    publicUrl: url,
    canonicalUrl: url,
    websiteCommit: "7ea0d4a",
  };
  const key = reconciliationIdempotencyKey(identity);
  const request = {
    ...identity,
    deploymentTarget: "Local simulated static website",
    idempotencyKey: key,
    commandId: key,
  };
  const first = await service.reconcileExternalPublication(request);
  const replay = await service.reconcileExternalPublication(request);
  console.log(JSON.stringify({
    flow: [
      "READY_FOR_PUBLICATION",
      "SIMULATED_PUBLIC_VERIFICATION",
      "MANUAL_SUPERVISED_DEPLOY_RECONCILIATION",
      "PUBLISHED",
      "REPLAY",
    ],
    publicationPackage: pkg.publicationId,
    reconciliationId: first.reconciliation.reconciliationId,
    verificationStatus: first.reconciliation.verificationStatus,
    finalState: first.reconciliation.finalState,
    firstReplay: first.replayed,
    secondReplay: replay.replayed,
    reconciliations: (await repository.list()).length,
    deploymentsExecuted: 0,
    remoteWrites: 0,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
