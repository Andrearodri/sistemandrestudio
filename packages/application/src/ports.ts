import type {
  EditorialNewsRepository,
  PersistedCommandResult,
} from "../../content-engine/src/index.ts";

import type { EditorialCommandEnvelope } from "./command-envelope.ts";

export interface EditorialWorkflowRepository
  extends EditorialNewsRepository {
  findProcessedCommand(
    idempotencyKey: string,
  ): Promise<PersistedCommandResult | undefined>;
}

export interface CommandFingerprint {
  create(envelope: EditorialCommandEnvelope): string;
}
