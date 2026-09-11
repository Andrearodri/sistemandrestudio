import { createHash } from "node:crypto";

import type { EditorialNews } from "./types.ts";
import type {
  FactualVerificationResult,
  VerificationClaim,
  VerificationEvidence,
} from "./verification/types.ts";

/** The policy is deliberately separate from a future language-model adapter. */
export const ANDRE_STUDIO_EDITORIAL_DRAFT_POLICY_V1 = {
  id: "andre-studio-editorial-draft",
  version: "andre-studio-editorial-draft-v1",
} as const;

export type EditorialEligibility =
  | "ALLOW_DRAFT"
  | "ALLOW_RESTRICTED_DRAFT"
  | "BLOCK_DRAFT";
export type EditorialFormat = "LINKEDIN_SHORT_POST" | "WEBSITE_NEWS_BRIEF";
export type DraftValidationStatus = "VALID" | "VALID_WITH_WARNINGS" | "BLOCKED";
export type EditorialClaimClassification =
  | "CONFIRMED_AND_ALLOWED"
  | "CONFIRMED_WITH_LIMITATIONS"
  | "REQUIRES_HUMAN_REVIEW"
  | "PROHIBITED";

export interface EditorialClaimReference {
  readonly claimId: string;
  readonly originalText: string;
  readonly normalizedText: string;
  readonly importance: VerificationClaim["importance"];
  readonly factualStatus: string;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly classification: EditorialClaimClassification;
  readonly reason: string;
}

export interface AllowedEditorialFact {
  readonly factId: string;
  readonly claimId: string;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: number;
  readonly restrictions: readonly string[];
}

export interface EditorialWarning { readonly code: string; readonly message: string }
export interface EditorialCitation {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly sourceId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly publishedAt?: string;
}

export interface EditorialBrief {
  readonly briefId: string;
  readonly newsId: string;
  readonly verificationId: string;
  readonly relevanceScore: number;
  readonly relevancePriority: string;
  readonly verificationStatus: string;
  readonly editorialEligibility: EditorialEligibility;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly subject: Readonly<Record<string, string | undefined>>;
  readonly confirmedClaims: readonly EditorialClaimReference[];
  readonly restrictedClaims: readonly EditorialClaimReference[];
  readonly prohibitedClaims: readonly EditorialClaimReference[];
  readonly evidenceReferences: readonly EditorialCitation[];
  readonly sourceReferences: readonly EditorialCitation[];
  readonly allowedFacts: readonly AllowedEditorialFact[];
  readonly warnings: readonly EditorialWarning[];
  readonly requiredDisclosures: readonly string[];
  readonly prohibitedStatements: readonly string[];
  readonly suggestedAngles: readonly string[];
  readonly suggestedFormats: readonly EditorialFormat[];
}

export interface EditorialDraft {
  readonly draftId: string;
  readonly newsId: string;
  readonly briefId: string;
  readonly format: EditorialFormat;
  readonly language: "pt-BR";
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
  readonly sourceCitations: readonly EditorialCitation[];
  readonly warnings: readonly EditorialWarning[];
  readonly prohibitedClaimsChecked: boolean;
  readonly validationStatus: DraftValidationStatus;
  readonly generatorId: string;
  readonly generatorVersion: string;
  readonly createdAt: string;
}

export interface EditorialGenerationInput {
  readonly brief: EditorialBrief;
  readonly format: EditorialFormat;
  readonly language: "pt-BR";
  readonly tone: "profissional" | "claro" | "direto" | "informativo";
  readonly maxCharacters: number;
  readonly editorialIdentityVersion: string;
}
export interface EditorialGeneratedText { readonly title: string; readonly subtitle?: string; readonly body: string }
export interface EditorialTextGenerator {
  readonly generatorId?: string;
  readonly generatorVersion?: string;
  generate(input: EditorialGenerationInput): Promise<EditorialGeneratedText>;
}

export class EditorialDraftError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "EditorialDraftError"; this.code = code; }
}

export function editorialEligibility(result: FactualVerificationResult): EditorialEligibility {
  if (result.status === "CONFIRMED") return "ALLOW_DRAFT";
  if (result.status === "PARTIALLY_CONFIRMED") return "ALLOW_RESTRICTED_DRAFT";
  return "BLOCK_DRAFT";
}

