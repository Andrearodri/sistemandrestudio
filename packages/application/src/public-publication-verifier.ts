import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isForbiddenAddress } from "../../evidence/src/official-page-client.ts";
import {
  PUBLICATION_RECONCILIATION_POLICY,
  PublicationReconciliationError,
  type PublicationVerificationCheck,
  type PublicPublicationVerification,
  type PublicPublicationVerifier,
  type ReconciliationSource,
} from "./publication-reconciliation-service.ts";

export type PublicationAddressResolver = (
  hostname: string,
) => Promise<readonly { readonly address: string }[]>;

interface PublicFetchResult {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly redirectChain: readonly string[];
  readonly observedDate?: string;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const normalize = (value: string): string =>
  decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    eacute: "é",
    Eacute: "É",
    aacute: "á",
    Aacute: "Á",
    iacute: "í",
    Iacute: "Í",
    oacute: "ó",
    Oacute: "Ó",
    uacute: "ú",
    Uacute: "Ú",
    atilde: "ã",
    Atilde: "Ã",
    ccedil: "ç",
    Ccedil: "Ç",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (_match, entity: string) => {
      if (entity.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return named[entity] ?? named[entity.toLowerCase()] ?? `&${entity};`;
    },
  );
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(
    /([:@a-z][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    result[(match[1] ?? "").toLowerCase()] = decodeEntities(
      match[2] ?? match[3] ?? "",
    );
  }
  return result;
}

function metas(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const item = attributes(match[0]);
    const key = (item.name ?? item.property)?.toLowerCase();
    if (key !== undefined && item.content !== undefined) {
      result[key] = item.content;
    }
  }
  return result;
}

function links(html: string): readonly Record<string, string>[] {
  return [...html.matchAll(/<(?:a|link)\b[^>]*>/gi)].map((match) =>
    attributes(match[0])
  );
}

function title(html: string): string {
  return normalize(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
}

function htmlLanguage(html: string): string {
  return attributes(html.match(/<html\b[^>]*>/i)?.[0] ?? "").lang ?? "";
}

function jsonLd(html: string): readonly Readonly<Record<string, unknown>>[] {
  const records: Readonly<Record<string, unknown>>[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isRecord(item)) records.push(item);
        }
      } else if (isRecord(parsed)) {
        const graph = parsed["@graph"];
        if (Array.isArray(graph)) {
          for (const item of graph) {
            if (isRecord(item)) records.push(item);
          }
        }
        records.push(parsed);
      }
    } catch {
      // An invalid block is represented by the missing required JSON-LD check.
    }
  }
  return records;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeIncludes(
  record: Readonly<Record<string, unknown>>,
  expected: string,
): boolean {
  const value = record["@type"];
  return value === expected ||
    (Array.isArray(value) && value.includes(expected));
}

function canonicalFrom(html: string): string {
  return links(html).find((item) =>
    (item.rel ?? "").toLowerCase().split(/\s+/).includes("canonical")
  )?.href ?? "";
}

function anchorHrefs(html: string): readonly string[] {
  return [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => attributes(match[0]).href)
    .filter((value): value is string => value !== undefined);
}

function firstDraftLanguage(html: string): {
  readonly excerpt: string;
  readonly position: number;
} | undefined {
  const text = normalize(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " "),
  );
  const expressions = [
    "rascunho",
    "sujeito à revisão humana",
    "antes de qualquer uso",
    "não publicado",
    "pendente de aprovação",
  ];
  const positions = expressions
    .map((expression) => ({
      expression,
      position: text.toLocaleLowerCase("pt-BR").indexOf(expression),
    }))
    .filter((item) => item.position >= 0)
    .sort((left, right) => left.position - right.position);
  const first = positions[0];
  if (first === undefined) return undefined;
  return {
    excerpt: text.slice(first.position, first.position + 120),
    position: first.position,
  };
}

