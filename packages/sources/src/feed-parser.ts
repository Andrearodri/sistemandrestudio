import { XMLParser } from "fast-xml-parser";
import { FeedParseError } from "./errors.ts";
import type { CollectedSourceItem, RadarLimits, SourceDefinition } from "./types.ts";

export function parseOfficialFeed(source: SourceDefinition, xml: string, limits: RadarLimits): readonly CollectedSourceItem[] {
  if (Buffer.byteLength(xml, "utf8") > limits.maxResponseBytes) throw new FeedParseError("Feed XML exceeds configured size limit.");
  if (containsActiveDtdOrEntity(xml)) throw new FeedParseError("DTD and entity declarations are not accepted.");
  let document: Record<string, unknown>;
  try {
    document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text", removeNSPrefix: true, trimValues: true, processEntities: false }).parse(xml);
  } catch { throw new FeedParseError("Feed XML is invalid."); }
  if (isRecord(document.rss)) return parseRss(source.id, document.rss, limits);
  if (isRecord(document.feed)) return parseAtom(source.id, document.feed, limits);
  throw new FeedParseError("Feed root is neither RSS nor Atom.");
}

function containsActiveDtdOrEntity(xml: string): boolean {
  const withoutCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  return /<!DOCTYPE|<!ENTITY/i.test(withoutCdata);
}

function parseRss(sourceId: string, rss: Record<string, unknown>, limits: RadarLimits): readonly CollectedSourceItem[] {
  const channel = isRecord(rss.channel) ? rss.channel : undefined;
  if (channel === undefined) throw new FeedParseError("RSS feed has no channel.");
  return asArray(channel.item).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const url = text(entry.link); const title = text(entry.title);
    if (!url || !title) return [];
    return [{ sourceId, externalId: text(entry.guid), url, title: limit(title, limits.maxTitleLength), summary: optionalLimit(text(entry.description) ?? text(entry.encoded), limits.maxSummaryLength), publishedAt: text(entry.pubDate), updatedAt: text(entry.updated), categories: asArray(entry.category).flatMap((category) => text(category) ?? []), rawFormat: "RSS" as const }];
  }).slice(0, limits.maxItemsPerSource);
}

function parseAtom(sourceId: string, feed: Record<string, unknown>, limits: RadarLimits): readonly CollectedSourceItem[] {
  return asArray(feed.entry).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const url = atomLink(entry.link); const title = text(entry.title);
    if (!url || !title) return [];
    return [{ sourceId, externalId: text(entry.id), url, title: limit(title, limits.maxTitleLength), summary: optionalLimit(text(entry.summary) ?? text(entry.content), limits.maxSummaryLength), publishedAt: text(entry.published), updatedAt: text(entry.updated), categories: asArray(entry.category).flatMap((category) => (isRecord(category) ? text(category["@term"]) : text(category)) ?? []), rawFormat: "ATOM" as const }];
  }).slice(0, limits.maxItemsPerSource);
}

function atomLink(value: unknown): string | undefined { for (const link of asArray(value)) { if (isRecord(link) && (link["@rel"] === undefined || link["@rel"] === "alternate")) return text(link["@href"]); } return undefined; }
function asArray(value: unknown): readonly unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function text(value: unknown): string | undefined { const result = typeof value === "string" ? value : isRecord(value) && typeof value["#text"] === "string" ? value["#text"] : undefined; const trimmed = result?.trim(); return trimmed ? trimmed : undefined; }
function optionalLimit(value: string | undefined, length: number): string | undefined { return value === undefined ? undefined : limit(value, length); }
function limit(value: string, length: number): string { return value.slice(0, length); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