export function createEditorialBrief(input: {
  readonly news: EditorialNews;
  readonly verification: FactualVerificationResult;
  readonly claims: readonly VerificationClaim[];
  readonly evidence: readonly VerificationEvidence[];
  readonly createdAt: string;
}): EditorialBrief {
  const eligibility = editorialEligibility(input.verification);
  const resultByClaim = new Map(input.verification.claims.map((item) => [item.claimId, item]));
  const evidenceByClaim = new Map<string, VerificationEvidence[]>();
  for (const item of input.evidence) {
    if (item.supportsClaim && !item.contradictsClaim) {
      evidenceByClaim.set(item.claimId, [...(evidenceByClaim.get(item.claimId) ?? []), item]);
    }
  }
  const references = input.claims.map((claim) => {
    const factual = resultByClaim.get(claim.id);
    const evidence = evidenceByClaim.get(claim.id) ?? [];
    const allowed = eligibility === "ALLOW_DRAFT" && factual?.status === "SUPPORTED" && evidence.length > 0;
    const classification: EditorialClaimClassification = allowed
      ? "CONFIRMED_AND_ALLOWED"
      : eligibility === "ALLOW_RESTRICTED_DRAFT" && factual?.status === "SUPPORTED"
      ? "CONFIRMED_WITH_LIMITATIONS"
      : eligibility === "ALLOW_RESTRICTED_DRAFT"
      ? "REQUIRES_HUMAN_REVIEW" : "PROHIBITED";
    return {
      claimId: claim.id, originalText: claim.text, normalizedText: normalize(claim.text),
      importance: claim.importance, factualStatus: factual?.status ?? "UNSUPPORTED",
      confidence: factual?.confidence ?? 0, evidenceIds: evidence.map((item) => item.id), classification,
      reason: allowed ? "Verified claim with official supporting evidence." : "Not eligible for a normal factual draft.",
    };
  });
  const citations: EditorialCitation[] = input.evidence.filter((item) => item.supportsClaim && !item.contradictsClaim).map((item) => {
    const publishedAt = item.eventDate ?? item.publishedAt;
    return publishedAt === undefined
      ? { evidenceId: item.id, claimId: item.claimId, sourceId: item.sourceId, canonicalUrl: item.canonicalUrl, title: boundedText(item.excerpt ?? item.canonicalUrl, 300) }
      : { evidenceId: item.id, claimId: item.claimId, sourceId: item.sourceId, canonicalUrl: item.canonicalUrl, title: boundedText(item.excerpt ?? item.canonicalUrl, 300), publishedAt };
  });
  const allowedFacts = references.filter((item) => item.classification === "CONFIRMED_AND_ALLOWED").map((item) => ({
    factId: digest(`${input.verification.verificationId}:${item.claimId}`), claimId: item.claimId,
    statement: conservativeStatement(item.originalText), evidenceIds: item.evidenceIds,
    confidence: item.confidence, restrictions: restrictionsFor(input.evidence.filter((e) => item.evidenceIds.includes(e.id))),
  }));
  const warnings: EditorialWarning[] = [
    ...input.verification.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    ...(eligibility === "ALLOW_RESTRICTED_DRAFT" ? [{ code: "HUMAN_REVIEW_REQUIRED", message: "Partial confirmation cannot enter the normal editorial flow." }] : []),
  ];
  const prohibitedStatements = [
    "Não afirmar disponibilidade geral quando a evidência disser preview ou beta.",
    "Não afirmar desempenho, redução de custo ou superioridade sem métrica e metodologia.",
    "Não apresentar opinião, rumor ou compatibilidade não documentada como fato.",
    "Não alterar datas, versões ou qualificadores registrados pela evidência.",
  ];
  const fingerprint = stableJson({ newsId: input.news.id, verificationId: input.verification.verificationId, claims: references, policy: ANDRE_STUDIO_EDITORIAL_DRAFT_POLICY_V1 });
  return {
    briefId: `brief-${digest(fingerprint)}`, newsId: input.news.id, verificationId: input.verification.verificationId,
    relevanceScore: input.news.relevance?.value ?? 0, relevancePriority: input.news.relevance?.priority ?? "UNKNOWN",
    verificationStatus: input.verification.status, editorialEligibility: eligibility,
    policyId: ANDRE_STUDIO_EDITORIAL_DRAFT_POLICY_V1.id, policyVersion: ANDRE_STUDIO_EDITORIAL_DRAFT_POLICY_V1.version,
    createdAt: input.createdAt,
    subject: { organization: input.news.source.name, product: input.claims[0]?.expectedSubject, eventDate: input.news.eventAt, publicationDate: input.news.publishedAt },
    confirmedClaims: references.filter((item) => item.classification === "CONFIRMED_AND_ALLOWED"),
    restrictedClaims: references.filter((item) => item.classification === "CONFIRMED_WITH_LIMITATIONS" || item.classification === "REQUIRES_HUMAN_REVIEW"),
    prohibitedClaims: references.filter((item) => item.classification === "PROHIBITED"),
    evidenceReferences: citations, sourceReferences: citations, allowedFacts, warnings,
    requiredDisclosures: ["Rascunho factual sujeito à revisão humana antes de qualquer uso."],
    prohibitedStatements, suggestedAngles: ["WHAT_CHANGED", "WHY_IT_MATTERS", "TECHNICAL_SUMMARY", "LIMITATIONS_AND_CAUTIONS", "ANDRESTUDIO_PERSPECTIVE"],
    suggestedFormats: ["LINKEDIN_SHORT_POST", "WEBSITE_NEWS_BRIEF"],
  };
}

