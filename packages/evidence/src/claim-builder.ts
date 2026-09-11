import type { VerificationClaim } from "../../content-engine/src/index.ts";
import { normalizeVersion } from "./entity-normalizer.ts";
import type { EvidenceDiagnosticCode } from "./types.ts";

export interface DeterministicClaimInput {
  readonly newsId: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly publishedAt?: string | undefined;
}

export interface DeterministicClaimResult {
  readonly claims: readonly VerificationClaim[];
  readonly codes: readonly EvidenceDiagnosticCode[];
}

export function buildDeterministicClaims(
  input: DeterministicClaimInput,
): DeterministicClaimResult {
  const combined = `${input.title}. ${input.summary ?? ""}`.trim();
  const normalized = combined.toLowerCase();
  const id = `${input.newsId}-official-page-claim`;
  const versionContext = findReleasedVersion(combined);

  if (
    /\b(preview|beta|early access)\b/.test(normalized) &&
    /\b(available|availability|introduc|announc|launch|offer|provid)\w*\b/.test(normalized)
  ) {
    const subject = inferSubject(combined);
    return subject === undefined
      ? noClaim("CLAIM_ENTITY_MISSING")
      : {
          claims: [{
            id,
            text: `${subject} was announced as preview or beta.`,
            type: "FEATURE_RELEASE",
            importance: "PRIMARY",
            expectedSubject: subject,
          }],
          codes: [],
        };
  }

  if (versionContext !== undefined) {
    const subject = inferVersionSubject(combined, versionContext.version);
    return subject === undefined
      ? noClaim("CLAIM_ENTITY_MISSING")
      : {
          claims: [{
            id,
          text: `${subject} version ${versionContext.version} was officially released.`,
            type: "VERSION_RELEASE",
            importance: "PRIMARY",
            expectedSubject: subject,
          }],
          codes: [],
        };
  }

  if (
    /\b(meet|introduc(?:e|es|ed|ing)|launch(?:ed|es|ing)?|announc(?:e|es|ed|ing))\b/.test(
      normalized,
    )
  ) {
    const subject = inferSubject(combined);
    return subject === undefined
      ? noClaim("CLAIM_ENTITY_MISSING")
      : {
          claims: [{
            id,
            text: `${subject} was officially announced.`,
            type: "PRODUCT_LAUNCH",
            importance: "PRIMARY",
            expectedSubject: subject,
          }],
          codes: [],
        };
  }

  if (
    /\b(api|endpoint|sdk|cli)\b/.test(normalized) &&
    /\b(chang(?:e|ed)|add(?:ed)?|remove[sd]?|deprecat\w*|support|introduc\w*|launch\w*|announc\w*|offer\w*|provid\w*)\b/.test(normalized)
  ) {
    const subject = inferSubject(combined);
    return subject === undefined
      ? noClaim("CLAIM_ENTITY_MISSING")
      : {
          claims: [{
            id,
            text: `${subject} received the documented API change.`,
            type: "API_CHANGE",
            importance: "PRIMARY",
            expectedSubject: subject,
          }],
          codes: [],
        };
  }

  return noClaim(
    /\b(how|guide|tutorial|part \d|built with|scaling)\b/.test(normalized)
      ? "NO_VERIFIABLE_CLAIM"
      : "CLAIM_TOO_GENERIC",
  );
}

function noClaim(code: EvidenceDiagnosticCode): DeterministicClaimResult {
  return { claims: [], codes: [code] };
}

function findReleasedVersion(value: string): { version: string } | undefined {
  const tokens = /\b(?:version\s*|v)?(\d+(?:\.\d+){1,2})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(value)) !== null) {
    const numeric = match[1]!;
    const context = value.slice(Math.max(0, match.index - 42), Math.min(value.length, match.index + match[0].length + 42));
    if (!/\b(?:introduc\w*|release\w*|launch\w*|announc\w*)\b/i.test(context)) continue;
    if (/\b(?:isolates|runtime|engine)\b/i.test(context) && /^v/i.test(match[0])) continue;
    const version = normalizeVersion(`version ${numeric}`);
    if (version !== undefined) return { version };
  }
  return undefined;
}

function inferVersionSubject(value: string, normalizedVersion: string): string | undefined {
  const escaped = normalizedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(
    new RegExp(`([A-Za-z][A-Za-z0-9._+-]{1,40})\\s+(?:v|version\\s*)?${escaped.replace(/\\\.0$/, "(?:\\\\.0)?")}`, "i"),
  );
  return cleanSubject(match?.[1]) ?? inferSubject(value);
}

function inferSubject(value: string): string | undefined {
  const explicit = value.match(/\b(?:meet|introducing|introduces?|launched?|announc(?:e|es|ed|ing))\s+([A-Z][A-Za-z0-9._+-]*)/i)?.[1];
  if (explicit !== undefined && !GENERIC_SUBJECTS.has(explicit.toLowerCase())) return cleanSubject(explicit);
  const product = value.match(/\b([A-Z][a-z]+(?:\s+[A-Z][A-Za-z0-9]+){1,5})\s+(?:now\s+)?(?:offers|provides|introduces|supports)\b/)?.[1];
  if (product !== undefined) return cleanSubject(product);
  const namedPhrase = value.match(/\b(Agent Skills|WebMCP|Kitesurf|MCP)\b/)?.[1];
  if (namedPhrase !== undefined) return cleanSubject(namedPhrase);
  const technical = value.match(/\b([A-Z][a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[A-Za-z0-9]*|[A-Z][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/)?.[1];
  return cleanSubject(technical);
}

const GENERIC_SUBJECTS = new Set(["the", "a", "an", "any", "this"]);

function cleanSubject(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[,:;.!?]+$/g, "").trim();
  return cleaned !== undefined && cleaned.length >= 2 && cleaned.length <= 80
    ? cleaned
    : undefined;
}
