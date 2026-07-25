import { createHash } from "node:crypto";

import { load } from "cheerio";

import { EvidenceAcquisitionError } from "./errors.ts";
import type {
  EvidenceLimits,
  ExtractedOfficialPage,
  OfficialPageFetch,
  OfficialPageMetadata,
  OfficialPageRelationship,
  OfficialPageType,
} from "./types.ts";

export function extractOfficialPage(
  fetched: OfficialPageFetch,
  relationship: OfficialPageRelationship,
  limits: EvidenceLimits,
): ExtractedOfficialPage {
  try {
    if (
      fetched.contentType.includes("application/json") ||
      fetched.contentType.includes("application/ld+json")
    ) {
      return extractJsonPage(fetched, relationship, limits);
    }
    return extractHtmlPage(fetched, relationship, limits);
  } catch (error) {
    if (error instanceof EvidenceAcquisitionError) throw error;
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_PARSE_FAILED",
      "Official page could not be parsed as bounded text.",
    );
  }
}

function extractHtmlPage(
  fetched: OfficialPageFetch,
  relationship: OfficialPageRelationship,
  limits: EvidenceLimits,
): ExtractedOfficialPage {
  const $ = load(fetched.body, { xmlMode: false });
  const jsonLd = extractJsonLd($);
  const metadata = extractMetadata($, jsonLd);
  const hadScripts = $("script").length > 0;

  $(
    "script,style,noscript,form,iframe,nav,footer,aside,canvas,svg," +
      "[hidden],[aria-hidden='true']",
  ).remove();
  $("[style]").each((_index, element) => {
    const style = ($(element).attr("style") ?? "").toLowerCase();
    if (
      style.includes("display:none") ||
      style.includes("display: none") ||
      style.includes("visibility:hidden") ||
      style.includes("visibility: hidden")
    ) {
      $(element).remove();
    }
  });

  const title = truncate(
    metadata.title ?? metadata.heading ?? "",
    limits.maxTitleLength,
  );
  const headings = unique(
    $("h1,h2,h3")
      .map((_index, element) => cleanText($(element).text()))
      .get()
      .filter(Boolean),
  ).slice(0, limits.maxHeadings);
  const paragraphs = $("main p,article p,[role='main'] p,p")
    .map((_index, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.length >= 30);
  const lists = $("main li,article li,[role='main'] li")
    .map((_index, element) => cleanText($(element).text()))
    .get()
    .filter((text) => text.length >= 15)
    .slice(0, 20);
  const minimalText = truncate(
    unique([...headings, ...paragraphs.slice(0, 8), ...lists]).join("\n"),
    limits.maxMinimalTextLength,
  );
  if (
    minimalText.length < 80 &&
    hadScripts &&
    ($("[id='root'],[id='app'],[data-reactroot]").length > 0 ||
      fetched.body.includes("__NEXT_DATA__"))
  ) {
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_JAVASCRIPT_REQUIRED",
      "Official page exposes no sufficient static content.",
    );
  }

  const summary = truncate(
    metadata.description ?? paragraphs[0] ?? minimalText,
    limits.maxSummaryLength,
  );
  const pageType = classifyOfficialPage(
    fetched.finalUrl,
    title,
    headings,
    metadata,
  );
  const relatedLinks = extractRelatedLinks($, fetched.finalUrl);
  const contentHash = contentHashFor({
    title,
    summary,
    headings,
    minimalText,
    metadata,
    pageType,
  });

  return {
    requestedUrl: fetched.requestedUrl,
    canonicalUrl: fetched.finalUrl,
    relationship,
    pageType,
    title,
    summary,
    headings,
    minimalText,
    metadata,
    relatedLinks,
    contentHash,
    fetchedAt: fetched.fetchedAt,
    fetch: withoutBody(fetched),
  };
}