export class DeterministicEditorialTextGenerator implements EditorialTextGenerator {
  readonly generatorId = "deterministic-editorial";
  readonly generatorVersion = "v1";
  async generate(input: EditorialGenerationInput): Promise<EditorialGeneratedText> {
    if (input.brief.editorialEligibility !== "ALLOW_DRAFT") throw new EditorialDraftError("EDITORIAL_DRAFT_NOT_ELIGIBLE", "Only confirmed items may enter the normal draft flow.");
    if (input.brief.allowedFacts.length === 0) throw new EditorialDraftError("EDITORIAL_DRAFT_FACTS_MISSING", "A factual draft requires at least one allowed fact.");
    if (input.format !== "LINKEDIN_SHORT_POST" && input.format !== "WEBSITE_NEWS_BRIEF") throw new EditorialDraftError("EDITORIAL_DRAFT_FORMAT_NOT_SUPPORTED", "The requested editorial format is not supported.");
    const facts = input.brief.allowedFacts.map((fact) => fact.statement);
    const title = boundedText(facts[0] ?? "Atualização confirmada", 120);
    const citations = input.brief.sourceReferences.map((citation) => citation.canonicalUrl).join("\n");
    const body = input.format === "LINKEDIN_SHORT_POST"
      ? `${facts.join("\n\n")}\n\nFonte oficial registrada para revisão humana.`
      : `O que aconteceu\n${facts.join("\n")}\n\nPor que importa\nA atualização foi registrada com evidências oficiais.\n\nLimitações\n${input.brief.requiredDisclosures.join(" ")}\n\nFontes\n${citations}`;
    return input.format === "WEBSITE_NEWS_BRIEF"
      ? { title, subtitle: "Resumo factual baseado em evidências oficiais.", body: boundedText(body, input.maxCharacters) }
      : { title, body: boundedText(body, input.maxCharacters) };
  }
}

export async function generateEditorialDraft(input: EditorialGenerationInput, generator: EditorialTextGenerator = new DeterministicEditorialTextGenerator()): Promise<EditorialDraft> {
  const generated = await generator.generate(input);
  const generatorId = generator.generatorId ?? "deterministic-editorial";
  const generatorVersion = generator.generatorVersion ?? "v1";
  const draftBase: Omit<EditorialDraft, "subtitle"> = {
    draftId: `draft-${digest(stableJson({ briefId: input.brief.briefId, format: input.format, generator: `${generatorId}-${generatorVersion}` }))}`,
    newsId: input.brief.newsId, briefId: input.brief.briefId, format: input.format, language: "pt-BR",
    title: generated.title, body: generated.body,
    sourceCitations: input.brief.sourceReferences, warnings: input.brief.warnings, prohibitedClaimsChecked: false,
    validationStatus: "BLOCKED", generatorId, generatorVersion, createdAt: input.brief.createdAt,
  };
  const draft: EditorialDraft = generated.subtitle === undefined ? draftBase : { ...draftBase, subtitle: generated.subtitle };
  const validation = validateEditorialDraft(draft, input.brief, input.maxCharacters);
  return { ...draft, prohibitedClaimsChecked: validation.prohibitedClaimsChecked, validationStatus: validation.status };
}

