import { z } from "zod";

import type { EditorialGeneratedText, EditorialGenerationInput, EditorialTextGenerator } from "./editorial-drafting.ts";
import {
  approximateTokenCount,
  RADAR_SUMMARY_GENERATION_BUDGET,
  WEBSITE_EDITORIAL_GENERATION_BUDGET,
} from "./editorial-generation-budget.ts";
import type { EditorialFactPacket } from "./editorial-fact-packet.ts";
import { createEditorialFactPacket } from "./editorial-fact-packet.ts";
import {
  EDITORIAL_BODY_REPAIR_JSON_SCHEMA,
  EDITORIAL_OUTPUT_JSON_SCHEMA,
  EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
  EditorialOutputSchema,
  EditorialBodyRepairSchema,
  RADAR_SUMMARY_OUTPUT_JSON_SCHEMA,
  RadarSummaryOutputSchema,
  type EditorialOutput,
} from "./editorial-output-schema.ts";

export interface OllamaEditorialGeneratorConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export interface OllamaEditorialRevisionInput {
  readonly previousTitle: string;
  readonly previousBody: string;
  readonly officialSourceTitle: string;
  readonly officialSourceName: string;
  readonly officialLink: string;
  readonly supportedFacts: readonly string[];
  readonly revisionInstructions: readonly string[];
  readonly maximumCharacters: number;
}

export interface OllamaRadarSummaryInput {
  readonly title: string;
  readonly sourceName: string;
  readonly officialLink: string;
  readonly supportedFacts: readonly string[];
}

export interface OllamaEditorialRepairInput {
  readonly original: EditorialGenerationInput;
  readonly previous: EditorialGeneratedText;
  readonly failureCodes: readonly string[];
  readonly wordCount: number;
  readonly wordDelta: number;
  readonly factPacket: EditorialFactPacket;
}

export interface OllamaCallMetrics {
  readonly promptTokenCount: number;
  readonly completionTokenCount: number;
  readonly effectiveOutputLimit: number;
  readonly terminationReason: "STOP" | "OUTPUT_LIMIT" | "ERROR" | "UNKNOWN";
}

interface OllamaResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: unknown }; readonly finish_reason?: string | null }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

interface WebsiteBriefValidationResult {
  readonly valid: boolean;
  readonly wordCount: number;
  readonly failureCodes: readonly ("OLLAMA_EDITORIAL_LENGTH_INVALID" | "OLLAMA_EDITORIAL_SOURCE_MISSING")[];
  readonly wordDelta: number;
}

export class OllamaEditorialGeneratorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OllamaEditorialGeneratorError";
    this.code = code;
  }
}

/**
 * Explicit local-only adapter. It has no fallback: a failed or malformed
 * model response blocks draft generation instead of silently changing model.
 */
export class OllamaEditorialTextGenerator implements EditorialTextGenerator {
  readonly generatorId = "ollama";
  readonly generatorVersion: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  lastCallMetrics: OllamaCallMetrics | undefined;

  constructor(config: OllamaEditorialGeneratorConfig) {
    const url = localOllamaBaseUrl(config.baseUrl);
    if (!config.model.trim()) throw new OllamaEditorialGeneratorError("LLM_MODEL_MISSING", "LLM_MODEL is required for the Ollama provider.");
    this.#endpoint = `${url}/chat/completions`;
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    this.generatorVersion = config.model;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): OllamaEditorialTextGenerator {
    if (environment.LLM_PROVIDER !== "ollama") throw new OllamaEditorialGeneratorError("LLM_PROVIDER_INVALID", "LLM_PROVIDER must be ollama for the local Ollama adapter.");
    return new OllamaEditorialTextGenerator({
      baseUrl: environment.LLM_BASE_URL ?? "",
      model: environment.LLM_MODEL ?? "",
    });
  }

