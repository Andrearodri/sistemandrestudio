import { createHash } from "node:crypto";

import { ACTOR_TYPES } from "../../shared/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";
import type {
  CreateReceivedNewsInput,
  EditorialCommand,
} from "../../content-engine/src/index.ts";

import { InvalidCommandEnvelopeError, UnsupportedCommandError } from "./errors.ts";
import type { CommandFingerprint } from "./ports.ts";

export interface ReceiveNewsCommand
  extends Omit<CreateReceivedNewsInput, "id"> {
  readonly type: "ReceiveNews";
}

export type EditorialWorkflowCommand =
  | ReceiveNewsCommand
  | EditorialCommand;

export interface EditorialCommandEnvelope {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly newsId: string;
  readonly command: EditorialWorkflowCommand;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly expectedVersion?: number;
  readonly reason?: string;
}

const SUPPORTED_COMMAND_TYPES = new Set<string>([
  "ReceiveNews",
  "NormalizeNews",
  "MarkAsDuplicate",
  "ScoreNews",
  "DiscardLowRelevance",
  "RequestVerification",
  "ApproveVerification",
  "RejectVerification",
  "CreateDraft",
  "SubmitForApproval",
  "RequestChanges",
  "ApproveDraft",
  "RejectDraft",
  "MarkReadyForPublication",
]);

export class Sha256CommandFingerprint implements CommandFingerprint {
  create(envelope: EditorialCommandEnvelope): string {
    validateCommandEnvelope(envelope);
    const content = {
      actor: envelope.actor,
      command: commandContent(envelope.command),
      newsId: envelope.newsId,
      occurredAt: envelope.occurredAt,
      reason: resolvedReason(envelope) ?? null,
    };

    return createHash("sha256")
      .update(canonicalJson(content))
      .digest("hex");
  }
}

export function validateCommandEnvelope(
  envelope: EditorialCommandEnvelope,
): void {
  if (!isRecord(envelope)) {
    throw new InvalidCommandEnvelopeError("envelope");
  }
  requireText("commandId", envelope.commandId);
  requireText("idempotencyKey", envelope.idempotencyKey);
  requireText("newsId", envelope.newsId);
  requireIsoDate("occurredAt", envelope.occurredAt);

  if (!isRecord(envelope.actor)) {
    throw new InvalidCommandEnvelopeError("actor");
  }
  requireText("actor.id", envelope.actor.id);
  if (!ACTOR_TYPES.includes(envelope.actor.type)) {
    throw new InvalidCommandEnvelopeError("actor.type");
  }

  if (!isRecord(envelope.command)) {
    throw new InvalidCommandEnvelopeError("command");
  }
  if (typeof envelope.command.type !== "string") {
    throw new InvalidCommandEnvelopeError("command.type");
  }
  if (!SUPPORTED_COMMAND_TYPES.has(envelope.command.type)) {
    throw new UnsupportedCommandError(envelope.command.type);
  }
  validateCommandPayload(envelope.command);

  if (
    envelope.expectedVersion !== undefined &&
    (!Number.isInteger(envelope.expectedVersion) ||
      envelope.expectedVersion < 0)
  ) {
    throw new InvalidCommandEnvelopeError("expectedVersion");
  }

  if (
    "idempotencyKey" in envelope.command &&
    envelope.command.idempotencyKey !== undefined &&
    envelope.command.idempotencyKey !== envelope.idempotencyKey
  ) {
    throw new InvalidCommandEnvelopeError("command.idempotencyKey");
  }

  if (
    envelope.reason !== undefined &&
    "reason" in envelope.command &&
    envelope.command.reason !== undefined &&
    envelope.command.reason !== envelope.reason
  ) {
    throw new InvalidCommandEnvelopeError("command.reason");
  }
  if (envelope.reason !== undefined) {
    requireText("reason", envelope.reason);
  }
  if (
    "reason" in envelope.command &&
    envelope.command.reason !== undefined
  ) {
    requireText("command.reason", envelope.command.reason);
  }

  if (envelope.command.type === "ReceiveNews") {
    if (
      envelope.expectedVersion !== undefined &&
      envelope.expectedVersion !== 0
    ) {
      throw new InvalidCommandEnvelopeError("expectedVersion");
    }
  }
}