async function resolvePublicAddresses(
  hostname: string,
): Promise<readonly { readonly address: string }[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

export class SafePublicPublicationHttpClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #resolver: PublicationAddressResolver;

  constructor(
    fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
    resolver: PublicationAddressResolver = resolvePublicAddresses,
  ) {
    this.#fetch = fetchImplementation;
    this.#resolver = resolver;
  }

  async fetchText(
    value: string,
    kind: "HTML" | "TEXT",
    method: "GET" | "HEAD" = "GET",
  ): Promise<PublicFetchResult> {
    const requested = new URL(value);
    await this.#assertSafe(requested);
    let current = requested;
    const redirectChain: string[] = [];
    for (
      let redirects = 0;
      redirects <= PUBLICATION_RECONCILIATION_POLICY.maxRedirects;
      redirects += 1
    ) {
      let response: Response;
      try {
        response = await this.#fetch(current, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(
            PUBLICATION_RECONCILIATION_POLICY.requestTimeoutMs,
          ),
          headers: {
            Accept: method === "HEAD"
              ? "*/*"
              : kind === "HTML"
              ? "text/html,application/xhtml+xml"
              : "application/xml,text/xml,text/plain",
            "User-Agent":
              "sistemandrestudio-publication-verifier/0.1 (read-only)",
          },
        });
      } catch {
        throw new PublicationReconciliationError(
          "PUBLICATION_PUBLIC_REQUEST_FAILED",
          "Public verification request failed or timed out.",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (
          location === null ||
          redirects >= PUBLICATION_RECONCILIATION_POLICY.maxRedirects
        ) {
          throw new PublicationReconciliationError(
            "PUBLICATION_PUBLIC_REDIRECT_BLOCKED",
            "Public verification redirect is invalid or excessive.",
          );
        }
        const redirected = new URL(location, current);
        await this.#assertSafe(redirected);
        redirectChain.push(redirected.toString());
        current = redirected;
        continue;
      }
      if (!response.ok) {
        throw new PublicationReconciliationError(
          "PUBLICATION_PUBLIC_HTTP_FAILED",
          `Public verification returned HTTP ${response.status}.`,
        );
      }
      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      if (method === "GET") {
        const accepted = kind === "HTML"
          ? contentType.includes("text/html") ||
            contentType.includes("application/xhtml+xml")
          : contentType.includes("xml") || contentType.includes("text/plain");
        if (!accepted) {
          throw new PublicationReconciliationError(
            "PUBLICATION_PUBLIC_CONTENT_TYPE_BLOCKED",
            "Public verification received an unexpected content type.",
          );
        }
      } else if (
        contentType !== "" &&
        !contentType.startsWith("image/") &&
        !contentType.includes("octet-stream")
      ) {
        throw new PublicationReconciliationError(
          "PUBLICATION_PUBLIC_CONTENT_TYPE_BLOCKED",
          "Open Graph asset is not an image.",
        );
      }
      const maximum = kind === "HTML"
        ? PUBLICATION_RECONCILIATION_POLICY.maxHtmlBytes
        : PUBLICATION_RECONCILIATION_POLICY.maxTextBytes;
      const body = method === "HEAD"
        ? ""
        : await readBounded(response, maximum);
      return {
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        status: response.status,
        contentType,
        body,
        redirectChain,
        ...(response.headers.get("date") === null
          ? {}
          : { observedDate: response.headers.get("date")! }),
      };
    }
    throw new PublicationReconciliationError(
      "PUBLICATION_PUBLIC_REDIRECT_BLOCKED",
      "Public verification exceeded its redirect limit.",
    );
  }

  async #assertSafe(url: URL): Promise<void> {
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      !PUBLICATION_RECONCILIATION_POLICY.allowedHosts.includes(
        hostname as (typeof PUBLICATION_RECONCILIATION_POLICY.allowedHosts)[number],
      ) ||
      isForbiddenAddress(hostname)
    ) {
      throw new PublicationReconciliationError(
        "PUBLICATION_PUBLIC_DESTINATION_BLOCKED",
        "Public verification destination is outside the HTTPS allow-list.",
      );
    }
    let addresses: readonly { readonly address: string }[];
    try {
      addresses = isIP(hostname) === 0
        ? await this.#resolver(hostname)
        : [{ address: hostname }];
    } catch {
      throw new PublicationReconciliationError(
        "PUBLICATION_PUBLIC_DESTINATION_BLOCKED",
        "Public verification destination could not be safely resolved.",
      );
    }
    if (
      addresses.length === 0 ||
      addresses.some((item) => isForbiddenAddress(item.address))
    ) {
      throw new PublicationReconciliationError(
        "PUBLICATION_PUBLIC_DESTINATION_BLOCKED",
        "Public verification DNS includes a non-public address.",
      );
    }
  }
}

