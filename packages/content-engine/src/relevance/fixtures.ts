import { ANDRE_STUDIO_RELEVANCE_POLICY_V1 } from "./relevance-policy.ts";
import { calculateRelevance } from "./scoring.ts";
import type { RelevanceInput, RelevanceResult } from "./relevance-types.ts";

export interface RelevanceFixture {
  readonly id: string;
  readonly description: string;
  readonly input: RelevanceInput;
  readonly expected: string;
}

const EVALUATED_AT = "2026-07-24T12:00:00.000Z";

export const OFFICIAL_HIGHLY_RELEVANT_FIXTURE: RelevanceFixture = {
  id: "official-highly-relevant",
  description: "Lançamento oficial altamente relevante",
  expected: "HIGH_OR_CRITICAL",
  input: {
    title: "Organização Fictícia Nebulosa apresenta API de automação com IA",
    summary:
      "A organização fictícia lançou uma API para agentes, fluxos automáticos e sistemas de pequenas empresas.",
    informedTopics: [
      "artificial_intelligence",
      "ai_agents",
      "automation",
      "apis",
    ],
    sourceType: "OFFICIAL",
    publishedAt: "2026-07-24T09:00:00.000Z",
    eventAt: "2026-07-24T08:00:00.000Z",
    evaluatedAt: EVALUATED_AT,
    noveltyType: "NEW_PRODUCT",
    isRumor: false,
    isPromotional: false,
    isSensationalist: false,
    similarityToExisting: 0.1,
    contentFormats: ["POST", "ARTICLE", "TUTORIAL", "DEMONSTRATION"],
    commercialRelations: [
      "AUTOMATION_SERVICE",
      "CUSTOM_SYSTEM",
      "APPLIED_AI",
      "SMALL_BUSINESS_TOOLS",
    ],
  },
};

export const RELEVANT_BUT_OLD_FIXTURE: RelevanceFixture = {
  id: "relevant-but-old",
  description: "Notícia técnica relevante, mas antiga",
  expected: "MEDIUM_OR_LOW",
  input: {
    title: "Arquivo técnico fictício descreve automação de APIs",
    summary:
      "O acontecimento relacionado a desenvolvimento web ocorreu muitos meses antes da avaliação.",
    informedTopics: ["automation", "apis", "web_development"],
    sourceType: "REPUTABLE_TECH_MEDIA",
    publishedAt: "2025-10-03T10:00:00.000Z",
    eventAt: "2025-10-02T10:00:00.000Z",
    evaluatedAt: EVALUATED_AT,
    noveltyType: "MAJOR_UPDATE",
    isRumor: false,
    isPromotional: false,
    isSensationalist: false,
    similarityToExisting: 0.2,
    contentFormats: ["ARTICLE", "TECHNICAL_OPINION"],
    commercialRelations: ["AUTOMATION_SERVICE"],
  },
};

export const SENSATIONALIST_RUMOR_FIXTURE: RelevanceFixture = {
  id: "sensationalist-rumor",
  description: "Rumor sensacionalista",
  expected: "LOW_OR_IGNORE",
  input: {
    title: "URGENTE: agente fictício vai mudar tudo para sempre",
    summary:
      "Uma comunidade sem confirmação publicou uma alegação vaga sobre um possível modelo.",
    informedTopics: ["ai_agents", "new_ai_models"],
    sourceType: "COMMUNITY",
    publishedAt: "2026-07-24T10:00:00.000Z",
    eventAt: null,
    evaluatedAt: EVALUATED_AT,
    noveltyType: "NEW_MODEL",
    isRumor: true,
    isPromotional: false,
    isSensationalist: true,
    similarityToExisting: 0.2,
    contentFormats: ["POST", "TECHNICAL_OPINION"],
    commercialRelations: [],
  },
};

