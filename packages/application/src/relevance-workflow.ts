import {
  calculateRelevance,
  toRelevanceRoutingCommand,
  toScoreNewsCommand,
} from "../../content-engine/src/index.ts";
import type {
  RelevanceInput,
  RelevancePolicy,
  RelevanceResult,
} from "../../content-engine/src/index.ts";
import type { Actor } from "../../shared/src/index.ts";

import type { EditorialWorkflowService } from "./editorial-workflow-service.ts";
import type { EditorialCommandResult } from "./result.ts";

export interface RelevanceCommandMetadata {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly actor: Actor;
  readonly occurredAt: string;
  readonly expectedVersion?: number;
}

export interface ExecuteRelevanceWorkflowInput {
  readonly newsId: string;
  readonly input: RelevanceInput;
  readonly policy: RelevancePolicy;
  readonly scoring: RelevanceCommandMetadata;
  readonly routing: Omit<RelevanceCommandMetadata, "expectedVersion">;
}

export interface ExecuteRelevanceWorkflowResult {
  readonly relevance: RelevanceResult;
  readonly scoring: EditorialCommandResult;
  readonly routing: EditorialCommandResult;
}

export async function executeRelevanceWorkflow(
  service: EditorialWorkflowService,
  request: ExecuteRelevanceWorkflowInput,
): Promise<ExecuteRelevanceWorkflowResult> {
  const relevance = calculateRelevance(request.input, request.policy);
  const scoring = await service.execute({
    commandId: request.scoring.commandId,
    idempotencyKey: request.scoring.idempotencyKey,
    newsId: request.newsId,
    command: toScoreNewsCommand(relevance),
    actor: request.scoring.actor,
    occurredAt: request.scoring.occurredAt,
    ...(request.scoring.expectedVersion === undefined
      ? {}
      : { expectedVersion: request.scoring.expectedVersion }),
  });
  const routing = await service.execute({
    commandId: request.routing.commandId,
    idempotencyKey: request.routing.idempotencyKey,
    newsId: request.newsId,
    command: toRelevanceRoutingCommand(relevance),
    actor: request.routing.actor,
    occurredAt: request.routing.occurredAt,
    expectedVersion: scoring.currentVersion,
  });

  return { relevance, scoring, routing };
}
