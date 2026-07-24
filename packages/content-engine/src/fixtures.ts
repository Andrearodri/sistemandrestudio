import type { Actor } from "../../shared/src/index.ts";
import { createReceivedNews } from "./state-machine.ts";
import type {
  EditorialCommand,
  EditorialNews,
  RelevanceScore,
  TransitionContext,
  VerificationResult,
} from "./types.ts";

export interface ScenarioStep {
  readonly command: EditorialCommand;
  readonly context: TransitionContext;
}

export interface EditorialScenario {
  readonly id: string;
  readonly description: string;
  readonly initialNews: EditorialNews;
  readonly steps: readonly ScenarioStep[];
}

export const FIXTURE_ACTORS = {
  system: { id: "actor-system-fixture", type: "SYSTEM" },
  human: { id: "actor-human-fixture", type: "HUMAN" },
  n8n: { id: "actor-n8n-fixture", type: "N8N" },
  telegram: { id: "actor-telegram-fixture", type: "TELEGRAM" },
  llm: { id: "actor-llm-fixture", type: "LLM" },
} as const satisfies Readonly<Record<string, Actor>>;

export const FICTIONAL_SOURCE = {
  id: "source-fictional-alpha",
  name: "Fonte Fictícia Alfa",
  url: "https://source-alpha.invalid/feed",
  isOfficial: true,
} as const;

export const CORROBORATING_SOURCE = {
  id: "source-fictional-beta",
  name: "Fonte Fictícia Beta",
  url: "https://source-beta.invalid/noticias",
  isOfficial: true,
} as const;

export const HIGH_RELEVANCE = {
  value: 82,
  threshold: 60,
  reason: "Tema fictício compatível com a política editorial de teste.",
  policyVersion: "relevance-fixture-v1",
} as const;

export const LOW_RELEVANCE = {
  value: 24,
  threshold: 60,
  reason: "Tema fictício fora do recorte editorial de teste.",
  policyVersion: "relevance-fixture-v1",
} as const;

export const VERIFIED_RESULT: VerificationResult = {
  outcome: "VERIFIED",
  confidence: "HIGH",
  claimType: "FACT",
  evidence: [
    {
      id: "evidence-fictional-001",
      source: CORROBORATING_SOURCE,
      url: "https://source-beta.invalid/noticias/registro-001",
      publishedAt: "2026-01-15T09:00:00.000Z",
      eventAt: "2026-01-15T08:00:00.000Z",
      collectedAt: "2026-01-15T10:03:00.000Z",
      assessment: "SUPPORTS",
      summary: "A evidência fictícia confirma o acontecimento de teste.",
    },
  ],
  reason: "A fonte fictícia independente confirma o fato de teste.",
  policyVersion: "verification-fixture-v1",
};

export const REJECTED_VERIFICATION_RESULT: VerificationResult = {
  outcome: "REJECTED",
  confidence: "HIGH",
  claimType: "RUMOR",
  evidence: [
    {
      id: "evidence-fictional-002",
      source: CORROBORATING_SOURCE,
      url: "https://source-beta.invalid/noticias/registro-002",
      publishedAt: "2026-01-15T09:00:00.000Z",
      eventAt: "2026-01-15T08:00:00.000Z",
      collectedAt: "2026-01-15T10:03:00.000Z",
      assessment: "CONTRADICTS",
      summary: "A evidência fictícia contradiz a afirmação de teste.",
    },
  ],
  reason: "A evidência fictícia contradiz a afirmação.",
  policyVersion: "verification-fixture-v1",
};

function createFixtureNews(scenarioId: string): EditorialNews {
  return createReceivedNews({
    id: `news-${scenarioId}`,
    source: FICTIONAL_SOURCE,
    title: `Notícia totalmente fictícia para o cenário ${scenarioId}`,
    originalUrl: `https://source-alpha.invalid/items/${scenarioId}`,
    publishedAt: "2026-01-15T09:30:00.000Z",
    eventAt: "2026-01-15T08:00:00.000Z",
    receivedAt: "2026-01-15T10:00:00.000Z",
  });
}

function context(
  scenarioId: string,
  sequence: number,
  actor: Actor,
): TransitionContext {
  const minute = String(sequence).padStart(2, "0");
  return {
    eventId: `event-${scenarioId}-${minute}`,
    actor,
    occurredAt: `2026-01-15T10:${minute}:00.000Z`,
  };
}

