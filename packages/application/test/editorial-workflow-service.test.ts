import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DomainError,
  InMemoryEditorialNewsRepository,
} from "../../content-engine/src/index.ts";
import type {
  AuditEvent,
  EditorialNews,
  PersistedCommandResult,
} from "../../content-engine/src/index.ts";
import {
  ConcurrencyConflictError,
  EditorialNewsNotFoundError,
  EditorialWorkflowService,
  IdempotencyConflictError,
  InvalidCommandEnvelopeError,
  Sha256CommandFingerprint,
  UnsupportedCommandError,
  createApprovedWorkflowFixture,
  createChangesWorkflowFixture,
} from "../src/index.ts";
import type {
  EditorialCommandEnvelope,
  EditorialWorkflowRepository,
} from "../src/index.ts";

describe("EditorialWorkflowService", () => {
  test("executes the main flow with the in-memory repository", async () => {
    const fixture = createApprovedWorkflowFixture("unit-main-flow");
    const { result } = await executeFixture(fixture);

    assert.equal(result.state, "READY_FOR_PUBLICATION");
    assert.equal(result.auditEvents.length, 8);
    assert.equal(result.decisions.length, 1);
  });

  test("creates a received editorial news item", async () => {
    const fixture = createApprovedWorkflowFixture("unit-receive");
    const service = createService();
    const result = await service.execute(fixture.receive);

    assert.equal(result.previousState, null);
    assert.equal(result.newState, "RECEIVED");
    assert.equal(result.currentVersion, 0);
    assert.equal(result.events.length, 0);
  });

  test("reports an editorial news item that does not exist", async () => {
    const fixture = createApprovedWorkflowFixture("unit-not-found");
    const service = createService();

    await assert.rejects(
      service.execute(requiredCommand(fixture, 0)),
      (error: unknown) =>
        error instanceof EditorialNewsNotFoundError &&
        error.code === "EDITORIAL_NEWS_NOT_FOUND",
    );
  });

  test("rejects an invalid command envelope", async () => {
    const fixture = createApprovedWorkflowFixture("unit-invalid-envelope");
    const invalid = {
      ...fixture.receive,
      idempotencyKey: "",
    };

    await assert.rejects(
      createService().execute(invalid),
      (error: unknown) =>
        error instanceof InvalidCommandEnvelopeError &&
        error.code === "INVALID_COMMAND_ENVELOPE",
    );
  });

  test("rejects an unsupported command", async () => {
    const fixture = createApprovedWorkflowFixture("unit-unsupported");
    const unsupported = {
      ...fixture.receive,
      command: { type: "PublishImmediately" },
    } as unknown as EditorialCommandEnvelope;

    await assert.rejects(
      createService().execute(unsupported),
      (error: unknown) =>
        error instanceof UnsupportedCommandError &&
        error.code === "UNSUPPORTED_COMMAND",
    );
  });

  test("returns an idempotent replay without a new event", async () => {
    const fixture = createApprovedWorkflowFixture("unit-replay");
    const repository = new InMemoryEditorialNewsRepository();
    const service = new EditorialWorkflowService(repository);
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    const first = await service.execute(normalize);
    const replay = await service.execute(normalize);
    const recovered = await repository.getById(normalize.newsId);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.events.length, 0);
    assert.equal(recovered.auditEvents.length, 1);
  });

  test("rejects conflicting reuse of an idempotency key", async () => {
    const fixture = createApprovedWorkflowFixture("unit-idempotency-conflict");
    const service = createService();
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    await service.execute(normalize);

    const conflicting: EditorialCommandEnvelope = {
      ...normalize,
      command: {
        type: "NormalizeNews",
        normalizedTitle: "Outro título fictício.",
        canonicalUrl:
          "https://source-alpha.invalid/canonical/outro-titulo",
      },
    };

    await assert.rejects(
      service.execute(conflicting),
      (error: unknown) =>
        error instanceof IdempotencyConflictError &&
        error.code === "IDEMPOTENCY_CONFLICT",
    );
  });

  test("rejects an outdated expected version", async () => {
    const fixture = createApprovedWorkflowFixture("unit-concurrency");
    const service = createService();
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);

    await assert.rejects(
      service.execute({ ...normalize, expectedVersion: 2 }),
      (error: unknown) =>
        error instanceof ConcurrencyConflictError &&
        error.code === "CONCURRENCY_CONFLICT",
    );
  });

  test("leaves no partial effect after persistence fails", async () => {
    const fixture = createApprovedWorkflowFixture("unit-rollback");
    const repository = new FailingSaveRepository();
    const service = new EditorialWorkflowService(repository);
    await service.execute(fixture.receive);
    repository.failNextSave();

    await assert.rejects(
      service.execute(requiredCommand(fixture, 0)),
      hasCode("COMMAND_PERSISTENCE_FAILED"),
    );

    const recovered = await repository.getById(fixture.receive.newsId);
    assert.equal(recovered.state, "RECEIVED");
    assert.equal(recovered.auditEvents.length, 0);
  });

  test("returns a structured command result", async () => {
    const fixture = createApprovedWorkflowFixture("unit-result");
    const service = createService();
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    const result = await service.execute(normalize);

    assert.deepEqual(
      {
        commandId: result.commandId,
        idempotencyKey: result.idempotencyKey,
        previousState: result.previousState,
        newState: result.newState,
        currentVersion: result.currentVersion,
        currentDraftVersionId: result.currentDraftVersionId,
        replayed: result.replayed,
      },
      {
        commandId: normalize.commandId,
        idempotencyKey: normalize.idempotencyKey,
        previousState: "RECEIVED",
        newState: "NORMALIZED",
        currentVersion: 1,
        currentDraftVersionId: null,
        replayed: false,
      },
    );
  });

  test("returns only the event produced by the command", async () => {
    const fixture = createApprovedWorkflowFixture("unit-event");
    const service = createService();
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    const result = await service.execute(normalize);

    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]?.id, normalize.commandId);
    assert.equal(result.events[0]?.action, "NormalizeNews");
  });

  test("preserves draft versions after requested changes", async () => {
    const fixture = createChangesWorkflowFixture("unit-versions");
    const { result } = await executeFixture(fixture);

    assert.equal(result.draftVersions.length, 2);
    assert.equal(
      result.draftVersions[1]?.basedOnVersionId,
      result.draftVersions[0]?.id,
    );
    assert.notEqual(
      result.draftVersions[0]?.body,
      result.draftVersions[1]?.body,
    );
  });

  test("requires and records a new approval after changes", async () => {
    const fixture = createChangesWorkflowFixture("unit-new-approval");
    const repository = new InMemoryEditorialNewsRepository();
    const service = new EditorialWorkflowService(repository);
    await service.execute(fixture.receive);

    for (const envelope of fixture.commands.slice(0, 9)) {
      await service.execute(envelope);
    }

    const recovered = await repository.getById(fixture.receive.newsId);
    assert.equal(recovered.state, "PENDING_APPROVAL");
    assert.equal(recovered.approvalRequests.length, 2);
    assert.equal(recovered.approvalRequests[0]?.status, "CHANGES_REQUESTED");
    assert.equal(recovered.approvalRequests[1]?.status, "PENDING");
  });

  test("cannot mark content ready without approval", async () => {
    const fixture = createApprovedWorkflowFixture("unit-no-publication");
    const service = createService();
    await service.execute(fixture.receive);
    const normalize = requiredCommand(fixture, 0);
    const invalid: EditorialCommandEnvelope = {
      ...normalize,
      commandId: "command-unit-no-publication-ready",
      idempotencyKey: "idempotency-unit-no-publication-ready",
      command: { type: "MarkReadyForPublication" },
    };

    await assert.rejects(
      service.execute(invalid),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "INVALID_TRANSITION",
    );
  });

  test("is deterministic for identical inputs and property order", async () => {
    const fixture = createApprovedWorkflowFixture("unit-deterministic");
    const firstService = createService();
    const secondService = createService();
    const first = await firstService.execute(fixture.receive);
    const second = await secondService.execute(structuredClone(fixture.receive));
    const fingerprint = new Sha256CommandFingerprint();
    const receiveCommand = fixture.receive.command;
    assert.equal(receiveCommand.type, "ReceiveNews");
    if (receiveCommand.type !== "ReceiveNews") {
      throw new Error("Expected a receive fixture.");
    }
    const reordered = {
      expectedVersion: 0,
      occurredAt: fixture.receive.occurredAt,
      actor: {
        type: fixture.receive.actor.type,
        id: fixture.receive.actor.id,
      },
      command: {
        receivedAt: receiveCommand.receivedAt,
        eventAt: receiveCommand.eventAt,
        publishedAt: receiveCommand.publishedAt,
        originalUrl: receiveCommand.originalUrl,
        title: receiveCommand.title,
        source: receiveCommand.source,
        type: "ReceiveNews" as const,
      },
      newsId: fixture.receive.newsId,
      idempotencyKey: fixture.receive.idempotencyKey,
      commandId: fixture.receive.commandId,
    };

    assert.deepEqual(first, second);
    assert.equal(
      fingerprint.create(fixture.receive),
      fingerprint.create(reordered),
    );
  });
});

