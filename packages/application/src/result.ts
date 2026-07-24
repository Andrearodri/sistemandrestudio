import type {
  AuditEvent,
  EditorialNews,
  EditorialState,
} from "../../content-engine/src/index.ts";

export interface EditorialCommandResult {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly news: EditorialNews;
  readonly previousState: EditorialState | null;
  readonly newState: EditorialState;
  readonly events: readonly AuditEvent[];
  readonly currentVersion: number;
  readonly currentDraftVersionId: string | null;
  readonly replayed: boolean;
}