export function validateEditorialDraft(draft: EditorialDraft, brief: EditorialBrief, maxCharacters = 3000): { readonly status: DraftValidationStatus; readonly warnings: readonly EditorialWarning[]; readonly blockingReasons: readonly EditorialWarning[]; readonly prohibitedClaimsChecked: boolean } {
  const blocking: EditorialWarning[] = [];
  const warnings: EditorialWarning[] = [];
  if (brief.editorialEligibility !== "ALLOW_DRAFT") blocking.push({ code: "EDITORIAL_DRAFT_NOT_ELIGIBLE", message: "The brief is not eligible for a normal draft." });
  if (brief.allowedFacts.length === 0) blocking.push({ code: "EDITORIAL_DRAFT_FACTS_MISSING", message: "No allowed factual blocks exist." });
  if (draft.sourceCitations.length === 0) blocking.push({ code: "EDITORIAL_DRAFT_CITATION_MISSING", message: "A draft requires structured citations." });
  if (draft.body.length > maxCharacters) blocking.push({ code: "EDITORIAL_DRAFT_VALIDATION_FAILED", message: "Draft exceeds the configured size." });
  if (/<\/?(?:script|style|iframe|form)\b/i.test(`${draft.title}\n${draft.body}`)) blocking.push({ code: "EDITORIAL_DRAFT_VALIDATION_FAILED", message: "HTML or script content is forbidden." });
  if (/\b(revolucion[áa]rio|vai mudar tudo|o melhor do mundo|imperd[ií]vel|ningu[eé]m est[aá] falando disso)\b/i.test(draft.title)) blocking.push({ code: "EDITORIAL_DRAFT_VALIDATION_FAILED", message: "Sensationalist title is forbidden." });
  for (const statement of brief.prohibitedStatements) if (draft.body.includes(statement)) blocking.push({ code: "EDITORIAL_DRAFT_PROHIBITED_CLAIM", message: "Draft contains a prohibited instruction." });
  for (const fact of brief.allowedFacts) {
    const restrictions = fact.restrictions.join(" ");
    const textHasPreview = /\bpreview\b/i.test(`${draft.title}\n${draft.body}`);
    const textHasBeta = /\bbeta\b/i.test(`${draft.title}\n${draft.body}`);
    if (/Qualificadores conflitantes na evidência/i.test(restrictions)) {
      blocking.push({ code: "EDITORIAL_DRAFT_QUALIFIER_AMBIGUOUS", message: "The evidence contains ambiguous availability qualifiers." });
    } else if (/Nenhum qualificador de disponibilidade foi comprovado/i.test(restrictions) && (textHasPreview || textHasBeta)) {
      blocking.push({ code: "EDITORIAL_DRAFT_QUALIFIER_UNSUPPORTED", message: "The draft adds an availability qualifier absent from the evidence." });
    } else if (/Qualificador comprovado: preview/i.test(restrictions) && textHasBeta) {
      blocking.push({ code: "EDITORIAL_DRAFT_QUALIFIER_MISMATCH", message: "The draft uses beta although the evidence supports only preview." });
    } else if (/Qualificador comprovado: beta/i.test(restrictions) && textHasPreview) {
      blocking.push({ code: "EDITORIAL_DRAFT_QUALIFIER_MISMATCH", message: "The draft uses preview although the evidence supports only beta." });
    }
  }
  const text = normalize(`${draft.title}\n${draft.body}`);
  for (const prohibited of brief.prohibitedClaims) if (text.includes(normalize(prohibited.originalText))) blocking.push({ code: "EDITORIAL_DRAFT_PROHIBITED_CLAIM", message: "Draft repeats a prohibited claim." });
  for (const warning of brief.warnings) warnings.push(warning);
  return { status: blocking.length > 0 ? "BLOCKED" : warnings.length > 0 ? "VALID_WITH_WARNINGS" : "VALID", warnings, blockingReasons: blocking, prohibitedClaimsChecked: blocking.every((item) => item.code !== "EDITORIAL_DRAFT_PROHIBITED_CLAIM") };
}

function conservativeStatement(value: string): string { return boundedText(stripUnsafe(value).replace(/\b(será|vai|melhor|revolucionário)\b/gi, ""), 500).replace(/[.!?]*$/, "."); }
function restrictionsFor(evidence: readonly VerificationEvidence[]): readonly string[] {
  const text = evidence.map((item) => `${item.excerpt ?? ""} ${JSON.stringify(item.structuredFacts)}`).join(" ");
  const hasPreview = /\bpreview\b/i.test(text);
  const hasBeta = /\bbeta\b/i.test(text);
  if (hasPreview && hasBeta) return ["Qualificadores conflitantes na evidência (preview e beta); o rascunho deve ser bloqueado."];
  if (hasPreview) return ["Qualificador comprovado: preview. Preserve exatamente preview e não use beta nem alternativas."];
  if (hasBeta) return ["Qualificador comprovado: beta. Preserve exatamente beta e não use preview nem alternativas."];
  return ["Nenhum qualificador de disponibilidade foi comprovado pela evidência; não use preview ou beta."];
}
function stripUnsafe(value: string): string { return value.replace(/<[^>]*>/g, " ").replace(/(?:ignore|disregard)\s+(?:all\s+)?(?:previous\s+)?instructions?/gi, "").replace(/\s+/g, " ").trim(); }
function boundedText(value: string, size: number): string { const cleaned = stripUnsafe(value); return cleaned.length <= size ? cleaned : `${cleaned.slice(0, Math.max(0, size - 1)).trimEnd()}…`; }
function normalize(value: string): string { return stripUnsafe(value).toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`; return JSON.stringify(value); }
