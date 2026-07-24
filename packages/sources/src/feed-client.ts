import { SourceFetchError } from "./errors.ts";
import type { FetchedFeed, RadarLimits, SourceDefinition } from "./types.ts";

const ACCEPTED_CONTENT_TYPES = ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"];

export class OfficialFeedClient {
  readonly #fetch: typeof globalThis.fetch;

  constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetch = fetchImplementation;
  }

  async fetch(source: SourceDefinition, limits: RadarLimits): Promise<FetchedFeed> {
    let url = new URL(source.feedUrl);
    assertSafeUrl(url, source);
    for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
      try {
        return await this.fetchWithRedirects(url, source, limits);
      } catch (error) {
        if (attempt === limits.maxRetries || !isRetryable(error)) throw error;
      }
    }
    throw new SourceFetchError("FETCH_FAILED", "Official feed could not be fetched.");
  }

  private async fetchWithRedirects(initialUrl: URL, source: SourceDefinition, limits: RadarLimits): Promise<FetchedFeed> {
    let url = initialUrl;
    for (let redirect = 0; redirect <= limits.maxRedirects; redirect += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: "GET", redirect: "manual", signal: AbortSignal.timeout(limits.timeoutMs),
          headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml", "User-Agent": "sistemandrestudio-radar/0.1 (+read-only)" },
        });
      } catch {
        throw new SourceFetchError("FETCH_TIMEOUT_OR_NETWORK", "Official feed request failed or timed out.");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) throw new SourceFetchError("REDIRECT_INVALID", "Feed redirect has no location.");
        url = new URL(location, url);
        assertSafeUrl(url, source);
        continue;
      }
      if (!response.ok) throw new SourceFetchError(`HTTP_${response.status}`, "Official feed returned an unsuccessful status.");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!ACCEPTED_CONTENT_TYPES.some((accepted) => contentType.includes(accepted))) {
        throw new SourceFetchError("CONTENT_TYPE_REJECTED", "Feed response is not XML content.");
      }
      const body = await readLimitedBody(response, limits.maxResponseBytes);
      return {
        body,
        contentType,
        finalUrl: url.toString(),
        statusCode: response.status,
        responseBytes: Buffer.byteLength(body, "utf8"),
        redirectCount: redirect,
      };
    }
    throw new SourceFetchError("REDIRECT_LIMIT", "Feed exceeded redirect limit.");
  }
}

function assertSafeUrl(url: URL, source: SourceDefinition): void {
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    isForbiddenHostname(hostname) ||
    !source.allowedHosts.includes(hostname)
  ) {
    throw new SourceFetchError("URL_NOT_ALLOWED", "Feed URL is outside the official source allow-list.");
  }
}

function isForbiddenHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  if (/^(0|10|127)\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname) || /^192\.168\./.test(hostname)) return true;
  const private172 = hostname.match(/^172\.(\d{1,3})\./);
  if (private172 !== null) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  const ipv6 = hostname.replace(/^\[|\]$/g, "");
  return /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(ipv6);
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) throw new SourceFetchError("EMPTY_RESPONSE", "Feed response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new SourceFetchError("RESPONSE_TOO_LARGE", "Feed response exceeds configured size limit."); }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(combined);
}

function isRetryable(error: unknown): boolean {
  return error instanceof SourceFetchError && (error.code === "FETCH_TIMEOUT_OR_NETWORK" || error.code === "HTTP_408" || error.code === "HTTP_429" || /^HTTP_5/.test(error.code));
}