async function readBounded(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximum) {
    throw new PublicationReconciliationError(
      "PUBLICATION_PUBLIC_RESPONSE_TOO_LARGE",
      "Public verification response exceeds its limit.",
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new PublicationReconciliationError(
        "PUBLICATION_PUBLIC_RESPONSE_TOO_LARGE",
        "Public verification response exceeds its limit.",
      );
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

class CheckCollector {
  readonly checks: PublicationVerificationCheck[] = [];

  add(
    code: string,
    status: "PASS" | "WARN" | "FAIL",
    observedSummary: string,
    expectedValue?: string,
    metadata: Readonly<Record<string, unknown>> = {},
  ): void {
    this.checks.push({
      position: this.checks.length,
      code,
      status,
      ...(expectedValue === undefined ? {} : { expectedValue }),
      observedSummary: observedSummary.slice(0, 500),
      metadata,
    });
  }
}

export class DeterministicPublicPublicationVerifier
  implements PublicPublicationVerifier
{
  readonly #client: SafePublicPublicationHttpClient;

  constructor(client = new SafePublicPublicationHttpClient()) {
    this.#client = client;
  }

  async verify(input: {
    readonly source: ReconciliationSource;
    readonly publicUrl: string;
    readonly canonicalUrl: string;
    readonly startedAt: string;
    readonly completedAt: string;
  }): Promise<PublicPublicationVerification> {
    const collector = new CheckCollector();
    const base = `https://${PUBLICATION_RECONCILIATION_POLICY.canonicalHost}`;
    const resources = {
      home: [base + "/", "HTML"],
      blog: [base + "/blog/", "HTML"],
      article: [input.publicUrl, "HTML"],
      sitemap: [base + "/sitemap.xml", "TEXT"],
      robots: [base + "/robots.txt", "TEXT"],
      www: ["https://www.andrestudio.dev.br/", "HTML"],
    } as const;
    const fetched = new Map<string, PublicFetchResult>();
    for (const [name, [url, kind]] of Object.entries(resources)) {
      try {
        const result = await this.#client.fetchText(url, kind);
        fetched.set(name, result);
        collector.add(
          `${name.toUpperCase()}_REACHABLE`,
          "PASS",
          `HTTP ${result.status}; final host ${new URL(result.finalUrl).hostname}`,
          url,
          {
            redirectCount: result.redirectChain.length,
            redirectChain: result.redirectChain,
          },
        );
      } catch (error) {
        collector.add(
          `${name.toUpperCase()}_REACHABLE`,
          "FAIL",
          error instanceof PublicationReconciliationError
            ? error.code
            : "PUBLICATION_PUBLIC_REQUEST_FAILED",
          url,
        );
      }
    }

    const article = fetched.get("article");
    const blog = fetched.get("blog");
    const home = fetched.get("home");
    const sitemap = fetched.get("sitemap");
    const robots = fetched.get("robots");
    const www = fetched.get("www");
    const pkg = input.source.pkg;
    const expectedArticlePath = `/blog/${pkg.slug}/`;
    const expectedSource = pkg.citations[0]?.canonicalUrl ?? "";

    if (article !== undefined) {
      const html = article.body;
      const metadata = metas(html);
      const documentTitle = title(html);
      const canonicalUrl = canonicalFrom(html);
      const records = jsonLd(html);
      const articleRecord = records.find((record) =>
        typeIncludes(record, "Article") || typeIncludes(record, "NewsArticle")
      );
      const breadcrumbRecord = records.find((record) =>
        typeIncludes(record, "BreadcrumbList")
      );
      const hrefs = anchorHrefs(html);
      const bodyText = normalize(html).toLocaleLowerCase("pt-BR");
      const expectedTitle = pkg.title;
      collector.add(
        "ARTICLE_HTTPS_VALID",
        article.finalUrl.startsWith("https://") ? "PASS" : "FAIL",
        article.finalUrl,
        input.publicUrl,
      );
      collector.add(
        "ARTICLE_DOMAIN_ALLOWED",
        PUBLICATION_RECONCILIATION_POLICY.allowedHosts.includes(
            new URL(article.finalUrl)
              .hostname as (typeof PUBLICATION_RECONCILIATION_POLICY.allowedHosts)[number],
          )
          ? "PASS"
          : "FAIL",
        new URL(article.finalUrl).hostname,
      );
      collector.add(
        "ARTICLE_SLUG",
        new URL(article.finalUrl).pathname === expectedArticlePath
          ? "PASS"
          : "FAIL",
        new URL(article.finalUrl).pathname,
        expectedArticlePath,
      );
      collector.add(
        "ARTICLE_TITLE",
        documentTitle.includes(expectedTitle) ? "PASS" : "FAIL",
        documentTitle,
        expectedTitle,
      );
      collector.add(
        "ARTICLE_CANONICAL",
        canonicalUrl === input.canonicalUrl ? "PASS" : "FAIL",
        canonicalUrl || "missing",
        input.canonicalUrl,
      );
      collector.add(
        "ARTICLE_LANGUAGE",
        htmlLanguage(html).toLowerCase() === "pt-br" ? "PASS" : "FAIL",
        htmlLanguage(html) || "missing",
        "pt-BR",
      );
      collector.add(
        "ARTICLE_META_DESCRIPTION",
        (metadata.description ?? "").trim().length > 0 ? "PASS" : "FAIL",
        metadata.description === undefined ? "missing" : "present",
      );
      collector.add(
        "ARTICLE_AUTHOR",
        (metadata.author ?? "") === "André Rodrigues" ||
            bodyText.includes("andré rodrigues")
          ? "PASS"
          : "FAIL",
        metadata.author ?? "not found",
        "André Rodrigues",
      );
      collector.add(
        "ARTICLE_BRAND",
        normalize(metadata["og:site_name"] ?? "")
              .toLocaleLowerCase("pt-BR")
              .includes("andréstudio.dev") ||
            bodyText.includes("andrestudio.dev")
          ? "PASS"
          : "FAIL",
        metadata["og:site_name"] ?? "not found",
        "AndréStudio.dev",
      );
      collector.add(
        "ARTICLE_PUBLIC_DATE",
        !Number.isNaN(
            Date.parse(metadata["article:published_time"] ?? ""),
          )
          ? "PASS"
          : "FAIL",
        metadata["article:published_time"] ?? "missing",
      );
      collector.add(
        "ARTICLE_CATEGORY",
        (metadata["article:section"] ?? "").trim().length > 0
          ? "PASS"
          : "FAIL",
        metadata["article:section"] ?? "missing",
      );
      collector.add(
        "ARTICLE_OFFICIAL_SOURCE",
        expectedSource !== "" && hrefs.includes(expectedSource)
          ? "PASS"
          : "FAIL",
        expectedSource !== "" && hrefs.includes(expectedSource)
          ? "official citation linked"
          : "official citation missing",
        expectedSource,
      );
      collector.add(
        "ARTICLE_JSON_LD",
        articleRecord !== undefined ? "PASS" : "FAIL",
        articleRecord === undefined ? "missing or invalid" : "parseable Article",
      );
      collector.add(
        "BREADCRUMB_JSON_LD",
        breadcrumbRecord !== undefined ? "PASS" : "FAIL",
        breadcrumbRecord === undefined
          ? "missing or invalid"
          : "parseable BreadcrumbList",
      );
      collector.add(
        "ARTICLE_NO_LEGACY_CANONICAL",
        !canonicalUrl.includes(
            PUBLICATION_RECONCILIATION_POLICY.legacyTechnicalHost,
          )
          ? "PASS"
          : "FAIL",
        canonicalUrl || "missing",
      );
      collector.add(
        "ARTICLE_NO_LEGACY_ABSOLUTE_URL",
        !html.includes(
            `https://${PUBLICATION_RECONCILIATION_POLICY.legacyTechnicalHost}`,
          )
          ? "PASS"
          : "FAIL",
        "legacy absolute URL scan complete",
      );
      const draftLanguage = firstDraftLanguage(html);
      if (draftLanguage !== undefined) {
        collector.add(
          "PUBLIC_ARTICLE_CONTAINS_DRAFT_LANGUAGE",
          "WARN",
          draftLanguage.excerpt,
          undefined,
          { approximatePosition: draftLanguage.position },
        );
      }
      const ogImage = metadata["og:image"];
      if (ogImage !== undefined) {
        try {
          const image = await this.#client.fetchText(ogImage, "HTML", "HEAD");
          collector.add(
            "OPEN_GRAPH_IMAGE_REACHABLE",
            "PASS",
            `HTTP ${image.status}`,
            ogImage,
          );
        } catch (error) {
          collector.add(
            "OPEN_GRAPH_IMAGE_REACHABLE",
            "FAIL",
            error instanceof PublicationReconciliationError
              ? error.code
              : "PUBLICATION_PUBLIC_REQUEST_FAILED",
            ogImage,
          );
        }
      } else {
        collector.add(
          "OPEN_GRAPH_IMAGE_REACHABLE",
          "PASS",
          "not configured",
        );
      }
      if (article.observedDate !== undefined) {
        collector.add(
          "HTTP_DATE_OBSERVED",
          "PASS",
          article.observedDate,
          undefined,
          { interpretation: "HTTP_EVIDENCE_NOT_DEPLOY_TIME" },
        );
      }
    }

    if (blog !== undefined) {
      const hrefs = anchorHrefs(blog.body);
      const target = expectedArticlePath;
      const correctLink = hrefs.some((href) => {
        try {
          return new URL(href, base).pathname === target;
        } catch {
          return false;
        }
      });
      collector.add(
        "BLOG_ARTICLE_LINK",
        correctLink ? "PASS" : "FAIL",
        correctLink ? "article link found" : "article link missing",
        target,
      );
      collector.add(
        "BLOG_ARTICLE_TITLE",
        normalize(blog.body).includes(pkg.title) ? "PASS" : "FAIL",
        normalize(blog.body).includes(pkg.title)
          ? "card title found"
          : "card title missing",
        pkg.title,
      );
      const previous = [
        "/blog/google-gemini-3-6-flash/",
        "/blog/como-preparar-material-para-edicao-de-video/",
      ];
      collector.add(
        "BLOG_PREVIOUS_ARTICLES",
        previous.every((path) =>
            hrefs.some((href) => {
              try {
                return new URL(href, base).pathname === path;
              } catch {
                return false;
              }
            }),
        )
          ? "PASS"
          : "FAIL",
        "previous article link scan complete",
      );
    }

    if (sitemap !== undefined) {
      const parseable =
        /^\s*<\?xml[\s\S]*<urlset\b[\s\S]*<\/urlset>\s*$/i.test(sitemap.body);
      collector.add(
        "SITEMAP_XML_PARSEABLE",
        parseable ? "PASS" : "FAIL",
        parseable ? "urlset detected" : "invalid sitemap XML",
      );
      collector.add(
        "SITEMAP_ARTICLE_URL",
        sitemap.body.includes(`<loc>${input.canonicalUrl}</loc>`)
          ? "PASS"
          : "FAIL",
        sitemap.body.includes(`<loc>${input.canonicalUrl}</loc>`)
          ? "article URL found"
          : "article URL missing",
        input.canonicalUrl,
      );
    }

    if (robots !== undefined) {
      collector.add(
        "ROBOTS_SITEMAP",
        robots.body.includes(`${base}/sitemap.xml`) ? "PASS" : "WARN",
        robots.body.includes(`${base}/sitemap.xml`)
          ? "official sitemap declared"
          : "official sitemap declaration missing",
      );
    }

    if (home !== undefined) {
      const latestIsCurrent = home.body.includes(expectedArticlePath);
      collector.add(
        "HOMEPAGE_LATEST_ARTICLE_OUTDATED",
        latestIsCurrent ? "PASS" : "WARN",
        latestIsCurrent
          ? "current article referenced"
          : "older article remains highlighted",
        expectedArticlePath,
      );
      collector.add(
        "OFFICIAL_DOMAIN_REACHABLE",
        "PASS",
        home.finalUrl,
        base + "/",
      );
    }

    if (www !== undefined) {
      const wwwCanonical = canonicalFrom(www.body);
      const finalHostIsCanonical =
        new URL(www.finalUrl).hostname ===
          PUBLICATION_RECONCILIATION_POLICY.canonicalHost;
      let documentCanonicalIsCanonical = false;
      try {
        documentCanonicalIsCanonical =
          new URL(wwwCanonical).hostname ===
            PUBLICATION_RECONCILIATION_POLICY.canonicalHost;
      } catch {
        documentCanonicalIsCanonical = false;
      }
      collector.add(
        "WWW_DOMAIN_REACHABLE",
        "PASS",
        www.finalUrl,
        "https://www.andrestudio.dev.br/",
        { redirectChain: www.redirectChain },
      );
      collector.add(
        "CANONICAL_DOMAIN_CONFIRMED",
        finalHostIsCanonical || documentCanonicalIsCanonical
          ? "PASS"
          : "FAIL",
        finalHostIsCanonical
          ? www.finalUrl
          : wwwCanonical || "canonical missing",
        base + "/",
        {
          confirmationMethod: finalHostIsCanonical
            ? "REDIRECT_OR_FINAL_HOST"
            : "DOCUMENT_CANONICAL",
        },
      );
    }

    collector.add(
      "HTTPS_VALID",
      [...fetched.values()].every((item) =>
          item.finalUrl.startsWith("https://")
        )
        ? "PASS"
        : "FAIL",
      "all observed final URLs use HTTPS",
    );

    const warnings = collector.checks
      .filter((check) => check.status === "WARN")
      .map((check) => check.code);
    const failed = collector.checks.some((check) => check.status === "FAIL");
    const status = failed
      ? "FAILED"
      : warnings.length > 0
      ? "VERIFIED_WITH_WARNINGS"
      : "VERIFIED";
    const contentFingerprint = sha256(
      JSON.stringify(
        [...fetched.entries()].map(([name, item]) => [
          name,
          item.finalUrl,
          item.status,
          sha256(item.body),
        ]),
      ),
    );
    const verificationId =
      `publication-verification-${sha256(
        `${pkg.publicationId}:${input.publicUrl}:${contentFingerprint}:${PUBLICATION_RECONCILIATION_POLICY.version}`,
      ).slice(0, 24)}`;
    return {
      verificationId,
      publicationPackageId: pkg.publicationId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      status,
      httpStatus: article?.status ?? 0,
      finalUrl: article?.finalUrl ?? input.publicUrl,
      canonicalUrl: article === undefined
        ? input.canonicalUrl
        : canonicalFrom(article.body),
      contentFingerprint,
      warnings,
      checks: collector.checks,
    };
  }
}