function normalizeStep(scenarioId: string): ScenarioStep {
  return {
    command: {
      type: "NormalizeNews",
      normalizedTitle: `Notícia fictícia normalizada — ${scenarioId}`,
      canonicalUrl: `https://source-alpha.invalid/canonical/${scenarioId}`,
    },
    context: context(scenarioId, 1, FIXTURE_ACTORS.system),
  };
}

function scoreStep(
  scenarioId: string,
  relevance: RelevanceScore = HIGH_RELEVANCE,
): ScenarioStep {
  return {
    command: { type: "ScoreNews", relevance },
    context: context(scenarioId, 2, FIXTURE_ACTORS.system),
  };
}

function verifiedBaseSteps(scenarioId: string): readonly ScenarioStep[] {
  return [
    normalizeStep(scenarioId),
    scoreStep(scenarioId),
    {
      command: { type: "RequestVerification" },
      context: context(scenarioId, 3, FIXTURE_ACTORS.n8n),
    },
    {
      command: {
        type: "ApproveVerification",
        verification: VERIFIED_RESULT,
      },
      context: context(scenarioId, 4, FIXTURE_ACTORS.system),
    },
  ];
}

function firstDraftSteps(scenarioId: string): readonly ScenarioStep[] {
  return [
    ...verifiedBaseSteps(scenarioId),
    {
      command: {
        type: "CreateDraft",
        draftVersionId: `draft-${scenarioId}-v1`,
        body: `Rascunho fictício inicial para o cenário ${scenarioId}.`,
      },
      context: context(scenarioId, 5, FIXTURE_ACTORS.llm),
    },
    {
      command: {
        type: "SubmitForApproval",
        approvalRequestId: `approval-${scenarioId}-v1`,
        contentVersionId: `draft-${scenarioId}-v1`,
      },
      context: context(scenarioId, 6, FIXTURE_ACTORS.telegram),
    },
  ];
}

export const APPROVED_SCENARIO: EditorialScenario = {
  id: "approved",
  description: "Cenário A — fluxo aprovado até READY_FOR_PUBLICATION.",
  initialNews: createFixtureNews("approved"),
  steps: [
    ...firstDraftSteps("approved"),
    {
      command: {
        type: "ApproveDraft",
        decisionId: "decision-approved-v1",
        approvalRequestId: "approval-approved-v1",
        contentVersionId: "draft-approved-v1",
        idempotencyKey: "idempotency-approved-v1",
      },
      context: context("approved", 7, FIXTURE_ACTORS.human),
    },
    {
      command: { type: "MarkReadyForPublication" },
      context: context("approved", 8, FIXTURE_ACTORS.system),
    },
  ],
};

export const DUPLICATE_SCENARIO: EditorialScenario = {
  id: "duplicate",
  description: "Cenário B — notícia duplicada é encerrada.",
  initialNews: createFixtureNews("duplicate"),
  steps: [
    normalizeStep("duplicate"),
    {
      command: {
        type: "MarkAsDuplicate",
        duplicateOfNewsId: "news-canonical-fixture",
        reason: "Fingerprint fictício já registrado.",
      },
      context: context("duplicate", 2, FIXTURE_ACTORS.system),
    },
  ],
};

export const LOW_RELEVANCE_SCENARIO: EditorialScenario = {
  id: "low-relevance",
  description: "Cenário C — notícia abaixo do limiar é descartada.",
  initialNews: createFixtureNews("low-relevance"),
  steps: [
    normalizeStep("low-relevance"),
    scoreStep("low-relevance", LOW_RELEVANCE),
    {
      command: {
        type: "DiscardLowRelevance",
        reason: "Pontuação fictícia abaixo do limiar.",
      },
      context: context("low-relevance", 3, FIXTURE_ACTORS.system),
    },
  ],
};

export const VERIFICATION_REJECTED_SCENARIO: EditorialScenario = {
  id: "verification-rejected",
  description: "Cenário D — evidências fictícias rejeitam a informação.",
  initialNews: createFixtureNews("verification-rejected"),
  steps: [
    normalizeStep("verification-rejected"),
    scoreStep("verification-rejected"),
    {
      command: { type: "RequestVerification" },
      context: context("verification-rejected", 3, FIXTURE_ACTORS.n8n),
    },
    {
      command: {
        type: "RejectVerification",
        verification: REJECTED_VERIFICATION_RESULT,
        reason: "Evidências fictícias contraditórias.",
      },
      context: context(
        "verification-rejected",
        4,
        FIXTURE_ACTORS.system,
      ),
    },
  ],
};

