import type { EditorialCommand } from "../types.ts";
import type { RelevanceResult } from "./relevance-types.ts";

export function toScoreNewsCommand(
  result: RelevanceResult,
): Extract<EditorialCommand, { readonly type: "ScoreNews" }> {
  return { type: "ScoreNews", relevance: result };
}

export function toRelevanceRoutingCommand(
  result: RelevanceResult,
): Extract<
  EditorialCommand,
  {
    readonly type: "RequestVerification" | "DiscardLowRelevance";
  }
> {
  return result.value >= result.threshold
    ? { type: "RequestVerification" }
    : {
        type: "DiscardLowRelevance",
        reason: "Deterministic relevance score is below the policy threshold.",
      };
}