function extractJsonPage(
  fetched: OfficialPageFetch,
  relationship: OfficialPageRelationship,
  limits: EvidenceLimits,
): ExtractedOfficialPage {
  const parsed: unknown = JSON.parse(fetched.body);
  if (!isRecord(parsed)) {
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_PARSE_FAILED",
      "Official JSON page must be an object.",
    );
  }
  const selected = selectSafeRecord(parsed);
  const title = truncate(
    stringValue(selected, ["name", "headline", "title"]) ?? "",
    limits.maxTitleLength,
  );
  const summary = truncate(
    stringValue(selected, ["description", "summary"]) ?? "",
    limits.maxSummaryLength,
  );
  const minimalText = truncate(
    [title, summary].filter(Boolean).join("\n"),
    limits.maxMinimalTextLength,
  );
  const metadata: OfficialPageMetadata = {
    title: title || undefined,
    description: summary || undefined,
    publishedAt: isoValue(
      stringValue(selected, ["datePublished", "published_at"]),
    ),
    updatedAt: isoValue(
      stringValue(selected, ["dateModified", "updated_at"]),
    ),
    version: stringValue(selected, ["version", "softwareVersion"]),
    availability: stringValue(selected, ["availability"]),
    product: stringValue(selected, ["product", "name"]),
    openGraph: {},
    twitter: {},
    jsonLd: [selected],
  };
  const pageType = classifyOfficialPage(
    fetched.finalUrl,
    title,
    [],
    metadata,
  );
  return {
    requestedUrl: fetched.requestedUrl,
    canonicalUrl: fetched.finalUrl,
    relationship,
    pageType,
    title,
    summary,
    headings: [],
    minimalText,
    metadata,
    relatedLinks: [],
    contentHash: contentHashFor({
      title,
      summary,
      minimalText,
      metadata,
      pageType,
    }),
    fetchedAt: fetched.fetchedAt,
    fetch: withoutBody(fetched),
  };
}

function extractMetadata(
  $: ReturnType<typeof load>,
  jsonLd: readonly Readonly<Record<string, unknown>>[],
): OfficialPageMetadata {
  const openGraph = metaGroup($, "property", "og:");
  const twitter = metaGroup($, "name", "twitter:");
  const heading = cleanText($("h1").first().text()) || undefined;
  const firstLd = jsonLd[0];
  return {
    title: cleanText($("title").first().text()) ||
      openGraph["og:title"] ||
      undefined,
    description:
      meta($, "name", "description") ??
      openGraph["og:description"] ??
      undefined,
    canonicalUrl: $("link[rel='canonical']").first().attr("href"),
    heading,
    author:
      meta($, "name", "author") ??
      stringValue(firstLd, ["author.name", "author"]),
    organization:
      stringValue(firstLd, ["publisher.name", "publisher", "organization"]),
    articleType: openGraph["og:type"] ?? stringValue(firstLd, ["@type"]),
    publishedAt: firstIso([
      meta($, "property", "article:published_time"),
      meta($, "name", "date"),
      stringValue(firstLd, ["datePublished"]),
      $("time[datetime]").first().attr("datetime"),
    ]),
    updatedAt: firstIso([
      meta($, "property", "article:modified_time"),
      stringValue(firstLd, ["dateModified"]),
    ]),
    version: firstString([
      meta($, "name", "version"),
      stringValue(firstLd, ["softwareVersion", "version"]),
      extractVersion(
        `${heading ?? ""} ${cleanText($("title").first().text())}`,
      ),
    ]),
    availability: firstString([
      stringValue(firstLd, ["offers.availability", "availability"]),
      meta($, "name", "availability"),
    ]),
    product: firstString([
      stringValue(firstLd, ["about.name", "itemReviewed.name", "product"]),
      openGraph["og:site_name"],
    ]),
    openGraph,
    twitter,
    jsonLd,
  };
}

function extractJsonLd(
  $: ReturnType<typeof load>,
): readonly Readonly<Record<string, unknown>>[] {
  const records: Readonly<Record<string, unknown>>[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    if (records.length >= 5) return;
    const raw = $(element).text();
    if (raw.length > 50_000) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isRecord(item) && records.length < 5) {
          records.push(selectSafeRecord(item));
        }
      }
    } catch {
      // Invalid JSON-LD is ignored; other metadata remains usable.
    }
  });
  return records;
}

function extractRelatedLinks(
  $: ReturnType<typeof load>,
  baseUrl: string,
): ExtractedOfficialPage["relatedLinks"] {
  const links: {
    url: string;
    relationship: Exclude<OfficialPageRelationship, "PRIMARY_ARTICLE">;
  }[] = [];
  $("a[href]").each((_index, element) => {
    if (links.length >= 20) return;
    const href = $(element).attr("href");
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    const relationship = relatedRelationship(
      `${url.pathname} ${cleanText($(element).text())}`,
    );
    if (relationship !== undefined) {
      links.push({ url: url.toString(), relationship });
    }
  });
  return uniqueBy(links, (link) => `${link.relationship}:${link.url}`);
}

