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
  const explicitVersionSource =
    input.summary !== undefined &&
      /\b(introduc(?:e|es|ed|ing)|release[sd]?|launch(?:ed|es)?|version)\b/i
        .test(input.summary)
      ? input.summary
      : combined;
  const version = normalizeVersion(explicitVersionSource);

  if (
    /\b(preview|beta|early access)\b/.test(normalized) &&
    /\b(available|availability|introduc|announc|launch)\w*\b/.test(normalized)
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

  if (
    version !== undefined &&
    /\b(introduc(?:e|es|ed|ing)|release[sd]?|launch(?:ed|es)?|version)\b/.test(
      normalized,
    )
  ) {
    const subject = inferVersionSubject(explicitVersionSource, version);
    return subject === undefined
      ? noClaim("CLAIM_ENTITY_MISSING")
      : {
          claims: [{
            id,
            text: `${subject} version ${version} was officially released.`,
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
    /\b(chang(?:e|ed)|add(?:ed)?|remove[sd]?|deprecat\w*|support)\b/.test(
      normalized,
    )
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

function inferVersionSubject(value: string, normalizedVersion: string): string | undefined {
  const escaped = normalizedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(
    new RegExp(`([A-Za-z][A-Za-z0-9._+-]{1,40})\\s+(?:v|version\\s*)?${escaped.replace(/\\\.0$/, "(?:\\\\.0)?")}`, "i"),
  );
  return cleanSubject(match?.[1]) ?? inferSubject(value);
}

function inferSubject(value: string): string | undefined {
  const explicit = value.match(
    /\b(?:meet|introducing|introduces?|launched?|announc(?:e|es|ed|ing))\s+([A-Z][A-Za-z0-9._+-]*(?:\s+[A-Z][A-Za-z0-9._+-]*){0,2})/i,
  )?.[1];
  if (explicit !== undefined) return cleanSubject(explicit);
  const technical = value.match(
    /\b([A-Z][A-Za-z0-9]*\.(?:js|ai)|[A-Z][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/,
  )?.[1];
  return cleanSubject(technical);
}

function cleanSubject(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/[,:;.!?]+$/g, "").trim();
  return cleaned !== undefined && cleaned.length >= 2 && cleaned.length <= 80
    ? cleaned
    : undefined;
}