  async generate(input: EditorialGenerationInput): Promise<EditorialGeneratedText> {
    if (input.brief.editorialEligibility !== "ALLOW_DRAFT" || input.brief.allowedFacts.length === 0) {
      throw new OllamaEditorialGeneratorError("EDITORIAL_DRAFT_NOT_ELIGIBLE", "Only confirmed factual briefs may be sent to the local model.");
    }
    const factPacket = createEditorialFactPacket(input.brief);
    const outputBudget = input.format === "WEBSITE_NEWS_BRIEF" ? WEBSITE_EDITORIAL_GENERATION_BUDGET.outputTokens : 300;
    const generated = await this.#complete([
      {
        role: "user",
        content: JSON.stringify({
          task: "Gere campos editoriais estruturados em pt-BR usando somente os fatos permitidos.",
          mandatoryRules: [
            "Não use ferramentas, comandos, busca, conhecimento externo ou suposições.",
            "Não invente datas, números, versões, disponibilidade, preço ou experiência prática.",
            "Não use qualificadores de estágio ausentes na evidência.",
            "Retorne somente um objeto JSON plano, sem Markdown, comentários ou texto antes/depois.",
            "subtitle deve ser uma frase curta em texto simples, nunca JSON aninhado.",
          ],
          schema: EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
          outputContract: EDITORIAL_OUTPUT_JSON_SCHEMA,
          format: input.format,
          language: input.language,
          tone: input.tone,
          maxCharacters: input.maxCharacters,
          allowedFacts: input.brief.allowedFacts,
          restrictions: input.brief.prohibitedStatements,
          requiredDisclosures: input.brief.requiredDisclosures,
          citations: input.brief.sourceReferences.map((citation) => citation.canonicalUrl),
          factPacket,
          websiteLengthGuidance: input.format === "WEBSITE_NEWS_BRIEF" ? `O body final deve ter entre ${WEBSITE_EDITORIAL_GENERATION_BUDGET.minimumWords} e ${WEBSITE_EDITORIAL_GENERATION_BUDGET.maximumWords} palavras; mire ${WEBSITE_EDITORIAL_GENERATION_BUDGET.targetMinimumWords} a ${WEBSITE_EDITORIAL_GENERATION_BUDGET.targetMaximumWords}. O limite de saída é separado do resumo curto.` : undefined,
        }),
      },
    ], input.maxCharacters, outputBudget, EditorialOutputSchema, EDITORIAL_OUTPUT_JSON_SCHEMA) as EditorialOutput;
    return assembleEditorialText(generated, input);
  }

  /** One bounded repair that receives the prior fields and exact validation failures. */
  async repairWebsiteBrief(input: OllamaEditorialRepairInput): Promise<EditorialGeneratedText> {
    if (input.original.brief.editorialEligibility !== "ALLOW_DRAFT" || input.original.brief.allowedFacts.length === 0) {
      throw new OllamaEditorialGeneratorError("EDITORIAL_DRAFT_NOT_ELIGIBLE", "Only confirmed factual briefs may be sent to the local model.");
    }
    const generated = await this.#complete([
      {
        role: "user",
        content: JSON.stringify({
          task: "Repare somente as falhas determinísticas indicadas no rascunho anterior; não reescreva fatos validados às cegas.",
          mandatoryRules: [
            "Use apenas os fatos permitidos e preserve nomes, qualificadores e links já válidos.",
            "Retorne somente um objeto JSON plano no schema; subtitle deve continuar sendo string simples.",
            "Não invente qualquer informação nem adicione preview, beta, versão, disponibilidade, preço ou experiência prática sem evidência literal.",
          ],
          schema: EDITORIAL_BODY_REPAIR_JSON_SCHEMA,
          outputContract: EDITORIAL_BODY_REPAIR_JSON_SCHEMA,
          previousFields: { title: input.previous.title, subtitle: input.previous.subtitle },
          failureCodes: input.failureCodes,
          currentWordCount: input.wordCount,
          wordDelta: input.wordDelta,
          factPacket: input.factPacket,
          citations: input.original.brief.sourceReferences.map((citation) => citation.canonicalUrl),
        }),
      },
    ], input.original.maxCharacters, WEBSITE_EDITORIAL_GENERATION_BUDGET.outputTokens, EditorialBodyRepairSchema, EDITORIAL_BODY_REPAIR_JSON_SCHEMA) as { body: string };
    const officialUrl = input.original.brief.sourceReferences.map((citation) => citation.canonicalUrl).find((url) => url.startsWith("https://"));
    const body = input.original.format === "WEBSITE_NEWS_BRIEF" && officialUrl && !generated.body.includes(officialUrl)
      ? `${generated.body}\n\nFonte oficial: ${officialUrl}`
      : generated.body;
    return { title: input.previous.title, ...(input.previous.subtitle === undefined ? {} : { subtitle: input.previous.subtitle }), body };
  }

  async generateRevision(input: OllamaEditorialRevisionInput): Promise<EditorialGeneratedText> {
    if (input.supportedFacts.length < 2 || !input.officialLink.startsWith("https://")) {
      throw new OllamaEditorialGeneratorError("EDITORIAL_REVISION_EVIDENCE_MISSING", "A revision requires two persisted facts and one HTTPS official source.");
    }
    const generated = await this.#complete([
      {
        role: "user",
        content: JSON.stringify({
          task: "Revise uma nota editorial do AndréStudio.dev em português brasileiro.",
          mandatoryRules: [
            "Não use ferramentas, shell, busca, conhecimento externo ou suposições.",
            "Use somente os fatos e a fonte fornecidos; não invente datas, números, versões, disponibilidade, preço, funcionamento técnico ou resultados.",
            "Diferencie anúncio oficial de experiência prática e não afirme que a ferramenta foi testada.",
            "Produza entre 100 e 180 palavras, com três a cinco parágrafos curtos.",
            "Retorne somente JSON plano conforme o contrato, com subtitle como uma frase curta em texto simples.",
            "Inclua exatamente as afirmações suportadas e a URL oficial fornecida.",
          ],
          schema: EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
          outputContract: EDITORIAL_OUTPUT_JSON_SCHEMA,
          style: ["profissional", "direto", "fácil de entender", "sem clickbait"],
          previousVersion: { title: input.previousTitle, body: input.previousBody },
          officialSourceTitle: input.officialSourceTitle,
          officialSourceName: input.officialSourceName,
          officialLink: input.officialLink,
          supportedFacts: input.supportedFacts,
          revisionInstructions: input.revisionInstructions,
          maximumCharacters: input.maximumCharacters,
        }),
      },
    ], input.maximumCharacters, 500, EditorialOutputSchema, EDITORIAL_OUTPUT_JSON_SCHEMA) as EditorialOutput;
    return assembleRevisionText(generated, input.officialLink);
  }

  async generateRadarSummary(input: OllamaRadarSummaryInput): Promise<string> {
    if (input.supportedFacts.length === 0 || !input.officialLink.startsWith("https://")) {
      throw new OllamaEditorialGeneratorError("RADAR_SUMMARY_EVIDENCE_MISSING", "A radar summary requires persisted facts and one HTTPS official source.");
    }
    const generated = await this.#complete([
      {
        role: "user",
        content: JSON.stringify({
          task: "Resuma em português brasileiro usando somente os fatos fornecidos.",
          mandatoryRules: [
            "Não use ferramentas, busca, conhecimento externo ou suposições.",
            "Escreva duas ou três frases explicando o que aconteceu, por que importa e para quem pode ser útil.",
            "Não invente datas, números, versões, preços, disponibilidade ou experiência prática.",
            "Retorne JSON puro com title e body; body contém somente o resumo.",
          ],
          schema: RADAR_SUMMARY_OUTPUT_JSON_SCHEMA,
          outputContract: RADAR_SUMMARY_OUTPUT_JSON_SCHEMA,
          input,
        }),
      },
    ], 600, RADAR_SUMMARY_GENERATION_BUDGET.outputTokens, RadarSummaryOutputSchema, RADAR_SUMMARY_OUTPUT_JSON_SCHEMA);
    return generated.body;
  }

  async #complete(
    messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
    _maximumCharacters: number,
    maximumTokens: number,
    schema: z.ZodType,
    schemaJson: Record<string, unknown>,
  ): Promise<EditorialGeneratedText> {
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.#timeoutMs),
      body: JSON.stringify({
        model: this.generatorVersion,
        stream: false,
        temperature: 0,
        max_tokens: maximumTokens,
        options: { num_ctx: WEBSITE_EDITORIAL_GENERATION_BUDGET.contextTokens, num_predict: maximumTokens },
        reasoning_effort: "none",
        format: schemaJson,
        messages,
      }),
    });
    if (!response.ok) {
      this.lastCallMetrics = { promptTokenCount: approximateTokenCount(messages.map((message) => message.content).join("\n")), completionTokenCount: 0, effectiveOutputLimit: maximumTokens, terminationReason: "ERROR" };
      throw new OllamaEditorialGeneratorError("OLLAMA_REQUEST_FAILED", `Local Ollama returned HTTP ${response.status}.`);
    }
    const payload = await response.json() as OllamaResponse;
    const content = payload.choices?.[0]?.message?.content;
    const finishReason = payload.choices?.[0]?.finish_reason;
    this.lastCallMetrics = {
      promptTokenCount: payload.usage?.prompt_tokens ?? approximateTokenCount(messages.map((message) => message.content).join("\n")),
      completionTokenCount: payload.usage?.completion_tokens ?? (typeof content === "string" ? approximateTokenCount(content) : 0),
      effectiveOutputLimit: maximumTokens,
      terminationReason: finishReason === "length" ? "OUTPUT_LIMIT" : finishReason === "stop" ? "STOP" : typeof content === "string" ? "UNKNOWN" : "ERROR",
    };
    if (typeof content !== "string") throw new OllamaEditorialGeneratorError("OLLAMA_RESPONSE_INVALID", "Local Ollama returned no textual completion.");
    return parseGeneratedText(content, schema);
  }
}

