import OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";

import type { EditorialGeneratedText, EditorialGenerationInput, EditorialTextGenerator } from "./editorial-drafting.ts";
import { approximateTokenCount, WEBSITE_EDITORIAL_GENERATION_BUDGET } from "./editorial-generation-budget.ts";
import { createEditorialFactPacket, type EditorialFactPacket } from "./editorial-fact-packet.ts";
import {
  EDITORIAL_BODY_REPAIR_JSON_SCHEMA,
  EDITORIAL_OUTPUT_JSON_SCHEMA,
  EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
  EditorialBodyRepairSchema,
  EditorialOutputSchema,
  type EditorialOutput,
} from "./editorial-output-schema.ts";
import type { OllamaEditorialRepairInput, OllamaCallMetrics } from "./ollama-editorial-generator.ts";

export const OPENAI_LUNA_MODEL = "gpt-5.6-luna" as const;
export const OPENAI_LUNA_MAX_OUTPUT_TOKENS = WEBSITE_EDITORIAL_GENERATION_BUDGET.outputTokens;
export const OPENAI_LUNA_INPUT_USD_PER_MILLION = 0.2;
export const OPENAI_LUNA_OUTPUT_USD_PER_MILLION = 1.2;

export interface OpenAIEditorialProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export interface OpenAIEditorialProviderClient {
  readonly responses: {
    create(input: ResponseCreateParamsNonStreaming): Promise<Response>;
  };
}

export interface OpenAIEditorialUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
}

export class OpenAIEditorialProviderError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "OpenAIEditorialProviderError";
    this.code = code;
    this.status = status;
  }
}

/** Explicit remote provider. It never falls back to Ollama and never enables tools. */
export class OpenAIEditorialProvider implements EditorialTextGenerator {
  readonly generatorId = "openai";
  readonly generatorVersion = OPENAI_LUNA_MODEL;
  readonly model: string;
  readonly maxCalls: number;
  calls = 0;
  lastCallMetrics: OllamaCallMetrics | undefined;
  usage: OpenAIEditorialUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  private readonly client: OpenAIEditorialProviderClient;
  private readonly timeoutMs: number;

  constructor(config: OpenAIEditorialProviderConfig, client?: OpenAIEditorialProviderClient) {
    if (!config.apiKey.trim()) throw new OpenAIEditorialProviderError("OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is required for the OpenAI provider.");
    this.model = config.model ?? OPENAI_LUNA_MODEL;
    if (this.model !== OPENAI_LUNA_MODEL) throw new OpenAIEditorialProviderError("OPENAI_MODEL_INVALID", "The OpenAI editorial provider is pinned to gpt-5.6-luna.");
    this.maxCalls = 2;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.client = client ?? new OpenAI({ apiKey: config.apiKey, timeout: this.timeoutMs, maxRetries: 0 });
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, client?: OpenAIEditorialProviderClient): OpenAIEditorialProvider {
    if (!environment.OPENAI_API_KEY?.trim()) {
      throw new OpenAIEditorialProviderError("OPENAI_API_KEY_MISSING", "OPENAI_API_KEY is required for the OpenAI provider.");
    }
    if (environment.OPENAI_HARD_SPEND_LIMIT_USD !== "1") {
      throw new OpenAIEditorialProviderError("OPENAI_HARD_SPEND_LIMIT_UNCONFIRMED", "A monthly OpenAI hard spend limit of US$1 must be confirmed before a real call.");
    }
    return new OpenAIEditorialProvider({ apiKey: environment.OPENAI_API_KEY, model: OPENAI_LUNA_MODEL }, client);
  }

  async generate(input: EditorialGenerationInput): Promise<EditorialGeneratedText> {
    const packet = createEditorialFactPacket(input.brief);
    return this.complete({
      input: this.initialPrompt(input, packet),
      schema: EDITORIAL_OUTPUT_JSON_SCHEMA,
      parse: (value) => EditorialOutputSchema.parse(value),
    });
  }

  async repairWebsiteBrief(input: OllamaEditorialRepairInput): Promise<EditorialGeneratedText> {
    const repairPrompt = JSON.stringify({
      task: "Repare somente o campo body do rascunho editorial.",
      contract: EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
      previousFields: { title: input.previous.title, subtitle: input.previous.subtitle ?? "" },
      failureCodes: input.failureCodes,
      wordCount: input.wordCount,
      wordDelta: input.wordDelta,
      factPacket: input.factPacket,
      rules: ["Preserve os fatos permitidos.", "Não use ferramentas, pesquisa, disponibilidade, preview, beta ou versão sem evidência literal.", "Retorne JSON com body string simples; não inclua title ou subtitle."],
    });
    const body = await this.complete({
      input: repairPrompt,
      schema: EDITORIAL_BODY_REPAIR_JSON_SCHEMA,
      parse: (value) => EditorialBodyRepairSchema.parse(value),
    });
    return { title: input.previous.title, ...(input.previous.subtitle === undefined ? {} : { subtitle: input.previous.subtitle }), body: body.body };
  }

