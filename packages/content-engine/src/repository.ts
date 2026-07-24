import { ConcurrentUpdateError, EntityNotFoundError } from "./errors.ts";
import type { AuditEvent, EditorialNews } from "./types.ts";

export interface EditorialNewsRepository {
  findById(id: string): Promise<EditorialNews | undefined>;
  getById(id: string): Promise<EditorialNews>;
  save(entity: EditorialNews, expectedVersion?: number): Promise<void>;
  listAuditEvents(entityId: string): Promise<readonly AuditEvent[]>;
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
}
