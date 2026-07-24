import {
  ConcurrentUpdateError,
  DomainError,
  createReceivedNews,
  transition,
} from "../../content-engine/src/index.ts";
import type {
  EditorialCommand,
  EditorialNews,
  PersistedCommandResult,
  ProcessedCommand,
} from "../../content-engine/src/index.ts";

import {
  Sha256CommandFingerprint,
  resolvedReason,
  validateCommandEnvelope,
} from "./command-envelope.ts";
import type {
  EditorialCommandEnvelope,
  ReceiveNewsCommand,
} from "./command-envelope.ts";
import {
  ApplicationError,
  CommandPersistenceFailedError,
  ConcurrencyConflictError,
  EditorialNewsAlreadyExistsError,
  EditorialNewsNotFoundError,
  IdempotencyConflictError,
} from "./errors.ts";
import type {
  CommandFingerprint,
  EditorialWorkflowRepository,
} from "./ports.ts";
import type { EditorialCommandResult } from "./result.ts";

export class EditorialWorkflowService {
  readonly #repository: EditorialWorkflowRepository;
  readonly #fingerprint: CommandFingerprint;

  constructor(
    repository: EditorialWorkflowRepository,
    fingerprint: CommandFingerprint = new Sha256CommandFingerprint(),
  ) {
    this.#repository = repository;
    this.#fingerprint = fingerprint;
  }

  async execute(
    envelope: EditorialCommandEnvelope,
  ): Promise<EditorialCommandResult> {
    validateCommandEnvelope(envelope);
    const fingerprint = this.#fingerprint.create(envelope);
    const processed = await this.findProcessedCommand(envelope);

    if (processed !== undefined) {
      return this.replay(envelope, fingerprint, processed);
    }

    if (envelope.command.type === "ReceiveNews") {
      return this.receive(envelope, envelope.command, fingerprint);
    }

    return this.executeTransition(envelope, fingerprint);
  }

  private async receive(
    envelope: EditorialCommandEnvelope,
    command: ReceiveNewsCommand,
    fingerprint: string,
  ): Promise<EditorialCommandResult> {
    const existing = await this.findNews(envelope);
    if (existing !== undefined) {
      throw new EditorialNewsAlreadyExistsError(envelope.newsId);
    }

    const news = createReceivedNews({
      id: envelope.newsId,
      source: command.source,
      title: command.title,
      originalUrl: command.originalUrl,
      publishedAt: command.publishedAt,
      eventAt: command.eventAt,
      receivedAt: command.receivedAt,
    });
    const created: EditorialNews = {
      ...news,
      processedCommands: [
        {
          commandType: command.type,
          fingerprint,
          idempotencyKey: envelope.idempotencyKey,
        },
      ],
    };

    try {
      await this.#repository.save(created, 0);
    } catch (error) {
      if (isIdempotencyPersistenceError(error)) {
        throw new IdempotencyConflictError(envelope.idempotencyKey);
      }
      if ((await this.findNews(envelope)) !== undefined) {
        throw new EditorialNewsAlreadyExistsError(envelope.newsId);
      }
      throw new CommandPersistenceFailedError(envelope.commandId, error);
    }

    return {
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      news: created,
      previousState: null,
      newState: "RECEIVED",
      events: [],
      currentVersion: 0,
      currentDraftVersionId: null,
      replayed: false,
    };
  }

