import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, test } from "node:test";

const editorialPath = resolve(
  "deploy/n8n/workflows/editorial-orchestration-v1.json",
);
const telegramPath = resolve(
  "deploy/n8n/workflows/telegram-editorial-decision-v1.json",
);
const serverPath = resolve(
  "apps/sistemandrestudio-api/src/orchestration-server.ts",
);

describe("n8n orchestration workflow contracts", () => {
  test("exports parseable inactive workflows", async () => {
    const editorial = await workflow(editorialPath);
    const telegram = await workflow(telegramPath);
    assert.equal(editorial.active, false);
    assert.equal(telegram.active, false);
  });

  test("editorial workflow uses a schedule and bounded internal HTTP call", async () => {
    const data = await workflow(editorialPath);
    const types = nodeTypes(data);
    assert.ok(types.includes("n8n-nodes-base.scheduleTrigger"));
    assert.ok(types.includes("n8n-nodes-base.httpRequest"));
    assert.match(JSON.stringify(data), /\/internal\/orchestration\/runs/);
  });

  test("editorial workflow stops when waiting for a human", async () => {
    const text = await readFile(editorialPath, "utf8");
    assert.match(text, /WAITING_HUMAN_DECISION/);
    assert.match(text, /Finish Without Loop/);
    assert.doesNotMatch(text, /while\s*\(|setInterval|automatic.*approve/i);
  });

  test("Telegram workflow minimizes before forwarding", async () => {
    const data = await workflow(telegramPath);
    const names = data.nodes.map((node) => node.name);
    assert.deepEqual(names.slice(0, 3), [
      "Telegram Webhook",
      "Validate Origin and Minimize",
      "Register Decision in Sistema",
    ]);
  });

  test("Telegram workflow forwards to the stable decision endpoint", async () => {
    const text = await readFile(telegramPath, "utf8");
    assert.match(text, /\/internal\/human-decisions/);
    assert.match(text, /x-telegram-bot-api-secret-token/);
  });

  test("workflows contain credential references but no credential values", async () => {
    const text = `${await readFile(editorialPath, "utf8")}\n${
      await readFile(telegramPath, "utf8")
    }`;
    assert.match(text, /CONFIGURE_IN_N8N/);
    assert.doesNotMatch(
      text,
      /(?:bot\d{5,}:|Bearer\s+[A-Za-z0-9._-]{16,}|BEGIN PRIVATE KEY)/,
    );
  });

  test("workflows contain no publishing, social or CRM nodes", async () => {
    const text = `${await readFile(editorialPath, "utf8")}\n${
      await readFile(telegramPath, "utf8")
    }`.toLowerCase();
    assert.doesNotMatch(text, /linkedin|instagram|github|lead flow|publication\/deploy/);
  });

  test("internal API defaults to localhost and requires a secret", async () => {
    const text = await readFile(serverPath, "utf8");
    assert.match(text, /ORCHESTRATION_API_SECRET/);
    assert.match(text, /127\.0\.0\.1/);
    assert.match(text, /API_BIND_FORBIDDEN/);
  });

  test("internal API has stable size, schema and rate errors", async () => {
    const text = await readFile(serverPath, "utf8");
    assert.match(text, /API_PAYLOAD_TOO_LARGE/);
    assert.match(text, /API_PAYLOAD_INVALID/);
    assert.match(text, /API_RATE_LIMIT/);
    assert.match(text, /16_000/);
  });

  test("internal API exposes no deployment endpoint", async () => {
    const text = await readFile(serverPath, "utf8");
    assert.doesNotMatch(text, /\/deploy|\/publish|\/linkedin|\/instagram/);
  });
});

async function workflow(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as {
    readonly active: boolean;
    readonly nodes: readonly { readonly type: string; readonly name: string }[];
  };
}

function nodeTypes(data: Awaited<ReturnType<typeof workflow>>) {
  return data.nodes.map((node) => node.type);
}
