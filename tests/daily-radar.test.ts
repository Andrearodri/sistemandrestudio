import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDailyRadarMessage, parseDailyRadarCallback, selectDailyRadarCandidates,
  resolveDailyRadarSelection, signDailyRadarCallback, validateRadarSummary, type DailyRadarCandidate,
} from "../apps/sistemandrestudio-api/src/daily-radar-domain.ts";

const candidate = (id: number, sourceId = "github-blog", relevance = id): DailyRadarCandidate => ({
  newsId: `news-${id}`, verificationId: `verification-${id}`, newsVersion: 3,
  sourceId, sourceName: "Official", title: `Item ${String.fromCharCode(64 + id)}`,
  officialLink: `https://example.com/${id}`, publishedAt: `2026-08-08T0${id}:00:00.000Z`,
  relevance, supportedFacts: ["A supported fact."],
});

test("daily radar keeps official, unique and at most five candidates in relevance order", () => {
  const selected = selectDailyRadarCandidates([
    ...Array.from({ length: 7 }, (_, index) => candidate(index + 1)),
    candidate(8, "unknown-source", 99), { ...candidate(9), officialLink: candidate(1).officialLink },
  ]);
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map((item) => item.relevance), [7, 6, 5, 4, 3]);
});

test("daily radar validates bounded summaries and deterministic empty output", () => {
  assert.equal(validateRadarSummary("O anúncio foi confirmado. Ele pode ser útil para desenvolvedores."), "O anúncio foi confirmado. Ele pode ser útil para desenvolvedores.");
  assert.throws(() => validateRadarSummary("A versão 2 está disponível. Ela é útil."));
  assert.equal(formatDailyRadarMessage([]), "Nenhuma novidade oficial elegível nesta rodada.");
});

test("daily radar callbacks are signed and reject tampering", () => {
  const value = signDailyRadarCallback("secret", "daily-radar-abc12345", "select-1");
  assert.deepEqual(parseDailyRadarCallback("secret", value), { runId: "daily-radar-abc12345", action: "select-1" });
  assert.throws(() => parseDailyRadarCallback("secret", value.replace("select-1", "select-2")));
  assert.deepEqual(resolveDailyRadarSelection("select-1", "select-1"), { replayed: true, action: "select-1" });
  assert.throws(() => resolveDailyRadarSelection("select-1", "select-2"), /SELECTION_CONFLICT/);
});