export function inspectWebsiteBriefOutput(output: EditorialGeneratedText, citations: readonly string[]): WebsiteBriefValidationResult {
  const words = output.body.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const failureCodes: ("OLLAMA_EDITORIAL_LENGTH_INVALID" | "OLLAMA_EDITORIAL_SOURCE_MISSING")[] = [];
  if (words < 180 || words > 300) failureCodes.push("OLLAMA_EDITORIAL_LENGTH_INVALID");
  const officialUrls = [...new Set(citations.filter((url) => url.startsWith("https://")))];
  if (officialUrls.length === 0 || !officialUrls.some((url) => output.body.includes(url))) failureCodes.push("OLLAMA_EDITORIAL_SOURCE_MISSING");
  return { valid: failureCodes.length === 0, wordCount: words, failureCodes, wordDelta: words < 180 ? 180 - words : words > 300 ? 300 - words : 0 };
}

/** Backwards-compatible throwing validator for callers that want a hard gate. */
export function validateWebsiteBriefOutput(output: EditorialGeneratedText, citations: readonly string[]): void {
  const result = inspectWebsiteBriefOutput(output, citations);
  if (result.failureCodes.includes("OLLAMA_EDITORIAL_LENGTH_INVALID")) throw new OllamaEditorialGeneratorError("OLLAMA_EDITORIAL_LENGTH_INVALID", "A website brief must contain between 180 and 300 words.");
  if (result.failureCodes.includes("OLLAMA_EDITORIAL_SOURCE_MISSING")) throw new OllamaEditorialGeneratorError("OLLAMA_EDITORIAL_SOURCE_MISSING", "A website brief must include one persisted official source URL.");
}

