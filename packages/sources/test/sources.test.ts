import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_RADAR_LIMITS, FeedParseError, OfficialFeedClient, SourceFetchError, canonicalizeUrl, normalizeCollectedItem, parseOfficialFeed, titleSimilarity } from "../src/index.ts";
import { getOfficialSource } from "../src/source-registry.ts";

const source = getOfficialSource("react-blog")!;
const rss = `<?xml version="1.0"?><rss><channel><item><guid>x-1</guid><title> React &amp; Automation </title><link>https://react.dev/blog/x?utm_source=test&amp;b=2</link><description><![CDATA[<p>Safe <b>summary</b></p>]]></description><pubDate>Fri, 24 Jul 2026 10:00:00 GMT</pubDate><category>react</category></item></channel></rss>`;
const atom = `<?xml version="1.0"?><feed><entry><id>a-1</id><title>Node API</title><link rel="alternate" href="https://nodejs.org/blog/a"/><summary>Update</summary><published>2026-07-24T10:00:00Z</published><category term="apis"/></entry></feed>`;

test("parses bounded RSS fixture and normalizes tracking URL", () => { const item=parseOfficialFeed(source,rss,DEFAULT_RADAR_LIMITS)[0]!; const normalized=normalizeCollectedItem(item,DEFAULT_RADAR_LIMITS); assert.equal(normalized.canonicalUrl,"https://react.dev/blog/x?b=2"); assert.equal(normalized.normalizedSummary,"Safe summary"); assert.equal(normalized.categories[0],"react"); });
test("parses Atom fixture", () => { const item=parseOfficialFeed(source,atom,DEFAULT_RADAR_LIMITS)[0]!; assert.equal(item.rawFormat,"ATOM"); assert.equal(item.externalId,"a-1"); });
test("rejects DTD and invalid feeds", () => { assert.throws(()=>parseOfficialFeed(source,"<!DOCTYPE rss><rss/>",DEFAULT_RADAR_LIMITS),FeedParseError); assert.throws(()=>parseOfficialFeed(source,"<html/>",DEFAULT_RADAR_LIMITS),FeedParseError); });
test("parses the sanitized GitHub namespace fixture with an HTML doctype inside CDATA", async () => {
  const xml = await readFile(new URL("./fixtures/github-blog-minimal.xml", import.meta.url), "utf8");
  const item = parseOfficialFeed(getOfficialSource("github-blog")!, xml, DEFAULT_RADAR_LIMITS)[0]!;
  assert.equal(item.rawFormat, "RSS");
  assert.equal(item.externalId, "official-example-1");
  assert.equal(item.title, "Official API update");
});
test("still rejects active external entity declarations outside CDATA", () => {
  assert.throws(
    () => parseOfficialFeed(source, `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel/></rss>`, DEFAULT_RADAR_LIMITS),
    FeedParseError,
  );
});
test("canonical URL removes known tracking identifiers", () => { assert.equal(canonicalizeUrl("https://EXAMPLE.com:443/a?gclid=1&z=2&utm_medium=x#part"),"https://example.com/a?z=2"); });
test("similarity is a penalty signal and never an exact discard", () => { assert.ok(titleSimilarity("Official API automation update","API automation official update") > 0.7); assert.equal(titleSimilarity("alpha","beta"),0); });
test("follows a limited redirect only when its final host is allow-listed", async () => {
  const calls: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    const url = input.toString();
    calls.push(url);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://feeds.example.com/feed.xml" } })
      : new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
  }) as typeof globalThis.fetch;
  const client = new OfficialFeedClient(mockFetch);
  const result = await client.fetch(
    { ...source, feedUrl: "https://example.com/feed", allowedHosts: ["example.com", "feeds.example.com"] },
    DEFAULT_RADAR_LIMITS,
  );
  assert.equal(result.redirectCount, 1);
  assert.equal(new URL(result.finalUrl).hostname, "feeds.example.com");
  assert.deepEqual(calls, ["https://example.com/feed", "https://feeds.example.com/feed.xml"]);
});
test("rejects a redirect to a host outside the fixed allow-list", async () => {
  const mockFetch = (async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } })) as typeof globalThis.fetch;
  await assert.rejects(
    new OfficialFeedClient(mockFetch).fetch(
      { ...source, feedUrl: "https://example.com/feed", allowedHosts: ["example.com"] },
      DEFAULT_RADAR_LIMITS,
    ),
    (error: unknown) => error instanceof SourceFetchError && error.code === "URL_NOT_ALLOWED",
  );
});
test("rejects localhost even if a malformed catalog attempted to allow it", async () => {
  let called = false;
  const mockFetch = (async () => { called = true; return new Response(); }) as typeof globalThis.fetch;
  await assert.rejects(
    new OfficialFeedClient(mockFetch).fetch(
      { ...source, feedUrl: "https://localhost/feed", allowedHosts: ["localhost"] },
      DEFAULT_RADAR_LIMITS,
    ),
    (error: unknown) => error instanceof SourceFetchError && error.code === "URL_NOT_ALLOWED",
  );
  assert.equal(called, false);
});
test("rejects private IPv4, IPv6 and encoded loopback URL forms", async () => {
  const mockFetch = (async () => new Response()) as typeof globalThis.fetch;
  for (const feedUrl of [
    "https://192.168.1.1/feed",
    "https://[fd00::1]/feed",
    "https://2130706433/feed",
  ]) {
    const hostname = new URL(feedUrl).hostname;
    await assert.rejects(
      new OfficialFeedClient(mockFetch).fetch(
        { ...source, feedUrl, allowedHosts: [hostname] },
        DEFAULT_RADAR_LIMITS,
      ),
      (error: unknown) => error instanceof SourceFetchError && error.code === "URL_NOT_ALLOWED",
    );
  }
});
