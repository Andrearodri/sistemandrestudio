import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { OfficialPagePolicyDefinition } from "../../sources/src/index.ts";
import { EvidenceAcquisitionError } from "./errors.ts";
import type {
  EvidenceLimits,
  OfficialPageFetch,
} from "./types.ts";

const ACCEPTED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "application/json",
  "application/ld+json",
] as const;

export type AddressResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string }[]>;

export class OfficialPageClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #resolve: AddressResolver;

  constructor(
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    resolver: AddressResolver = resolveAddresses,
  ) {
    this.#fetch = fetchImplementation;
    this.#resolve = resolver;
  }

  async fetchPage(
    value: string,
    policy: OfficialPagePolicyDefinition,
    limits: EvidenceLimits,
    fetchedAt: string,
    relationship: "PRIMARY" | "RELATED" = "PRIMARY",
    itemSignal?: AbortSignal,
  ): Promise<OfficialPageFetch> {
    const initialUrl = new URL(value);
    await this.assertSafeDestination(
      initialUrl,
      policy,
      relationship,
      itemSignal,
    );

    for (let attempt = 0; attempt <= limits.maxRetries; attempt += 1) {
      try {
        return await this.fetchWithRedirects(
          initialUrl,
          policy,
          limits,
          fetchedAt,
          relationship,
          itemSignal,
        );
      } catch (error) {
        if (attempt === limits.maxRetries || !isTransient(error)) {
          throw error;
        }
      }
    }
    throw new EvidenceAcquisitionError(
      "EVIDENCE_EXTRACTION_FAILED",
      "Official page acquisition exhausted its bounded retry.",
    );
  }

  async assertSafeDestination(
    url: URL,
    policy: OfficialPagePolicyDefinition,
    relationship: "PRIMARY" | "RELATED",
    itemSignal?: AbortSignal,
  ): Promise<void> {
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443")
    ) {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_NOT_ALLOWED",
        "Official pages require credential-free HTTPS on the allowed port.",
      );
    }

    const hostname = normalizeHostname(url.hostname);
    const allowedHosts = relationship === "PRIMARY"
      ? policy.entryHosts
      : [
          ...policy.entryHosts,
          ...policy.redirectHosts,
          ...policy.additionalOfficialHosts,
        ];
    if (!allowedHosts.includes(hostname) || !isAllowedPath(url, policy)) {
      throw new EvidenceAcquisitionError(
        relationship === "PRIMARY"
          ? "OFFICIAL_PAGE_NOT_ALLOWED"
          : "OFFICIAL_RELATED_LINK_NOT_ALLOWED",
        "Page host or path is outside the source policy.",
      );
    }

    if (isForbiddenAddress(hostname)) {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_PRIVATE_ADDRESS",
        "Page destination is not a public address.",
      );
    }

    let addresses: readonly { readonly address: string }[];
    try {
      addresses = isIP(hostname) === 0
        ? await awaitWithAbort(this.#resolve(hostname), itemSignal)
        : [{ address: hostname }];
    } catch {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_PRIVATE_ADDRESS",
        "Page destination could not be safely resolved.",
      );
    }
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isForbiddenAddress(entry.address))
    ) {
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_PRIVATE_ADDRESS",
        "Page DNS resolution includes a non-public address.",
      );
    }
  }

  private async fetchWithRedirects(
    initialUrl: URL,
    policy: OfficialPagePolicyDefinition,
    limits: EvidenceLimits,
    fetchedAt: string,
    relationship: "PRIMARY" | "RELATED",
    itemSignal?: AbortSignal,
  ): Promise<OfficialPageFetch> {
    let currentUrl = initialUrl;
    for (
      let redirectCount = 0;
      redirectCount <= limits.maxRedirects;
      redirectCount += 1
    ) {
      let response: Response;
      try {
        response = await this.#fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: itemSignal === undefined
            ? AbortSignal.timeout(limits.requestTimeoutMs)
            : AbortSignal.any([
                itemSignal,
                AbortSignal.timeout(limits.requestTimeoutMs),
              ]),
          headers: {
            Accept: ACCEPTED_CONTENT_TYPES.join(", "),
            "Accept-Encoding": "gzip, deflate, br",
            "User-Agent":
              "sistemandrestudio-evidence/0.1 (+read-only-official-pages)",
          },
        });
      } catch {
        throw new EvidenceAcquisitionError(
          "OFFICIAL_PAGE_TIMEOUT",
          "Official page request failed or timed out.",
        );
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirectCount >= limits.maxRedirects) {
          throw new EvidenceAcquisitionError(
            "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED",
            "Official page exceeded the redirect limit.",
          );
        }
        const location = response.headers.get("location");
        if (location === null) {
          throw new EvidenceAcquisitionError(
            "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED",
            "Official page redirect has no destination.",
          );
        }
        const redirected = new URL(location, currentUrl);
        try {
          await this.assertSafeDestination(
            redirected,
            policy,
            "RELATED",
            itemSignal,
          );
        } catch (error) {
          if (
            error instanceof EvidenceAcquisitionError &&
            error.code === "OFFICIAL_PAGE_PRIVATE_ADDRESS"
          ) {
            throw error;
          }
          throw new EvidenceAcquisitionError(
            "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED",
            "Redirect destination is outside the explicit allow-list.",
          );
        }
        currentUrl = redirected;
        continue;
      }

      if (!response.ok) {
        throw new EvidenceAcquisitionError(
          "EVIDENCE_EXTRACTION_FAILED",
          `Official page returned HTTP ${response.status}.`,
        );
      }
      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      if (
        !ACCEPTED_CONTENT_TYPES.some((accepted) =>
          contentType.includes(accepted)
        )
      ) {
        throw new EvidenceAcquisitionError(
          "OFFICIAL_PAGE_CONTENT_TYPE_NOT_ALLOWED",
          "Official page content type is outside the safe text allow-list.",
        );
      }
      const body = await readLimitedBody(response, limits.maxResponseBytes);
      return {
        requestedUrl: initialUrl.toString(),
        finalUrl: currentUrl.toString(),
        statusCode: response.status,
        contentType,
        responseBytes: Buffer.byteLength(body, "utf8"),
        redirectCount,
        body,
        fetchedAt,
      };
    }
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_REDIRECT_NOT_ALLOWED",
      "Official page exceeded the redirect limit.",
    );
  }
}

