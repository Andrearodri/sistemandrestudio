import { ConcurrentUpdateError, EntityNotFoundError } from "./errors.ts";
import type {
  AuditEvent,
  EditorialNews,
  ProcessedCommand,
} from "./types.ts";

export interface PersistedCommandResult {
  readonly idempotencyKey: string;
  readonly commandType: ProcessedCommand["commandType"];
  readonly fingerprint: string;
  readonly newsId: string;
  readonly result: {
    readonly state: EditorialNews["state"];
    readonly auditEventCount: number;
  };
}

export interface EditorialNewsRepository {
  findById(id: string): Promise<EditorialNews | undefined>;
  getById(id: string): Promise<EditorialNews>;
  save(entity: EditorialNews, expectedVersion?: number): Promise<void>;
  listAuditEvents(entityId: string): Promise<readonly AuditEvent[]>;
  findProcessedCommand(
    idempotencyKey: string,
  ): Promise<PersistedCommandResult | undefined>;
}

export class InMemoryEditorialNewsRepository
  implements EditorialNewsRepository
{
  readonly #entities = new Map<string, EditorialNews>();
  readonly #versions = new Map<string, number>();

  async findById(id: string): Promise<EditorialNews | undefined> {
    const entity = this.#entities.get(id);
    return entity === undefined ? undefined : structuredClone(entity);
  }

  async getById(id: string): Promise<EditorialNews> {
    const entity = await this.findById(id);
    if (entity === undefined) {
      throw new EntityNotFoundError(id);
    }
    return entity;
  }

  async save(
    entity: EditorialNews,
    expectedVersion = Math.max(0, entity.auditEvents.length - 1),
  ): Promise<void> {
    const currentVersion = this.#versions.get(entity.id);
    if (
      currentVersion !== undefined &&
      currentVersion !== expectedVersion
    ) {
      throw new ConcurrentUpdateError(entity.id, expectedVersion);
    }

    this.#entities.set(entity.id, structuredClone(entity));
    this.#versions.set(entity.id, entity.auditEvents.length);
  }

  async listAuditEvents(entityId: string): Promise<readonly AuditEvent[]> {
    return (await this.getById(entityId)).auditEvents;
  }

  async findProcessedCommand(
    idempotencyKey: string,
  ): Promise<PersistedCommandResult | undefined> {
    for (const entity of this.#entities.values()) {
      const command = entity.processedCommands.find(
        (item) => item.idempotencyKey === idempotencyKey,
      );
      if (command === undefined) {
        continue;
      }

      const eventIndex = entity.auditEvents.findIndex(
        (event) => event.idempotencyKey === idempotencyKey,
      );
      const event =
        eventIndex === -1 ? undefined : entity.auditEvents[eventIndex];

      return {
        idempotencyKey,
        commandType: command.commandType,
        fingerprint: command.fingerprint,
        newsId: entity.id,
        result: {
          state: event?.newState ?? "RECEIVED",
          auditEventCount: eventIndex + 1,
        },
      };
    }

    return undefined;
  }
}
