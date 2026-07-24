import { EntityNotFoundError } from "./errors.ts";
import type { AuditEvent, EditorialNews } from "./types.ts";

export interface EditorialNewsRepository {
  findById(id: string): EditorialNews | undefined;
  getById(id: string): EditorialNews;
  save(entity: EditorialNews): void;
  listAuditEvents(entityId: string): readonly AuditEvent[];
}

export class InMemoryEditorialNewsRepository
  implements EditorialNewsRepository
{
  readonly #entities = new Map<string, EditorialNews>();

  findById(id: string): EditorialNews | undefined {
    const entity = this.#entities.get(id);
    return entity === undefined ? undefined : structuredClone(entity);
  }

  getById(id: string): EditorialNews {
    const entity = this.findById(id);
    if (entity === undefined) {
      throw new EntityNotFoundError(id);
    }
    return entity;
  }

  save(entity: EditorialNews): void {
    this.#entities.set(entity.id, structuredClone(entity));
  }

  listAuditEvents(entityId: string): readonly AuditEvent[] {
    return this.getById(entityId).auditEvents;
  }
}

