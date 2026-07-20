const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function load(request) {
  if (request === "vscode") return {};
  return originalLoad.apply(this, arguments);
};
const { validateLedgerHistory } = require("../out/leaderboard.js");
Module._load = originalLoad;

function contextWith(entries) {
  const state = new Map(Object.entries(entries));
  return {
    state,
    context: {
      globalState: {
        get(key, fallback) {
          return state.has(key) ? state.get(key) : fallback;
        },
        async update(key, value) {
          await new Promise((resolve) => setImmediate(resolve));
          state.set(key, value);
        }
      }
    }
  };
}

test("validateLedgerHistory reconciles input growth before validation", async () => {
  const timestamp = new Date("2026-07-20T12:00:00.000Z");
  const key = "session-1|" + timestamp.getTime();
  const stored = {
    total: 100,
    estimatedSpend: 0,
    promptCount: 1,
    prompts: { [key]: { input: 100, spend: 0 } }
  };
  const { context, state } = contextWith({
    "leaderboard.usageLedger.v2": stored
  });

  const validation = await validateLedgerHistory(context, [
    { session: "session-1", timestamp, inputTokens: 150 }
  ]);

  assert.equal(validation.valid, true);
  assert.equal(validation.mismatchedPrompts, 0);
  assert.equal(validation.ledgerTokens, 150);
  assert.equal(state.get("leaderboard.usageLedger.v2").prompts[key].input, 150);
});

test("validateLedgerHistory preserves a higher monotonic ledger value", async () => {
  const timestamp = new Date("2026-07-20T12:00:00.000Z");
  const key = "session-1|" + timestamp.getTime();
  const { context } = contextWith({
    "leaderboard.usageLedger.v2": {
      total: 150,
      estimatedSpend: 0,
      promptCount: 1,
      prompts: { [key]: { input: 150, spend: 0 } }
    }
  });

  const validation = await validateLedgerHistory(context, [
    { session: "session-1", timestamp, inputTokens: 100 }
  ]);

  assert.equal(validation.valid, false);
  assert.equal(validation.mismatchedPrompts, 1);
  assert.equal(validation.ledgerTokens, 150);
});