function assembleEditorialText(fields: EditorialOutput, input: EditorialGenerationInput): EditorialGeneratedText {
  const officialUrl = input.brief.sourceReferences.map((citation) => citation.canonicalUrl).find((url) => url.startsWith("https://"));
  const body = input.format === "WEBSITE_NEWS_BRIEF" && officialUrl && !fields.body.includes(officialUrl)
    ? `${fields.body}\n\nFonte oficial: ${officialUrl}`
    : fields.body;
  return { title: fields.title, subtitle: fields.subtitle, body };
}

function assembleRevisionText(fields: EditorialOutput, officialLink: string): EditorialGeneratedText {
  return { title: fields.title, subtitle: fields.subtitle, body: fields.body.includes(officialLink) ? fields.body : `${fields.body}\n\nFonte oficial: ${officialLink}` };
}

function localOllamaBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OllamaEditorialGeneratorError("LLM_BASE_URL_INVALID", "LLM_BASE_URL must be a loopback HTTP URL ending in /v1."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^\/v1\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new OllamaEditorialGeneratorError("LLM_BASE_URL_INVALID", "The Ollama adapter only permits http://127.0.0.1:11434/v1.");
  }
  return url.toString().replace(/\/$/, "");
}

function parseGeneratedText(value: string, schema: z.ZodType): EditorialGeneratedText {
  const normalized = value.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try { parsed = JSON.parse(normalized); } catch { throw new OllamaEditorialGeneratorError("OLLAMA_RESPONSE_INVALID", "Local Ollama must return one JSON object without surrounding text."); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new OllamaEditorialGeneratorError("OLLAMA_RESPONSE_INVALID", "Local Ollama response does not match the editorial JSON schema.");
  const output = result.data as EditorialOutput | { title: string; body: string } | { body: string };
  if ("title" in output && !("subtitle" in output)) return { title: output.title, body: output.body };
  if (!("title" in output)) return { title: "", body: output.body };
  return { title: output.title, subtitle: output.subtitle, body: output.body };
}
