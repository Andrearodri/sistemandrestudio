import { OllamaEditorialTextGenerator } from "./ollama-editorial-generator.ts";
import { OpenAIEditorialProvider } from "./openai-editorial-provider.ts";

export type EditorialProviderName = "ollama" | "openai";
export type EditorialProviderScope = "RADAR" | "LONG_FORM";
export type EditorialProvider = OllamaEditorialTextGenerator | OpenAIEditorialProvider;

/** Explicit provider selection. Radar defaults to local Ollama and never follows the long-form provider. */
export function createEditorialProvider(scope: EditorialProviderScope, environment: NodeJS.ProcessEnv = process.env): EditorialProvider {
  const selected = scope === "RADAR" ? (environment.RADAR_LLM_PROVIDER ?? "ollama") : (environment.EDITORIAL_PROVIDER ?? "ollama");
  if (selected !== "ollama" && selected !== "openai") throw new Error("EDITORIAL_PROVIDER must be ollama or openai.");
  if (selected === "openai") {
    if (scope === "RADAR") throw new Error("Radar provider is fixed to Ollama.");
    return OpenAIEditorialProvider.fromEnvironment(environment);
  }
  return OllamaEditorialTextGenerator.fromEnvironment({ ...environment, LLM_PROVIDER: "ollama" });
}

export function createLongFormEditorialProvider(environment: NodeJS.ProcessEnv = process.env): EditorialProvider {
  return createEditorialProvider("LONG_FORM", environment);
}

export function createRadarEditorialProvider(environment: NodeJS.ProcessEnv = process.env): OllamaEditorialTextGenerator {
  const provider = createEditorialProvider("RADAR", environment);
  if (!(provider instanceof OllamaEditorialTextGenerator)) throw new Error("Radar provider must be Ollama.");
  return provider;
}