export function classifyOfficialPage(
  urlValue: string,
  title: string,
  headings: readonly string[],
  metadata: OfficialPageMetadata,
): OfficialPageType {
  const url = new URL(urlValue);
  const strongText =
    `${url.hostname} ${url.pathname} ${title} ${metadata.articleType ?? ""}`
      .toLowerCase();
  const text = `${url.hostname} ${url.pathname} ${title} ${
    headings.join(" ")
  } ${metadata.articleType ?? ""}`.toLowerCase();
  if (/(security|advisory|cve)/.test(strongText)) {
    return "OFFICIAL_SECURITY_ADVISORY";
  }
  if (/(changelog|change-log|release-notes)/.test(text)) {
    return "OFFICIAL_CHANGELOG";
  }
  if (
    url.hostname === "github.com" &&
    /(\/releases?\/|\/tags?\/)/.test(url.pathname)
  ) {
    return "OFFICIAL_REPOSITORY_RELEASE";
  }
  if (/(\/releases?\/|\brelease\b|\bversion\b)/.test(text)) {
    return "OFFICIAL_RELEASE";
  }
  if (
    url.hostname.startsWith("docs.") ||
    /(documentation|\/docs?\/|reference|api reference)/.test(text)
  ) {
    return "OFFICIAL_DOCUMENTATION";
  }
  if (/(blog|article|blogposting|newsarticle)/.test(text)) {
    return "OFFICIAL_BLOG_POST";
  }
  return "UNKNOWN_OFFICIAL_PAGE";
}

function relatedRelationship(
  textValue: string,
): Exclude<OfficialPageRelationship, "PRIMARY_ARTICLE"> | undefined {
  const text = textValue.toLowerCase();
  if (/(security|advisory|cve)/.test(text)) {
    return "OFFICIAL_SECURITY_ADVISORY";
  }
  if (/(changelog|change-log|release-notes)/.test(text)) {
    return "OFFICIAL_CHANGELOG";
  }
  if (/(github\.com|repository|source code)/.test(text)) {
    return "OFFICIAL_REPOSITORY";
  }
  if (/(\/releases?\/|\brelease\b)/.test(text)) {
    return "OFFICIAL_RELEASE";
  }
  if (/(documentation|\/docs?\/|reference)/.test(text)) {
    return "OFFICIAL_DOCUMENTATION";
  }
  return undefined;
}

function meta(
  $: ReturnType<typeof load>,
  attribute: "name" | "property",
  value: string,
): string | undefined {
  return $(`meta[${attribute}='${value}']`).first().attr("content")?.trim() ||
    undefined;
}

function metaGroup(
  $: ReturnType<typeof load>,
  attribute: "name" | "property",
  prefix: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  $(`meta[${attribute}^='${prefix}']`).each((_index, element) => {
    const key = $(element).attr(attribute);
    const value = $(element).attr("content")?.trim();
    if (key && value && Object.keys(result).length < 20) result[key] = value;
  });
  return result;
}

function selectSafeRecord(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const allowed = [
    "@type", "name", "headline", "description", "datePublished",
    "dateModified", "author", "publisher", "organization", "about",
    "itemReviewed", "softwareVersion", "version", "availability", "offers",
    "product", "published_at", "updated_at",
  ];
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowed.includes(key))
      .slice(0, 30)
      .map(([key, item]) => [key, safeJsonValue(item, 0)]),
  );
}

function safeJsonValue(value: unknown, depth: number): unknown {
  if (depth > 2) return undefined;
  if (typeof value === "string") return truncate(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => safeJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [key, safeJsonValue(item, depth + 1)]),
    );
  }
  return undefined;
}

function stringValue(
  record: Readonly<Record<string, unknown>> | undefined,
  paths: readonly string[],
): string | undefined {
  if (record === undefined) return undefined;
  for (const path of paths) {
    let value: unknown = record;
    for (const segment of path.split(".")) {
      value = isRecord(value) ? value[segment] : undefined;
    }
    if (typeof value === "string" && value.trim()) {
      return truncate(value.trim(), 500);
    }
  }
  return undefined;
}

function firstIso(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const iso = isoValue(value);
    if (iso !== undefined) return iso;
  }
  return undefined;
}

function isoValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function firstString(
  values: readonly (string | undefined)[],
): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function extractVersion(value: string): string | undefined {
  return value.match(/\bv?(\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function contentHashFor(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function withoutBody(
  fetched: OfficialPageFetch,
): Omit<OfficialPageFetch, "body"> {
  const { body: _body, ...rest } = fetched;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