function validateCommandPayload(command: EditorialWorkflowCommand): void {
  switch (command.type) {
    case "ReceiveNews":
      validateReceiveNewsCommand(command);
      return;
    case "NormalizeNews":
      requireText("command.normalizedTitle", command.normalizedTitle);
      requireText("command.canonicalUrl", command.canonicalUrl);
      return;
    case "MarkAsDuplicate":
      requireText("command.duplicateOfNewsId", command.duplicateOfNewsId);
      return;
    case "ScoreNews":
      validateRelevance(command.relevance);
      return;
    case "ApproveVerification":
    case "RejectVerification":
      validateVerification(command.verification);
      return;
    case "CreateDraft":
      requireText("command.draftVersionId", command.draftVersionId);
      requireText("command.body", command.body);
      return;
    case "SubmitForApproval":
      requireText("command.approvalRequestId", command.approvalRequestId);
      requireText("command.contentVersionId", command.contentVersionId);
      return;
    case "RequestChanges":
    case "RejectDraft":
      requireText("command.decisionId", command.decisionId);
      requireText("command.approvalRequestId", command.approvalRequestId);
      requireText("command.contentVersionId", command.contentVersionId);
      requireText("command.reason", command.reason);
      return;
    case "ApproveDraft":
      requireText("command.decisionId", command.decisionId);
      requireText("command.approvalRequestId", command.approvalRequestId);
      requireText("command.contentVersionId", command.contentVersionId);
      return;
    case "DiscardLowRelevance":
    case "RequestVerification":
    case "MarkReadyForPublication":
      return;
  }
}

export function resolvedReason(
  envelope: EditorialCommandEnvelope,
): string | undefined {
  if (envelope.reason !== undefined) {
    return envelope.reason;
  }
  return "reason" in envelope.command
    ? envelope.command.reason
    : undefined;
}

function validateReceiveNewsCommand(command: ReceiveNewsCommand): void {
  requireText("command.title", command.title);
  requireText("command.originalUrl", command.originalUrl);
  requireIsoDate("command.publishedAt", command.publishedAt);
  requireIsoDate("command.eventAt", command.eventAt);
  requireIsoDate("command.receivedAt", command.receivedAt);

  if (!isRecord(command.source)) {
    throw new InvalidCommandEnvelopeError("command.source");
  }
  requireText("command.source.id", command.source.id);
  requireText("command.source.name", command.source.name);
  requireText("command.source.url", command.source.url);
  if (typeof command.source.isOfficial !== "boolean") {
    throw new InvalidCommandEnvelopeError("command.source.isOfficial");
  }
}

function validateRelevance(
  relevance: Extract<
    EditorialCommand,
    { type: "ScoreNews" }
  >["relevance"],
): void {
  if (!isRecord(relevance)) {
    throw new InvalidCommandEnvelopeError("command.relevance");
  }
  requireFiniteNumber("command.relevance.value", relevance.value);
  requireFiniteNumber("command.relevance.threshold", relevance.threshold);
  requireText("command.relevance.reason", relevance.reason);
  requireText("command.relevance.policyVersion", relevance.policyVersion);
}

function validateVerification(
  verification: Extract<
    EditorialCommand,
    { type: "ApproveVerification" }
  >["verification"],
): void {
  if (!isRecord(verification)) {
    throw new InvalidCommandEnvelopeError("command.verification");
  }
  requireText("command.verification.outcome", verification.outcome);
  requireText("command.verification.confidence", verification.confidence);
  requireText("command.verification.claimType", verification.claimType);
  requireText("command.verification.reason", verification.reason);
  requireText(
    "command.verification.policyVersion",
    verification.policyVersion,
  );
  if (!Array.isArray(verification.evidence)) {
    throw new InvalidCommandEnvelopeError(
      "command.verification.evidence",
    );
  }
}

function commandContent(command: EditorialWorkflowCommand): unknown {
  switch (command.type) {
    case "ReceiveNews":
      return {
        type: command.type,
        source: command.source,
        title: command.title,
        originalUrl: command.originalUrl,
        publishedAt: command.publishedAt,
        eventAt: command.eventAt,
        receivedAt: command.receivedAt,
      };
    case "NormalizeNews":
      return {
        type: command.type,
        normalizedTitle: command.normalizedTitle,
        canonicalUrl: command.canonicalUrl,
      };
    case "MarkAsDuplicate":
      return {
        type: command.type,
        duplicateOfNewsId: command.duplicateOfNewsId,
      };
    case "ScoreNews":
      return { type: command.type, relevance: command.relevance };
    case "DiscardLowRelevance":
    case "RequestVerification":
    case "MarkReadyForPublication":
      return { type: command.type };
    case "ApproveVerification":
    case "RejectVerification":
      return { type: command.type, verification: command.verification };
    case "CreateDraft":
      return {
        type: command.type,
        draftVersionId: command.draftVersionId,
        body: command.body,
      };
    case "SubmitForApproval":
      return {
        type: command.type,
        approvalRequestId: command.approvalRequestId,
        contentVersionId: command.contentVersionId,
      };
    case "RequestChanges":
    case "ApproveDraft":
    case "RejectDraft":
      return {
        type: command.type,
        decisionId: command.decisionId,
        approvalRequestId: command.approvalRequestId,
        contentVersionId: command.contentVersionId,
      };
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function requireText(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidCommandEnvelopeError(field);
  }
}

function requireIsoDate(field: string, value: unknown): asserts value is string {
  requireText(field, value);
  if (
    !value.endsWith("Z") ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new InvalidCommandEnvelopeError(field);
  }
}

function requireFiniteNumber(
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidCommandEnvelopeError(field);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