export const OUT_OF_POSITIONING_FIXTURE: RelevanceFixture = {
  id: "out-of-positioning",
  description: "Conteúdo fora do posicionamento",
  expected: "IGNORE",
  input: {
    title: "Festival fictício de jardinagem anuncia programação",
    summary:
      "O evento trata exclusivamente de espécies ornamentais e atividades recreativas.",
    informedTopics: [],
    sourceType: "UNKNOWN",
    publishedAt: "2026-07-24T09:00:00.000Z",
    eventAt: "2026-07-24T08:00:00.000Z",
    evaluatedAt: EVALUATED_AT,
    noveltyType: "NO_CONCRETE_NOVELTY",
    isRumor: false,
    isPromotional: true,
    isSensationalist: false,
    similarityToExisting: 0,
    contentFormats: [],
    commercialRelations: [],
  },
};

export const COMMERCIALLY_USEFUL_UPDATE_FIXTURE: RelevanceFixture = {
  id: "commercially-useful-update",
  description: "Atualização comercialmente útil",
  expected: "HIGH",
  input: {
    title: "Plataforma fictícia altera automações para pequenas empresas",
    summary:
      "A mudança de API permite demonstrar sistemas, captação de leads e IA aplicada.",
    informedTopics: [
      "automation",
      "small_business_tools",
      "lead_generation",
      "apis",
    ],
    sourceType: "DOCUMENTATION",
    publishedAt: "2026-07-23T13:00:00.000Z",
    eventAt: "2026-07-23T12:00:00.000Z",
    evaluatedAt: EVALUATED_AT,
    noveltyType: "API_CHANGE",
    isRumor: false,
    isPromotional: false,
    isSensationalist: false,
    similarityToExisting: 0.15,
    contentFormats: ["POST", "ARTICLE", "TUTORIAL", "DEMONSTRATION"],
    commercialRelations: [
      "AUTOMATION_SERVICE",
      "CUSTOM_SYSTEM",
      "APPLIED_AI",
      "LEAD_GENERATION",
      "SMALL_BUSINESS_TOOLS",
    ],
  },
};

export const DUPLICATE_CONTENT_FIXTURE: RelevanceFixture = {
  id: "duplicate-content",
  description: "Conteúdo duplicado",
  expected: "EXPLICIT_DUPLICATE_PENALTY",
  input: {
    ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
    title: "Organização Fictícia Nebulosa repete anúncio de automação com IA",
    similarityToExisting: 0.94,
  },
};

export const OFFICIAL_LOW_IMPACT_FIXTURE: RelevanceFixture = {
  id: "official-low-impact",
  description: "Fonte oficial com baixo impacto",
  expected: "NOT_HIGH",
  input: {
    title: "Portal fictício corrige detalhe visual sem efeito técnico",
    summary:
      "A nota oficial descreve apenas uma pequena correção de texto, sem capacidade nova.",
    informedTopics: ["web_development"],
    sourceType: "OFFICIAL",
    publishedAt: "2026-07-24T08:00:00.000Z",
    eventAt: "2026-07-24T08:00:00.000Z",
    evaluatedAt: EVALUATED_AT,
    noveltyType: "NO_CONCRETE_NOVELTY",
    isRumor: false,
    isPromotional: false,
    isSensationalist: false,
    similarityToExisting: 0.1,
    contentFormats: ["POST"],
    commercialRelations: [],
  },
};

export const DETERMINISTIC_REPLAY_FIXTURE: RelevanceFixture = {
  id: "deterministic-replay",
  description: "Mesma entrada e mesma política",
  expected: "IDENTICAL_RESULT",
  input: { ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input },
};

export const RELEVANCE_FIXTURES = [
  OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
  RELEVANT_BUT_OLD_FIXTURE,
  SENSATIONALIST_RUMOR_FIXTURE,
  OUT_OF_POSITIONING_FIXTURE,
  COMMERCIALLY_USEFUL_UPDATE_FIXTURE,
  DUPLICATE_CONTENT_FIXTURE,
  OFFICIAL_LOW_IMPACT_FIXTURE,
  DETERMINISTIC_REPLAY_FIXTURE,
] as const;

export function calculateFixtureRelevance(
  fixture: RelevanceFixture,
): RelevanceResult {
  return calculateRelevance(
    fixture.input,
    ANDRE_STUDIO_RELEVANCE_POLICY_V1,
  );
}
