import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ANDRE_STUDIO_RELEVANCE_POLICY_V1,
  COMMERCIALLY_USEFUL_UPDATE_FIXTURE,
  DETERMINISTIC_REPLAY_FIXTURE,
  DUPLICATE_CONTENT_FIXTURE,
  InvalidDateRangeError,
  InvalidRelevanceInputError,
  InvalidRelevancePolicyError,
  OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
  OFFICIAL_LOW_IMPACT_FIXTURE,
  OUT_OF_POSITIONING_FIXTURE,
  RELEVANT_BUT_OLD_FIXTURE,
  SENSATIONALIST_RUMOR_FIXTURE,
  UnsupportedNoveltyTypeError,
  UnsupportedSourceTypeError,
  calculateFixtureRelevance,
  calculateRelevance,
  toRelevanceRoutingCommand,
  toScoreNewsCommand,
} from "../packages/content-engine/src/index.ts";
import type {
  RelevanceInput,
  RelevancePolicy,
  RelevanceResult,
} from "../packages/content-engine/src/index.ts";

const policy = ANDRE_STUDIO_RELEVANCE_POLICY_V1;

describe("deterministic relevance policy", () => {
  test("produces the minimum score", () => {
    assert.equal(calculateFixtureRelevance(OUT_OF_POSITIONING_FIXTURE).value, 0);
  });

  test("produces the maximum score", () => {
    const result = calculateRelevance(
      {
        ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
        noveltyType: "NEW_MODEL",
      },
      policy,
    );
    assert.equal(result.value, 100);
  });

  test("clamps every result between zero and one hundred", () => {
    const results = [
      calculateFixtureRelevance(OUT_OF_POSITIONING_FIXTURE),
      calculateRelevance(
        {
          ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
          noveltyType: "NEW_MODEL",
          contentFormats: [
            "POST",
            "ARTICLE",
            "VIDEO",
            "TUTORIAL",
            "DEMONSTRATION",
            "TECHNICAL_OPINION",
          ],
          commercialRelations: [
            "AUTOMATION_SERVICE",
            "WEBSITE_SERVICE",
            "CUSTOM_SYSTEM",
            "APPLIED_AI",
            "CONSULTING",
            "LEAD_GENERATION",
            "SMALL_BUSINESS_TOOLS",
          ],
        },
        policy,
      ),
    ];
    assert.ok(results.every((result) => result.value >= 0));
    assert.ok(results.every((result) => result.value <= 100));
  });

  test("uses criterion weights that sum to one hundred", () => {
    const result = calculateFixtureRelevance(OFFICIAL_HIGHLY_RELEVANT_FIXTURE);
    assert.equal(
      Object.values(result.weights).reduce((total, value) => total + value, 0),
      100,
    );
    assert.deepEqual(
      result.criteria.map((item) => item.maxScore),
      [30, 15, 20, 15, 10, 10],
    );
  });

  test("classifies a maximum result as critical", () => {
    const result = calculateFixtureRelevance(OFFICIAL_HIGHLY_RELEVANT_FIXTURE);
    assert.equal(result.priority, "CRITICAL");
    assert.equal(result.decision, "FAST_TRACK");
  });

  test("classifies a penalized relevant result as high", () => {
    const result = calculateFixtureRelevance(DUPLICATE_CONTENT_FIXTURE);
    assert.equal(result.priority, "HIGH");
    assert.equal(result.decision, "CONTINUE_TO_VERIFICATION");
  });

  test("classifies an old but relevant result as medium", () => {
    const result = calculateFixtureRelevance(RELEVANT_BUT_OLD_FIXTURE);
    assert.equal(result.priority, "MEDIUM");
    assert.equal(result.decision, "HOLD_FOR_REVIEW");
  });

  test("classifies low relevance clearly", () => {
    const result = calculateFixtureRelevance(OFFICIAL_LOW_IMPACT_FIXTURE);
    assert.equal(result.priority, "LOW");
  });

  test("discards content outside the editorial positioning", () => {
    const result = calculateFixtureRelevance(OUT_OF_POSITIONING_FIXTURE);
    assert.equal(result.priority, "IGNORE");
    assert.equal(result.decision, "DISCARD_LOW_RELEVANCE");
  });

  test("applies an explicit rumor penalty and never fast-tracks it", () => {
    const result = calculateFixtureRelevance(SENSATIONALIST_RUMOR_FIXTURE);
    assert.ok(hasPenalty(result, "UNCONFIRMED_RUMOR"));
    assert.notEqual(result.decision, "FAST_TRACK");
  });

  test("applies an explicit sensationalism penalty", () => {
    assert.ok(
      hasPenalty(
        calculateFixtureRelevance(SENSATIONALIST_RUMOR_FIXTURE),
        "SENSATIONALIST_TITLE",
      ),
    );
  });

  test("applies an explicit duplicate penalty", () => {
    const result = calculateFixtureRelevance(DUPLICATE_CONTENT_FIXTURE);
    assert.ok(hasPenalty(result, "PROBABLY_DUPLICATE"));
    assert.equal(
      result.negativeFactors.some(
        (factor) => factor.code === "PROBABLY_DUPLICATE",
      ),
      true,
    );
  });

  test("penalizes old news presented as current and caps its priority", () => {
    const result = calculateRelevance(
      {
        ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
        eventAt: "2025-12-01T08:00:00.000Z",
      },
      policy,
    );
    assert.ok(hasPenalty(result, "OLD_NEWS_PRESENTED_AS_CURRENT"));
    assert.equal(result.priority, "MEDIUM");
  });

  test("prevents an unknown source from becoming critical", () => {
    const permissiveUnknownPolicy = {
      ...policy,
      sourceScores: { ...policy.sourceScores, UNKNOWN: 15 },
      penaltyPoints: { ...policy.penaltyPoints, unknownSource: 0 },
    } satisfies RelevancePolicy;
    const result = calculateRelevance(
      {
        ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
        noveltyType: "NEW_MODEL",
        sourceType: "UNKNOWN",
      },
      permissiveUnknownPolicy,
    );
    assert.equal(result.value, 100);
    assert.equal(result.priority, "HIGH");
  });

  test("does not let an official source guarantee high impact", () => {
    const result = calculateFixtureRelevance(OFFICIAL_LOW_IMPACT_FIXTURE);
    assert.equal(result.criteria[1]?.score, 15);
    assert.ok(result.value < policy.thresholds.highMin);
  });

  test("returns exactly the same result for the same input and policy", () => {
    const first = calculateFixtureRelevance(DETERMINISTIC_REPLAY_FIXTURE);
    const second = calculateFixtureRelevance(DETERMINISTIC_REPLAY_FIXTURE);
    assert.deepEqual(second, first);
  });

  test("records the explicit policy identity and version", () => {
    const result = calculateFixtureRelevance(
      COMMERCIALLY_USEFUL_UPDATE_FIXTURE,
    );
    assert.equal(result.policyId, "andre-studio-relevance");
    assert.equal(result.policyVersion, "andre-studio-relevance-v1");
    assert.deepEqual(result.thresholds, policy.thresholds);
  });

  test("uses only the dates supplied in the input", () => {
    const result = calculateFixtureRelevance(OFFICIAL_HIGHLY_RELEVANT_FIXTURE);
    assert.equal(
      result.evaluatedAt,
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input.evaluatedAt,
    );
    assert.equal(result.criteria[2]?.reasons[0]?.code, "EVENT_CURRENT");
  });

  test("does not access the real clock", () => {
    const originalNow = Date.now;
    Date.now = () => {
      throw new Error("real clock accessed");
    };
    try {
      assert.doesNotThrow(() =>
        calculateFixtureRelevance(OFFICIAL_HIGHLY_RELEVANT_FIXTURE),
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test("produces the existing ScoreNews command", () => {
    const relevance = calculateFixtureRelevance(
      OFFICIAL_HIGHLY_RELEVANT_FIXTURE,
    );
    assert.deepEqual(toScoreNewsCommand(relevance), {
      type: "ScoreNews",
      relevance,
    });
  });

  test("routes relevant content toward verification", () => {
    const command = toRelevanceRoutingCommand(
      calculateFixtureRelevance(OFFICIAL_HIGHLY_RELEVANT_FIXTURE),
    );
    assert.equal(command.type, "RequestVerification");
  });

  test("routes irrelevant content toward discard", () => {
    const command = toRelevanceRoutingCommand(
      calculateFixtureRelevance(OUT_OF_POSITIONING_FIXTURE),
    );
    assert.equal(command.type, "DiscardLowRelevance");
  });

  test("serializes the complete result as JSON", () => {
    const result = calculateFixtureRelevance(DUPLICATE_CONTENT_FIXTURE);
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized) as RelevanceResult;
    assert.deepEqual(parsed, result);
    assert.ok(serialized.includes("PROBABLY_DUPLICATE"));
  });

  test("recovers an isolated result without losing its explanation", () => {
    const result = calculateFixtureRelevance(
      COMMERCIALLY_USEFUL_UPDATE_FIXTURE,
    );
    const recovered = structuredClone(result);
    assert.notEqual(recovered, result);
    assert.deepEqual(recovered.criteria, result.criteria);
    assert.deepEqual(recovered.penalties, result.penalties);
  });

  test("rejects invalid inputs, policy, dates and unsupported enums", () => {
    assert.throws(
      () =>
        calculateRelevance(
          { ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input, title: "" },
          policy,
        ),
      hasCode(InvalidRelevanceInputError, "INVALID_RELEVANCE_INPUT"),
    );
    assert.throws(
      () =>
        calculateRelevance(
          {
            ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
            publishedAt: "2027-01-01T00:00:00.000Z",
          },
          policy,
        ),
      hasCode(InvalidDateRangeError, "INVALID_DATE_RANGE"),
    );
    assert.throws(
      () =>
        calculateRelevance(
          {
            ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
            sourceType: "UNLISTED",
          } as unknown as RelevanceInput,
          policy,
        ),
      hasCode(UnsupportedSourceTypeError, "UNSUPPORTED_SOURCE_TYPE"),
    );
    assert.throws(
      () =>
        calculateRelevance(
          {
            ...OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
            noveltyType: "UNLISTED",
          } as unknown as RelevanceInput,
          policy,
        ),
      hasCode(UnsupportedNoveltyTypeError, "UNSUPPORTED_NOVELTY_TYPE"),
    );
    assert.throws(
      () =>
        calculateRelevance(
          OFFICIAL_HIGHLY_RELEVANT_FIXTURE.input,
          { ...policy, version: "" },
        ),
      hasCode(InvalidRelevancePolicyError, "INVALID_RELEVANCE_POLICY"),
    );
  });
});

function hasPenalty(result: RelevanceResult, code: string): boolean {
  return result.penalties.some((penalty) => penalty.code === code);
}

function hasCode<T extends Error & { readonly code: string }>(
  ErrorType: new (...args: never[]) => T,
  code: T["code"],
): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof ErrorType && error.code === code;
}