async function resolveAddresses(
  hostname: string,
): Promise<readonly { readonly address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function isAllowedPath(
  url: URL,
  policy: OfficialPagePolicyDefinition,
): boolean {
  const path = url.pathname;
  return policy.allowedPathPrefixes.some((prefix) => path.startsWith(prefix)) &&
    !policy.blockedPathPrefixes.some((prefix) => path.startsWith(prefix));
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isForbiddenAddress(value: string): boolean {
  const address = normalizeHostname(value);
  if (
    address === "localhost" ||
    address.endsWith(".localhost") ||
    address === "::" ||
    address === "::1"
  ) {
    return true;
  }

  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mapped !== undefined) return isForbiddenAddress(mapped);

  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const first = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    const third = octets[2] ?? 0;
    return first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0 && (third === 0 || third === 2)) ||
      (first === 192 && second === 88 && third === 99) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && third === 100) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224;
  }

  if (isIP(address) === 6) {
    return /^f[cd]/i.test(address) ||
      /^fe[89ab]/i.test(address) ||
      /^ff/i.test(address) ||
      /^2001:db8/i.test(address);
  }

  // Numeric and mixed-base host forms are normalized by URL, but reject any
  // remaining hostname composed only of numeric/address punctuation.
  return /^[0-9a-f:.x]+$/i.test(address);
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_TOO_LARGE",
      "Official page exceeds the configured response limit.",
    );
  }
  if (response.body === null) {
    throw new EvidenceAcquisitionError(
      "OFFICIAL_PAGE_PARSE_FAILED",
      "Official page response has no body.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new EvidenceAcquisitionError(
        "OFFICIAL_PAGE_TOO_LARGE",
        "Official page exceeds the configured response limit.",
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function isTransient(error: unknown): boolean {
  return error instanceof EvidenceAcquisitionError &&
    (error.code === "OFFICIAL_PAGE_TIMEOUT" ||
      error.message.includes("HTTP 408") ||
      error.message.includes("HTTP 429") ||
      /HTTP 5\d\d/.test(error.message));
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw signal.reason;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
