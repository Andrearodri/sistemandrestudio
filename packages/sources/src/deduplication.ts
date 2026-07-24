import type { NormalizedSourceItem } from "./types.ts";

export type ExactDuplicateMatch = "CANONICAL_URL" | "EXTERNAL_ID" | "CONTENT_HASH";

export function exactDuplicateMatch(item: NormalizedSourceItem, candidate: NormalizedSourceItem): ExactDuplicateMatch | undefined {
  if (item.sourceId !== candidate.sourceId) return undefined;
  if (item.canonicalUrl === candidate.canonicalUrl) return "CANONICAL_URL";
  if (item.externalId !== undefined && item.externalId === candidate.externalId) return "EXTERNAL_ID";
  return item.contentHash === candidate.contentHash ? "CONTENT_HASH" : undefined;
}

export function titleSimilarity(left: string, right: string): number {
  const a = new Set(tokens(left)); const b = new Set(tokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}
function tokens(value: string): readonly string[] { return value.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter((token) => token.length > 2); }
