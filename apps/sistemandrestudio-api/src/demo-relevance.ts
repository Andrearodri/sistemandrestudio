import {
  RELEVANCE_FIXTURES,
  calculateFixtureRelevance,
} from "../../../packages/content-engine/src/index.ts";

console.log("sistemandrestudio — política determinística de relevância\n");

console.table(
  RELEVANCE_FIXTURES.map((fixture) => {
    const result = calculateFixtureRelevance(fixture);
    return {
      "título fictício": fixture.input.title,
      pontuação: `${result.value}/100`,
      prioridade: result.priority,
      decisão: result.decision,
      "principais razões": result.positiveFactors
        .slice(0, 3)
        .map((factor) => `${factor.code} (+${factor.points})`)
        .join(", "),
      penalidades:
        result.penalties.length === 0
          ? "nenhuma"
          : result.penalties
              .map((penalty) => `${penalty.code} (-${penalty.points})`)
              .join(", "),
    };
  }),
);

console.log(
  `\nPolítica: andre-studio-relevance-v1 | ` +
    `${RELEVANCE_FIXTURES.length} fixtures | sem rede ou relógio real`,
);
