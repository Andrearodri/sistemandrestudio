import {
  FICTIONAL_SOURCE,
  FIXTURE_ACTORS,
  HIGH_RELEVANCE,
  VERIFIED_RESULT,
} from "../../content-engine/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";

import type {
  EditorialCommandEnvelope,
  EditorialWorkflowCommand,
} from "./command-envelope.ts";

export interface EditorialWorkflowFixture {
  readonly receive: EditorialCommandEnvelope;
  readonly commands: readonly EditorialCommandEnvelope[];
}

export function createApprovedWorkflowFixture(
  scenarioId = "application-approved",
): EditorialWorkflowFixture {
  const draftId = `draft-${scenarioId}-v1`;
  const approvalId = `approval-${scenarioId}-v1`;
  const decisionId = `decision-${scenarioId}-v1`;
  const commands = commonCommands(scenarioId, draftId, approvalId);

  return {
    receive: receiveEnvelope(scenarioId),
    commands: [
      ...commands,
      commandEnvelope(
        scenarioId,
        7,
        FIXTURE_ACTORS.human,
        {
          type: "ApproveDraft",
          decisionId,
          approvalRequestId: approvalId,
          contentVersionId: draftId,
          idempotencyKey: idempotencyKey(scenarioId, 7),
        },
      ),
      commandEnvelope(
        scenarioId,
        8,
        FIXTURE_ACTORS.system,
        { type: "MarkReadyForPublication" },
      ),
    ],
  };
}

export function createChangesWorkflowFixture(
  scenarioId = "application-changes",
): EditorialWorkflowFixture {
  const firstDraftId = `draft-${scenarioId}-v1`;
  const firstApprovalId = `approval-${scenarioId}-v1`;
  const secondDraftId = `draft-${scenarioId}-v2`;
  const secondApprovalId = `approval-${scenarioId}-v2`;
  const commands = commonCommands(
    scenarioId,
    firstDraftId,
    firstApprovalId,
  );

  return {
    receive: receiveEnvelope(scenarioId),
    commands: [
      ...commands,
      commandEnvelope(
        scenarioId,
        7,
        FIXTURE_ACTORS.human,
        {
          type: "RequestChanges",
          decisionId: `decision-${scenarioId}-changes-v1`,
          approvalRequestId: firstApprovalId,
          contentVersionId: firstDraftId,
          idempotencyKey: idempotencyKey(scenarioId, 7),
          reason: "Ajustar o fechamento do rascunho fictício.",
        },
      ),
      commandEnvelope(
        scenarioId,
        8,
        FIXTURE_ACTORS.llm,
        {
          type: "CreateDraft",
          draftVersionId: secondDraftId,
          body: `Segunda versão fictícia do cenário ${scenarioId}.`,
        },
      ),
      commandEnvelope(
        scenarioId,
        9,
        FIXTURE_ACTORS.telegram,
        {
          type: "SubmitForApproval",
          approvalRequestId: secondApprovalId,
          contentVersionId: secondDraftId,
        },
      ),
      commandEnvelope(
        scenarioId,
        10,
        FIXTURE_ACTORS.human,
        {
          type: "ApproveDraft",
          decisionId: `decision-${scenarioId}-v2`,
          approvalRequestId: secondApprovalId,
          contentVersionId: secondDraftId,
          idempotencyKey: idempotencyKey(scenarioId, 10),
        },
      ),
      commandEnvelope(
        scenarioId,
        11,
        FIXTURE_ACTORS.system,
        { type: "MarkReadyForPublication" },
      ),
    ],
  };
}

function receiveEnvelope(scenarioId: string): EditorialCommandEnvelope {
  return {
    commandId: `command-${scenarioId}-receive`,
    idempotencyKey: `idempotency-${scenarioId}-receive`,
    newsId: `news-${scenarioId}`,
    command: {
      type: "ReceiveNews",
      source: FICTIONAL_SOURCE,
      title: `Notícia totalmente fictícia para ${scenarioId}`,
      originalUrl: `https://source-alpha.invalid/items/${scenarioId}`,
      publishedAt: "2026-02-10T09:30:00.000Z",
      eventAt: "2026-02-10T08:00:00.000Z",
      receivedAt: "2026-02-10T10:00:00.000Z",
    },
    actor: FIXTURE_ACTORS.system,
    occurredAt: "2026-02-10T10:00:00.000Z",
    expectedVersion: 0,
  };
}

function commonCommands(
  scenarioId: string,
  draftId: string,
  approvalId: string,
): readonly EditorialCommandEnvelope[] {
  return [
    commandEnvelope(
      scenarioId,
      1,
      FIXTURE_ACTORS.system,
      {
        type: "NormalizeNews",
        normalizedTitle: `Notícia fictícia normalizada — ${scenarioId}`,
        canonicalUrl:
          `https://source-alpha.invalid/canonical/${scenarioId}`,
      },
    ),
    commandEnvelope(
      scenarioId,
      2,
      FIXTURE_ACTORS.system,
      { type: "ScoreNews", relevance: HIGH_RELEVANCE },
    ),
    commandEnvelope(
      scenarioId,
      3,
      FIXTURE_ACTORS.n8n,
      { type: "RequestVerification" },
    ),
    commandEnvelope(
      scenarioId,
      4,
      FIXTURE_ACTORS.system,
      {
        type: "ApproveVerification",
        verification: VERIFIED_RESULT,
      },
    ),
    commandEnvelope(
      scenarioId,
      5,
      FIXTURE_ACTORS.llm,
      {
        type: "CreateDraft",
        draftVersionId: draftId,
        body: `Rascunho fictício inicial para ${scenarioId}.`,
      },
    ),
    commandEnvelope(
      scenarioId,
      6,
      FIXTURE_ACTORS.telegram,
      {
        type: "SubmitForApproval",
        approvalRequestId: approvalId,
        contentVersionId: draftId,
      },
    ),
  ];
}

function commandEnvelope(
  scenarioId: string,
  sequence: number,
  actor: Actor,
  command: EditorialWorkflowCommand,
): EditorialCommandEnvelope {
  return {
    commandId: `command-${scenarioId}-${pad(sequence)}`,
    idempotencyKey: idempotencyKey(scenarioId, sequence),
    newsId: `news-${scenarioId}`,
    command,
    actor,
    occurredAt: `2026-02-10T10:${pad(sequence)}:00.000Z`,
    expectedVersion: sequence - 1,
  };
}

function idempotencyKey(scenarioId: string, sequence: number): string {
  return `idempotency-${scenarioId}-${pad(sequence)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