  private async executeTransition(
    envelope: EditorialCommandEnvelope,
    fingerprint: string,
  ): Promise<EditorialCommandResult> {
    const current = await this.findNews(envelope);
    if (current === undefined) {
      throw new EditorialNewsNotFoundError(envelope.newsId);
    }

    const currentVersion = current.auditEvents.length;
    const expectedVersion = envelope.expectedVersion ?? currentVersion;
    if (expectedVersion !== currentVersion) {
      throw new ConcurrencyConflictError(
        envelope.newsId,
        expectedVersion,
      );
    }

    const command = withEnvelopeMetadata(
      envelope.command as EditorialCommand,
      envelope.idempotencyKey,
      resolvedReason(envelope),
    );
    const transitioned = transition(current, command, {
      eventId: envelope.commandId,
      actor: envelope.actor,
      occurredAt: envelope.occurredAt,
    });
    const updated = withCanonicalFingerprint(
      transitioned.entity,
      envelope.idempotencyKey,
      fingerprint,
    );

    try {
      await this.#repository.save(updated, expectedVersion);
    } catch (error) {
      if (isConcurrencyError(error)) {
        throw new ConcurrencyConflictError(
          envelope.newsId,
          expectedVersion,
        );
      }
      if (isIdempotencyPersistenceError(error)) {
        throw new IdempotencyConflictError(envelope.idempotencyKey);
      }
      throw new CommandPersistenceFailedError(envelope.commandId, error);
    }

    return {
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      news: updated,
      previousState: current.state,
      newState: updated.state,
      events: transitioned.event === null ? [] : [transitioned.event],
      currentVersion: updated.auditEvents.length,
      currentDraftVersionId: updated.currentDraftVersionId,
      replayed: transitioned.replayed,
    };
  }

  private async replay(
    envelope: EditorialCommandEnvelope,
    fingerprint: string,
    processed: PersistedCommandResult,
  ): Promise<EditorialCommandResult> {
    if (
      processed.newsId !== envelope.newsId ||
      processed.commandType !== envelope.command.type ||
      processed.fingerprint !== fingerprint
    ) {
      throw new IdempotencyConflictError(envelope.idempotencyKey);
    }

    const news = await this.findNews(envelope);
    if (news === undefined) {
      throw new CommandPersistenceFailedError(
        envelope.commandId,
        new Error("Processed command references a missing aggregate."),
      );
    }

    const producedEvent =
      processed.result.auditEventCount === 0
        ? undefined
        : news.auditEvents[processed.result.auditEventCount - 1];

    return {
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      news,
      previousState: producedEvent?.previousState ?? null,
      newState: processed.result.state,
      events: [],
      currentVersion: processed.result.auditEventCount,
      currentDraftVersionId:
        producedEvent?.contentVersionId ?? news.currentDraftVersionId,
      replayed: true,
    };
  }

  private async findProcessedCommand(
    envelope: EditorialCommandEnvelope,
  ): Promise<PersistedCommandResult | undefined> {
    try {
      return await this.#repository.findProcessedCommand(
        envelope.idempotencyKey,
      );
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof DomainError) {
        throw error;
      }
      throw new CommandPersistenceFailedError(envelope.commandId, error);
    }
  }

  private async findNews(
    envelope: EditorialCommandEnvelope,
  ): Promise<EditorialNews | undefined> {
    try {
      return await this.#repository.findById(envelope.newsId);
    } catch (error) {
      if (error instanceof ApplicationError || error instanceof DomainError) {
        throw error;
      }
      throw new CommandPersistenceFailedError(envelope.commandId, error);
    }
  }
}

function withEnvelopeMetadata(
  command: EditorialCommand,
  idempotencyKey: string,
  reason: string | undefined,
): EditorialCommand {
  return {
    ...command,
    idempotencyKey,
    ...(reason === undefined ? {} : { reason }),
  };
}

function withCanonicalFingerprint(
  entity: EditorialNews,
  idempotencyKey: string,
  fingerprint: string,
): EditorialNews {
  const processedCommands: readonly ProcessedCommand[] =
    entity.processedCommands.map((command) =>
      command.idempotencyKey === idempotencyKey
        ? { ...command, fingerprint }
        : command,
    );
  return { ...entity, processedCommands };
}

function isConcurrencyError(error: unknown): boolean {
  return (
    error instanceof ConcurrentUpdateError ||
    hasErrorCode(error, "CONCURRENT_UPDATE")
  );
}

function isIdempotencyPersistenceError(error: unknown): boolean {
  return hasErrorCode(error, "PERSISTENCE_IDEMPOTENCY_CONFLICT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
