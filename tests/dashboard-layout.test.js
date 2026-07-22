const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { dashboardClient } = require("../out/dashboardClient");
const { dashboardMarkup } = require("../out/dashboardMarkup");
const { dashboardStyles } = require("../out/dashboardStyles");

test("dashboard applies layout and reacts to history filters", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setContent(`<!doctype html><style>${dashboardStyles}</style><body>${dashboardMarkup}<script>
      window.messages = [];
      window.acquireVsCodeApi = () => ({
        getState: () => ({}),
        setState: state => { window.savedState = state; },
        postMessage: message => window.messages.push(message)
      });
      window.chartData = {};
      window.Chart = class {
        constructor(target, config) { this.data = config.data; window.chartData[target.id] = config.data; }
        destroy() {}
        resize() {}
        stop() {}
        update() {}
      };
    </script><script>${dashboardClient}</script></body>`);
    await page.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "snapshot",
            snapshot: {
              fiveHour: { remaining: "80%", reset: "Later", resetPercent: 50 },
              weekly: { remaining: "70%", reset: "Later", resetPercent: 50 },
              locale: "en-GB",
              timeZone: "Europe/London",
              prompts: [
                {
                  time: Date.now(),
                  timestamp: "now",
                  text: "Test prompt",
                  model: "a-very-long-model-name-that-must-not-overlap",
                  session: "s",
                  sessionTitle: "Session",
                  inputTokens: 100,
                  outputTokens: 20,
                  cachedTokens: 10,
                  cost: 0.01
                },
                {
                  time: Date.now() - 2 * 86400000,
                  timestamp: "two days ago",
                  text: "Older prompt",
                  model: "older-model",
                  session: "older",
                  sessionTitle: "Older session",
                  inputTokens: 200,
                  outputTokens: 40,
                  cachedTokens: 20,
                  cost: 0.02
                }
              ],
              account: {},
              appearance: {
                warningThreshold: 40,
                criticalThreshold: 30,
                belowFullColor: "#cccccc",
                warningColor: "#d97706",
                criticalColor: "#dc2626",
                outputDebug: false
              },
              chartOrganisation: "global",
              chartLayout: {
                cardOrder: ["model", "prompts", "tokens"],
                cardSizes: { model: { height: 100, span: 4 } },
                promptColumnOrder: ["prompt", "date", "task", "agent", "input", "output", "cached", "cost"]
              },
              leaderboard: { enabled: false, name: "Anonymous", code: "" },
              scannedAt: "now",
              metadata: { version: "V:test", buildTime: "T:test", lastUpdate: "now" }
            }
          }
        })
      )
    );
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#content > [data-card]")];
      const model = document.querySelector('[data-card="model"]');
      return {
        firstCard: cards[0]?.dataset.card,
        modelHeight: model.offsetHeight,
        modelScrollHeight: model.scrollHeight,
        modelMinWidth: parseFloat(getComputedStyle(model).minWidth),
        organisation: document.getElementById("chartOrganisation").value,
        firstColumn: document.querySelector("[data-prompt-column]")?.dataset.col,
        horizontalOverflow: model.scrollWidth > model.clientWidth
      };
    });
    assert.equal(result.firstCard, "model");
    assert.equal(result.organisation, "global");
    assert.equal(result.firstColumn, "prompt");
    assert.ok(result.modelHeight >= result.modelScrollHeight);
    assert.ok(result.modelMinWidth >= 320);
    assert.equal(result.horizontalOverflow, false);
    const filtered = await page.evaluate(() => {
      const summary = () => ({
        rows: document.querySelectorAll("[data-row]").length,
        input: document.querySelector('[data-card="metric-input"] .metric-value').textContent,
        points: window.chartData["tokens-chart"].datasets[0].data.length
      });
      const oneDay = summary();
      document.querySelector('.range[data-days="90"]').click();
      const ninetyDays = summary();
      const select = document.getElementById("defaultRangeDays");
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return { oneDay, ninetyDays, restored: summary(), savedRange: window.savedState.defaultRangeDays };
    });
    assert.deepEqual(filtered.oneDay, { rows: 1, input: "100", points: 1 });
    assert.deepEqual(filtered.ninetyDays, { rows: 2, input: "300", points: 2 });
    assert.deepEqual(filtered.restored, { rows: 1, input: "100", points: 1 });
    assert.equal(filtered.savedRange, 1);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