function createService(): EditorialWorkflowService {
  return new EditorialWorkflowService(
    new InMemoryEditorialNewsRepository(),
  );
}

async function executeFixture(
  fixture: ReturnType<typeof createApprovedWorkflowFixture>,
): Promise<{
  readonly repository: InMemoryEditorialNewsRepository;
  readonly result: EditorialNews;
}> {
  const repository = new InMemoryEditorialNewsRepository();
  const service = new EditorialWorkflowService(repository);
  await service.execute(fixture.receive);
  for (const envelope of fixture.commands) {
    await service.execute(envelope);
  }
  return {
    repository,
    result: await repository.getById(fixture.receive.newsId),
  };
}

function requiredCommand(
  fixture: ReturnType<typeof createApprovedWorkflowFixture>,
  index: number,
): EditorialCommandEnvelope {
  const envelope = fixture.commands[index];
  assert.ok(envelope);
  return envelope;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Error &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code;
}

class FailingSaveRepository implements EditorialWorkflowRepository {
  readonly #inner = new InMemoryEditorialNewsRepository();
  #shouldFail = false;

  failNextSave(): void {
    this.#shouldFail = true;
  }

  findById(id: string): Promise<EditorialNews | undefined> {
    return this.#inner.findById(id);
  }

  getById(id: string): Promise<EditorialNews> {
    return this.#inner.getById(id);
  }

  async save(entity: EditorialNews, expectedVersion?: number): Promise<void> {
    if (this.#shouldFail) {
      this.#shouldFail = false;
      throw new Error("forced persistence failure");
    }
    await this.#inner.save(entity, expectedVersion);
  }

  listAuditEvents(entityId: string): Promise<readonly AuditEvent[]> {
    return this.#inner.listAuditEvents(entityId);
  }

  findProcessedCommand(
    idempotencyKey: string,
  ): Promise<PersistedCommandResult | undefined> {
    return this.#inner.findProcessedCommand(idempotencyKey);
  }
}