export const DRAFT_REJECTED_SCENARIO: EditorialScenario = {
  id: "draft-rejected",
  description: "Cenário E — o rascunho é rejeitado pelo humano.",
  initialNews: createFixtureNews("draft-rejected"),
  steps: [
    ...firstDraftSteps("draft-rejected"),
    {
      command: {
        type: "RejectDraft",
        decisionId: "decision-draft-rejected-v1",
        approvalRequestId: "approval-draft-rejected-v1",
        contentVersionId: "draft-draft-rejected-v1",
        idempotencyKey: "idempotency-draft-rejected-v1",
        reason: "Rascunho fictício inadequado.",
      },
      context: context("draft-rejected", 7, FIXTURE_ACTORS.human),
    },
  ],
};

export const CHANGES_REQUESTED_SCENARIO: EditorialScenario = {
  id: "changes-requested",
  description: "Cenário F — alteração cria versão e aprovação novas.",
  initialNews: createFixtureNews("changes-requested"),
  steps: [
    ...firstDraftSteps("changes-requested"),
    {
      command: {
        type: "RequestChanges",
        decisionId: "decision-changes-requested-v1",
        approvalRequestId: "approval-changes-requested-v1",
        contentVersionId: "draft-changes-requested-v1",
        idempotencyKey: "idempotency-changes-requested-v1",
        reason: "Ajustar a conclusão fictícia.",
      },
      context: context("changes-requested", 7, FIXTURE_ACTORS.human),
    },
    {
      command: {
        type: "CreateDraft",
        draftVersionId: "draft-changes-requested-v2",
        body: "Rascunho fictício revisado com a conclusão ajustada.",
      },
      context: context("changes-requested", 8, FIXTURE_ACTORS.llm),
    },
    {
      command: {
        type: "SubmitForApproval",
        approvalRequestId: "approval-changes-requested-v2",
        contentVersionId: "draft-changes-requested-v2",
      },
      context: context("changes-requested", 9, FIXTURE_ACTORS.telegram),
    },
    {
      command: {
        type: "ApproveDraft",
        decisionId: "decision-changes-requested-v2",
        approvalRequestId: "approval-changes-requested-v2",
        contentVersionId: "draft-changes-requested-v2",
        idempotencyKey: "idempotency-changes-requested-v2",
      },
      context: context("changes-requested", 10, FIXTURE_ACTORS.human),
    },
    {
      command: { type: "MarkReadyForPublication" },
      context: context("changes-requested", 11, FIXTURE_ACTORS.system),
    },
  ],
};

export const INVALID_TRANSITION_SCENARIO: EditorialScenario = {
  id: "invalid-transition",
  description: "Cenário G — aprovação antes da verificação deve falhar.",
  initialNews: createFixtureNews("invalid-transition"),
  steps: [
    {
      command: {
        type: "ApproveDraft",
        decisionId: "decision-invalid",
        approvalRequestId: "approval-invalid",
        contentVersionId: "draft-invalid",
        idempotencyKey: "idempotency-invalid",
      },
      context: context("invalid-transition", 1, FIXTURE_ACTORS.human),
    },
  ],
};

const idempotentApproval = {
  command: {
    type: "ApproveDraft",
    decisionId: "decision-idempotency-v1",
    approvalRequestId: "approval-idempotency-v1",
    contentVersionId: "draft-idempotency-v1",
    idempotencyKey: "idempotency-replayed-approval",
  },
  context: context("idempotency", 7, FIXTURE_ACTORS.human),
} as const satisfies ScenarioStep;

export const IDEMPOTENCY_SCENARIO: EditorialScenario = {
  id: "idempotency",
  description: "Cenário H — aprovação repetida produz uma única alteração.",
  initialNews: createFixtureNews("idempotency"),
  steps: [
    ...firstDraftSteps("idempotency"),
    idempotentApproval,
    {
      command: idempotentApproval.command,
      context: context("idempotency", 8, FIXTURE_ACTORS.human),
    },
  ],
};

export const EDITORIAL_SCENARIOS = {
  approved: APPROVED_SCENARIO,
  changesRequested: CHANGES_REQUESTED_SCENARIO,
  draftRejected: DRAFT_REJECTED_SCENARIO,
  duplicate: DUPLICATE_SCENARIO,
  idempotency: IDEMPOTENCY_SCENARIO,
  invalidTransition: INVALID_TRANSITION_SCENARIO,
  lowRelevance: LOW_RELEVANCE_SCENARIO,
  verificationRejected: VERIFICATION_REJECTED_SCENARIO,
} as const;
