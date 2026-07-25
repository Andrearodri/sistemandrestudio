import type { EntityMatchMethod } from "./types.ts";

export const EVIDENCE_ENTITY_ALIAS_CATALOG_VERSION =
  "evidence-entity-aliases-v1";

export const EVIDENCE_ENTITY_ALIASES_V1: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "node.js": Object.freeze(["nodejs", "node js"]),
    "litert.js": Object.freeze(["litert js", "litert-js"]),
  });

export interface EntityMatchResult {
  readonly method: EntityMatchMethod;
  readonly claim: string;
  readonly page?: string | undefined;
}

export function normalizeEntity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[`'’"]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}.+/ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeVersion(value: string): string | undefined {
  const pattern = /\b(?:(version)\s*)?(v)?(\d+(?:\.\d+){0,2})\b/gi;
  let matched: RegExpExecArray | null;
  while ((matched = pattern.exec(value)) !== null) {
    const numeric = matched[3]!;
    const prefix = value.slice(Math.max(0, matched.index - 8), matched.index);
    if (/\bpart\s*$/i.test(prefix)) continue;
    if (
      !numeric.includes(".") &&
      matched[1] === undefined &&
      matched[2] === undefined
    ) {
      continue;
    }
    const parts = numeric.split(".");
    while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
    return parts.join(".");
  }
  return undefined;
}

export function matchEntity(
  claimEntity: string,
  pageEntities: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>> =
    EVIDENCE_ENTITY_ALIASES_V1,
): EntityMatchResult {
  const claimNormalized = normalizeEntity(claimEntity);
  let best: EntityMatchResult | undefined;
  const priority: Record<EntityMatchMethod, number> = {
    EXACT_IDENTIFIER: 4,
    NORMALIZED_EXACT: 3,
    EXPLICIT_ALIAS: 2,
    PARTIAL_UNIQUE_MATCH: 1,
    NO_MATCH: 0,
  };
  for (const pageEntity of pageEntities) {
    if (claimEntity.toLowerCase() === pageEntity.toLowerCase()) {
      return { method: "EXACT_IDENTIFIER", claim: claimEntity, page: pageEntity };
    }
    const pageNormalized = normalizeEntity(pageEntity);
    if (claimNormalized === pageNormalized) {
      best = { method: "NORMALIZED_EXACT", claim: claimEntity, page: pageEntity };
      continue;
    }
    const candidate: EntityMatchResult | undefined =
      isExplicitAlias(claimNormalized, pageNormalized, aliases)
        ? { method: "EXPLICIT_ALIAS", claim: claimEntity, page: pageEntity }
        : isSafePartialMatch(claimNormalized, pageNormalized)
        ? {
        method: "PARTIAL_UNIQUE_MATCH",
        claim: claimEntity,
        page: pageEntity,
      }
        : undefined;
    if (
      candidate !== undefined &&
      (best === undefined || priority[candidate.method] > priority[best.method])
    ) {
      best = candidate;
    }
  }
  return best ?? { method: "NO_MATCH", claim: claimEntity };
}

function isExplicitAlias(
  left: string,
  right: string,
  aliases: Readonly<Record<string, readonly string[]>>,
): boolean {
  for (const [canonical, variants] of Object.entries(aliases)) {
    const family = [canonical, ...variants].map(normalizeEntity);
    if (family.includes(left) && family.includes(right)) return true;
  }
  return false;
}

function isSafePartialMatch(left: string, right: string): boolean {
  const stripSuffix = (value: string) =>
    value.replace(/\s+(api|sdk|cli|js|ai)$/i, "").trim();
  const leftBase = stripSuffix(left);
  const rightBase = stripSuffix(right);
  const suffixEquivalent = leftBase.length >= 4 &&
    rightBase.length >= 4 &&
    leftBase === rightBase &&
    left !== right;
  const uniqueExpressionContained = leftBase.length >= 4 &&
    new RegExp(
      `(?:^|\\s)${escapeRegExp(leftBase)}(?:$|\\s)`,
    ).test(rightBase);
  return suffixEquivalent || uniqueExpressionContained;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
