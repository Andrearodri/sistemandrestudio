import { createHash } from "node:crypto";
import type { CollectedSourceItem, NormalizedSourceItem, RadarLimits } from "./types.ts";

export function normalizeCollectedItem(item: CollectedSourceItem, limits: RadarLimits): NormalizedSourceItem {
  const canonicalUrl = canonicalizeUrl(item.url);
  const normalizedTitle = normalizeText(item.title, limits.maxTitleLength);
  const normalizedSummary = item.summary === undefined ? undefined : normalizeText(item.summary, limits.maxSummaryLength);
  return { ...item, title: normalizedTitle, summary: normalizedSummary, canonicalUrl, normalizedTitle, normalizedSummary, publishedAt: normalizeDate(item.publishedAt), updatedAt: normalizeDate(item.updatedAt), contentHash: hash([item.sourceId, item.externalId ?? "", canonicalUrl, normalizedTitle, item.publishedAt ?? ""]) };
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value.replace(/&amp;/gi, "&"));
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) item URLs are accepted.");
  url.hostname = url.hostname.toLowerCase(); url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.*|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  return url.toString();
}

export function normalizeDate(value: string | undefined): string | undefined { if (value === undefined) return undefined; const time = Date.parse(value); return Number.isNaN(time) ? undefined : new Date(time).toISOString(); }
export function normalizeText(value: string, maxLength: number): string { return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength); }
export function hash(parts: readonly string[]): string { return createHash("sha256").update(parts.join("\u001f")).digest("hex"); }
