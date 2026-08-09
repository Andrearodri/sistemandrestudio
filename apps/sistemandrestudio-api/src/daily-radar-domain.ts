import { createHmac, timingSafeEqual } from "node:crypto";

export const DAILY_RADAR_SOURCE_IDS = Object.freeze([
  "cloudflare-blog", "github-blog", "nodejs-blog", "google-developers-blog", "react-blog",
]);

export interface DailyRadarCandidate {
  readonly newsId: string;
  readonly verificationId: string;
  readonly newsVersion: number;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly title: string;
  readonly officialLink: string;
  readonly publishedAt: string;
  readonly relevance: number;
  readonly supportedFacts: readonly string[];
  readonly summary?: string;
}

export function selectDailyRadarCandidates(items: readonly DailyRadarCandidate[], maximum = 5) {
  const permitted = new Set(DAILY_RADAR_SOURCE_IDS);
  const unique = new Map<string, DailyRadarCandidate>();
  for (const item of items) {
    if (!permitted.has(item.sourceId) || item.supportedFacts.length === 0) continue;
    const key = new URL(item.officialLink).toString();
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()]
    .sort((a, b) => b.relevance - a.relevance || b.publishedAt.localeCompare(a.publishedAt) || a.newsId.localeCompare(b.newsId))
    .slice(0, Math.max(0, Math.min(5, maximum)));
}

export function validateRadarSummary(value: string) {
  const sentences = value.match(/[^.!?]+[.!?](?=\s|$)/gu) ?? [];
  if (sentences.length < 2 || sentences.length > 3 || value.length > 600) throw new Error("DAILY_RADAR_SUMMARY_STRUCTURE_INVALID");
  if (/\b(?:pre[çc]o|gratuit|pag[oa]|dispon[ií]vel|testamos|usamos|experimentamos)\b|\d/iu.test(value)) {
    throw new Error("DAILY_RADAR_SUMMARY_UNSUPPORTED_SPECIFIC");
  }
  return value.trim();
}

export function formatDailyRadarMessage(items: readonly (DailyRadarCandidate & { readonly summary: string })[]) {
  if (items.length === 0) return "Nenhuma novidade oficial elegível nesta rodada.";
  return ["Radar Diário AndréStudio.dev", ...items.flatMap((item, index) => [
    "", `${index + 1}. ${item.title}`, `Fonte: ${item.sourceName}`, `Resumo: ${item.summary}`, `Link oficial: ${item.officialLink}`,
  ])].join("\n");
}

export function signDailyRadarCallback(secret: string, runId: string, action: string) {
  const payload = `dr:${runId}:${action}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url").slice(0, 12);
  return `${payload}:${signature}`;
}

export function parseDailyRadarCallback(secret: string, value: string) {
  const match = value.match(/^dr:([a-z0-9-]{8,80}):(end|select-[1-5]|approve|reject|changes):([A-Za-z0-9_-]{12})$/u);
  if (!match) throw new Error("DAILY_RADAR_CALLBACK_INVALID");
  const [, runId, action, signature] = match as [string, string, string, string];
  const expected = signDailyRadarCallback(secret, runId, action).split(":").at(-1)!;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("DAILY_RADAR_CALLBACK_INVALID");
  return { runId, action };
}

export function resolveDailyRadarSelection(priorAction: string | undefined, action: string) {
  if (priorAction === undefined) return { replayed: false as const, action };
  if (priorAction !== action) throw new Error("DAILY_RADAR_SELECTION_CONFLICT");
  return { replayed: true as const, action };
}