  private initialPrompt(input: EditorialGenerationInput, packet: EditorialFactPacket): string {
    return JSON.stringify({
      task: "Gere um rascunho editorial longo em pt-BR usando somente o fact packet.",
      contract: EDITORIAL_OUTPUT_SCHEMA_SUMMARY,
      requirements: ["body entre 180 e 300 palavras; mire 220–240", "título informativo", "subtitle em texto simples", "não invente fatos, datas, números, versões, disponibilidade, preview, beta, preço ou experiência prática", "inclua a URL oficial no body", "não use ferramentas, pesquisa ou conteúdo externo"],
      factPacket: packet,
      sourceContext: {
        subject: input.brief.subject,
        allowedFacts: input.brief.allowedFacts,
        citations: input.brief.sourceReferences.map((citation) => citation.canonicalUrl),
      },
    });
  }

  private async complete<T extends EditorialOutput | { readonly body: string }>(input: { readonly input: string; readonly schema: Record<string, unknown>; readonly parse: (value: unknown) => T }): Promise<EditorialGeneratedText> {
    if (this.calls >= this.maxCalls) throw new OpenAIEditorialProviderError("OPENAI_CALL_LIMIT_REACHED", "The OpenAI editorial provider allows at most two calls per homologation.");
    this.calls += 1;
    const request: ResponseCreateParamsNonStreaming = {
      model: this.model,
      input: [{ role: "user", content: [{ type: "input_text", text: input.input }] }],
      max_output_tokens: OPENAI_LUNA_MAX_OUTPUT_TOKENS,
      reasoning: { effort: "low" },
      store: false,
      tools: [],
      text: { format: { type: "json_schema", name: "editorial_output", schema: input.schema, strict: true } },
    };
    let response: Response;
    try {
      response = await this.client.responses.create(request);
    } catch (error) {
      throw this.mapError(error);
    }
    const inputTokens = response.usage?.input_tokens ?? approximateTokenCount(input.input);
    const outputTokens = response.usage?.output_tokens ?? approximateTokenCount(response.output_text ?? "");
    const estimatedCostUsd = inputTokens / 1_000_000 * OPENAI_LUNA_INPUT_USD_PER_MILLION + outputTokens / 1_000_000 * OPENAI_LUNA_OUTPUT_USD_PER_MILLION;
    this.usage = { inputTokens: this.usage.inputTokens + inputTokens, outputTokens: this.usage.outputTokens + outputTokens, estimatedCostUsd: this.usage.estimatedCostUsd + estimatedCostUsd };
    this.lastCallMetrics = { promptTokenCount: inputTokens, completionTokenCount: outputTokens, effectiveOutputLimit: OPENAI_LUNA_MAX_OUTPUT_TOKENS, terminationReason: response.status === "completed" ? "STOP" : "UNKNOWN" };
    if (typeof response.output_text !== "string" || response.output_text.trim() === "") throw new OpenAIEditorialProviderError("OPENAI_RESPONSE_INVALID", "OpenAI returned no structured editorial output.");
    let parsed: unknown;
    try { parsed = JSON.parse(response.output_text); } catch { throw new OpenAIEditorialProviderError("OPENAI_RESPONSE_INVALID", "OpenAI returned invalid JSON for the editorial schema."); }
    let value: T;
    try { value = input.parse(parsed); } catch { throw new OpenAIEditorialProviderError("OPENAI_SCHEMA_INVALID", "OpenAI returned JSON outside the editorial schema."); }
    return "title" in value ? { title: value.title, subtitle: value.subtitle, body: value.body } : { title: "", body: value.body };
  }

  private mapError(error: unknown): OpenAIEditorialProviderError {
    const status = typeof error === "object" && error !== null && "status" in error && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
    if (status === 401) return new OpenAIEditorialProviderError("OPENAI_AUTHENTICATION_FAILED", "OpenAI authentication failed.", status);
    if (status === 429) return new OpenAIEditorialProviderError("OPENAI_RATE_LIMITED", "OpenAI rate limit reached.", status);
    if (status !== undefined && status >= 500) return new OpenAIEditorialProviderError("OPENAI_SERVER_ERROR", "OpenAI server error.", status);
    if (error instanceof Error && /timeout|aborted|timed out/iu.test(error.message)) return new OpenAIEditorialProviderError("OPENAI_TIMEOUT", "OpenAI request timed out.");
    return new OpenAIEditorialProviderError("OPENAI_REQUEST_FAILED", "OpenAI request failed.", status);
  }
}
