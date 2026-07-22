const assert = require("node:assert/strict");
const test = require("node:test");

const { parseRateLimitResponse, parseSessionText } = require("../out/usage.js");

function event(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

test("parseSessionText ignores metadata and accumulates prompt token updates", () => {
  const lines = [
    event("2026-07-20T10:00:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }]
    }),
    event("2026-07-20T10:01:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Fix the ledger" }]
    }),
    event("2026-07-20T10:01:01.000Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5
        }
      }
    }),
    event("2026-07-20T10:01:02.000Z", "event_msg", {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 80,
          cached_input_tokens: 10,
          output_tokens: 15,
          reasoning_output_tokens: 2
        }
      }
    })
  ];

  const prompts = parseSessionText(lines.join("\n"), "session-1");

  assert.equal(prompts.length, 1);
  assert.deepEqual(
    {
      text: prompts[0].text,
      session: prompts[0].session,
      sessionTitle: prompts[0].sessionTitle,
      inputTokens: prompts[0].inputTokens,
      cachedTokens: prompts[0].cachedTokens,
      outputTokens: prompts[0].outputTokens
    },
    {
      text: "Fix the ledger",
      session: "session-1",
      sessionTitle: "Fix the ledger",
      inputTokens: 200,
      cachedTokens: 30,
      outputTokens: 52
    }
  );
});

test("parseSessionText skips malformed JSON lines", () => {
  const text = [
    "{not-json}",
    event("2026-07-20T11:00:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "A valid prompt" }]
    })
  ].join("\n");

  assert.equal(parseSessionText(text, "session-2").length, 1);
});

test("parseRateLimitResponse uses a weekly primary window when Codex supplies no 5-hour window", () => {
  const limits = parseRateLimitResponse({
    rateLimits: {
      primary: { usedPercent: 23, windowDurationMins: 10_080, resetsAt: 1_785_258_181 },
      secondary: null
    }
  });

  assert.deepEqual(limits, {
    fiveHour: {},
    weekly: {
      remainingPercent: 77,
      resetAt: new Date("2026-07-28T17:03:01.000Z"),
      windowDurationMins: 10_080
    },
    account: undefined
  });
});
