import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as https from "node:https";
import * as vscode from "vscode";
import { professionalPanelHtml } from "./dashboard";
import { checkLeaderboardName, readLeaderboardSettings, saveLeaderboardSettings, submitLeaderboardUsage, validateLedgerHistory, type LedgerValidation } from "./leaderboard";
import { normalizeAppearanceSettings, parseRateLimitResponse, parseSessionText } from "./usage";

type JsonObject = Record<string, unknown>;

interface LimitWindow {
  remainingPercent?: number;
  resetAt?: Date;
  windowDurationMins?: number;
}

interface PromptRecord {
  timestamp: Date;
  text: string;
  model?: string;
  reasoningEffort?: string;
  session: string;
  sessionTitle?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

interface AccountSummary {
  plan?: string;
  credits?: string;
  renewalDate?: Date;
}

interface UsageSnapshot {
  fiveHour: LimitWindow;
  weekly: LimitWindow;
  prompts: PromptRecord[];
  sessionPath: string;
  usageSource: "codex app-server" | "unavailable";
  scannedAt: Date;
  account?: AccountSummary;
  ledgerValidation?: LedgerValidation;
}

let panel: vscode.WebviewView | undefined;
let webviewReady = false;
let statusBarFiveHour: vscode.StatusBarItem;
let statusBarWeekly: vscode.StatusBarItem;
let output: vscode.LogOutputChannel;
let snapshotCache: UsageSnapshot | undefined;
let nextRefreshAt = 0;
let displayLocale: string | undefined;
let displayTimeZone: string | undefined;
let extensionVersion = "V:—";
let extensionBuildTime = "T:--:--";
let leaderboardForWebview: { enabled: boolean; name: string; code: string } | undefined;
const sessionFileCache = new Map<string, { size: number; modified: number; checkedAt: number; prompts: PromptRecord[] }>();
let sessionFileListCache: { root: string; limit: number; expiresAt: number; files: string[] } | undefined;
let rateLimitsCache:
  { expiresAt: number; value: { fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined } | undefined;
let rateLimitsInFlight: Promise<{ fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined> | undefined;
const RATE_LIMIT_CACHE_MS = 60_000;
const modelPricing = new Map<string, ModelPricing>();
let modelPricingLoadInFlight: Promise<void> | undefined;
let modelPricingLoaded = false;
const loggedPricingWarnings = new Set<string>();
const loggedQuotaWarnings = new Set<string>();
type PricingSource = "openrouter" | "litellm" | "cache";
interface ModelPricing { input: number; cachedInput: number; output: number; source: PricingSource; }
interface ModelPricingCache { version: number; refreshedAt: number; rates: Record<string, Omit<ModelPricing, "source"> & Partial<Pick<ModelPricing, "source">>>; }
const DIRECTORY_SCAN_CONCURRENCY = 8;
const SESSION_DISCOVERY_CACHE_MS = 30_000;
const SESSION_STAT_CACHE_MS = 30_000;
const MODEL_PRICING_FILE = "model-prices.json";
const MODEL_PRICING_REFRESH_MS = 12 * 60 * 60 * 1_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LITELLM_MODELS_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const USAGE_CACHE_FILE = "usage-cache.json";
const USAGE_CACHE_SECRET = "usage-cache.hmac-key";

export function activate(context: vscode.ExtensionContext): void {
  extensionVersion = `V:${String(context.extension.packageJSON.version ?? "—")}`;
  try {
    const buildTime = fsSync.statSync(path.join(context.extensionPath, "out", "extension.js")).mtime;
    extensionBuildTime = `T:${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(buildTime)}`;
  } catch {
    extensionBuildTime = "T:--:--";
  }
  const activationStartedAt = performance.now();
  const resolvedDateTime = new Intl.DateTimeFormat().resolvedOptions();
  displayLocale = resolvedDateTime.locale;
  displayTimeZone = resolvedDateTime.timeZone;
  output = vscode.window.createOutputChannel("Codex Usage Monitor", { log: true });
  context.subscriptions.push(output);
  void readLeaderboardSettings(context).then((settings) => { leaderboardForWebview = settings; });
  debugLog("Extension activated.");
  debugLog(`Performance: activation completed in ${(performance.now() - activationStartedAt).toFixed(1)}ms.`);
  // Right-aligned status items are ordered by priority; keep the 5H segment first.
  statusBarFiveHour = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10_000);
  statusBarWeekly = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9_999);
  statusBarFiveHour.command = "codexUsage.showPanel";
  statusBarWeekly.command = "codexUsage.showPanel";
  context.subscriptions.push(statusBarFiveHour, statusBarWeekly);

  let refreshInFlight = false;
  let refreshQueued = false;
  let initialRefreshScheduled = false;
  let ledgerValidationTimer: NodeJS.Timeout | undefined;
  let ledgerValidationRunning = false;
  const validateLedger = async (): Promise<boolean> => {
    if (!snapshotCache || ledgerValidationRunning) return false;
    ledgerValidationRunning = true;
    try {
      const files = await newestJsonlFiles(snapshotCache.sessionPath, Number.MAX_SAFE_INTEGER);
      debugLog(`Ledger | source=codex-session-history | task=validation | action=start | files=${files.length}; ledgerScope=existing-ledger-prompts.`);
      const history: PromptRecord[] = [];
      for (const file of files) history.push(...(await readSession(file)));
      const validation = validateLedgerHistory(context, history);
      snapshotCache = { ...snapshotCache, ledgerValidation: validation };
      await saveUsageCache(context, snapshotCache);
      if (webviewReady) postSnapshot(snapshotCache);
      const result = validation.valid ? "valid" : "mismatch";
      const message = `Ledger | source=codex-session-history | task=validation | action=complete | result=${result}; matched=${validation.matchedPrompts}; missing=${validation.missingPrompts}; mismatched=${validation.mismatchedPrompts}; ledgerTokens=${validation.ledgerTokens}; historyTokens=${validation.historyTokens}.`;
      if (validation.valid) {
        debugLog(message);
      } else {
        debugWarn(message);
      }
      return true;
    } catch (error) {
      debugWarn(`Ledger | source=codex-session-history | task=validation | action=complete | result=failed; reason=${error instanceof Error ? error.message : String(error)}.`);
      return false;
    } finally {
      ledgerValidationRunning = false;
    }
  };
  const scheduleLedgerValidation = (): void => {
    if (ledgerValidationTimer || ledgerValidationRunning) return;
    ledgerValidationTimer = setTimeout(() => {
      ledgerValidationTimer = undefined;
      void validateLedger();
    }, 120_000);
  };
  const refresh = async (changedFile?: string): Promise<void> => {
    if (refreshInFlight) {
      if (!refreshQueued) {
        refreshQueued = true;
        debugLog("Refresh requested while one is running; one follow-up refresh queued.");
      }
      return;
    }
    refreshInFlight = true;
    {
      refreshQueued = false;
      debugLog("Refresh started.");
      try {
        await ensureModelPricing(context);
        const snapshot = await collectUsage(changedFile);
        snapshotCache = snapshot;
        nextRefreshAt = 0;
        updateStatusBar(snapshot);
        await saveUsageCache(context, snapshot);
        if (webviewReady) {
          postSnapshot(snapshotCache);
        } else {
          debugLog("Webview not ready; cached snapshot will be sent after readiness confirmation.");
        }
        void submitLeaderboardUsage(context, snapshot.prompts.map((prompt) => ({ ...prompt, estimatedCost: estimateCost(prompt) })), { info: debugLog, warn: debugWarn }).then(async (position) => { if (!position || !snapshotCache) return; leaderboardForWebview = await readLeaderboardSettings(context); postSnapshot(snapshotCache); });
        debugLog(`Usage refreshed from ${snapshot.usageSource}.`);
        scheduleLedgerValidation();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not read Codex usage";
        debugError(`Refresh failed: ${message}`);
        if (error instanceof Error && error.stack) {
          debugError(error.stack);
        }
        statusBarFiveHour.text = "5H: N/A / Rst: -- |";
        statusBarWeekly.text = "Weekly: --% / Rst: --";
        statusBarFiveHour.color = undefined;
        statusBarWeekly.color = undefined;
        statusBarFiveHour.tooltip = message;
        statusBarWeekly.tooltip = message;
        statusBarFiveHour.show();
        statusBarWeekly.show();
        if (panel) {
          panel.webview.postMessage({ type: "error", message });
        }
      }
    }
    refreshQueued = false;
    refreshInFlight = false;
  };
  const scheduleInitialRefresh = (): void => {
    if (initialRefreshScheduled) {
      return;
    }
    initialRefreshScheduled = true;
    setTimeout(() => { if (!snapshotCache) void refresh(); }, 2_000);
  };

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view): void {
      panel = view;
      webviewReady = false;
      debugLog("Webview provider resolved.");
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "resources")] };
      const chartScriptUri = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "resources", "chart.umd.js")).toString();
      view.webview.html = professionalPanelHtml(chartScriptUri, view.webview.cspSource, randomBytes(16).toString("base64"));
      debugLog("Webview HTML assigned; scripts enabled.");
      view.onDidDispose(
        () => {
          if (panel === view) {
            panel = undefined;
            webviewReady = false;
          }
        },
        undefined,
        context.subscriptions
      );
      view.webview.onDidReceiveMessage(
        (message: { command?: string; appearance?: unknown; leaderboard?: unknown; error?: unknown; locale?: string; timeZone?: string }) => {
          if (message.command === "ready") {
            debugLog("Webview: ready message received.");
            displayLocale = typeof message.locale === "string" && message.locale ? message.locale : displayLocale;
            displayTimeZone = typeof message.timeZone === "string" && message.timeZone ? message.timeZone : displayTimeZone;
            webviewReady = true;
            if (snapshotCache) {
              updateStatusBar(snapshotCache);
              void ensureModelPricing(context).then(() => { if (snapshotCache) postSnapshot(snapshotCache); });
            } else {
              scheduleInitialRefresh();
            }
          } else if (message.command === "saveAppearance") {
            void saveAppearanceSettings(message.appearance).then(() => refresh(), () => undefined);
          } else if (message.command === "refreshModelPrices") { const cachePath = path.join(context.globalStorageUri.fsPath, MODEL_PRICING_FILE); debugLog("Pricing: manual model-price refresh requested."); void refreshModelPricing(context, cachePath).then((success) => view.webview.postMessage({ type: "pricesRefreshed", success }), (error) => { debugLog(`Pricing: manual refresh failed: ${error instanceof Error ? error.message : String(error)}`); view.webview.postMessage({ type: "pricesRefreshed", success: false }); });
          } else if (message.command === "revalidateLedger") {
            void validateLedger().then((success) => view.webview.postMessage({ type: "ledgerRevalidated", success }));
          } else if (message.command === "saveLeaderboard") {
            void saveLeaderboardSettings(context, message.leaderboard)
              .then(() => readLeaderboardSettings(context))
              .then((settings) => { leaderboardForWebview = settings; return refresh(); })
              .catch((error) => view.webview.postMessage({ type: "leaderboardError", message: error instanceof Error ? error.message : String(error) }));
          } else if (message.command === "checkLeaderboardName") {
            void checkLeaderboardName(context, message.leaderboard)
              .then((result) => view.webview.postMessage({ type: "leaderboardName", ...result }))
              .catch((error) => view.webview.postMessage({ type: "leaderboardName", available: false, message: error instanceof Error ? error.message : String(error) }));
          } else if (message.command === "webviewError") {
            const error = String(message.error ?? "unknown error");
            debugError(`Dashboard webview error: ${error}`);
            view.webview.postMessage({ type: "error", message: `Dashboard script error: ${error}` });
          }
        },
        undefined,
        context.subscriptions
      );
      debugLog("Webview message listener registered.");
      scheduleInitialRefresh();
    }
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexUsage.panel", provider, { webviewOptions: { retainContextWhenHidden: true } })
  );
  context.subscriptions.push(vscode.commands.registerCommand("codexUsage.refresh", refresh));
  context.subscriptions.push(vscode.commands.registerCommand("codexUsage.showOutput", () => output.show(true)));
  context.subscriptions.push(
    vscode.commands.registerCommand("codexUsage.showPanel", async () => {
      await vscode.commands.executeCommand("codexUsage.panel.focus");
      panel?.show(true);
      await refresh();
    })
  );

  let sessionWatcher: fsSync.FSWatcher | undefined;
  let sessionChangeTimer: NodeJS.Timeout | undefined;
  const watchSessions = (): void => {
    sessionWatcher?.close();
    const configuredPath = vscode.workspace.getConfiguration("codexUsage").get<string>("sessionsPath", "").trim();
    const sessionPath = configuredPath || path.join(os.homedir(), ".codex", "sessions");
    try {
      sessionWatcher = fsSync.watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        const relative = filename as string;
        if (!relative || !relative.endsWith(".jsonl")) return;
        if (sessionChangeTimer) clearTimeout(sessionChangeTimer);
        const changedFile = path.join(sessionPath, relative);
        sessionChangeTimer = setTimeout(() => void refresh(changedFile), 5_000);
      });
      debugLog(`Watcher: listening for Codex session changes at ${sessionPath}.`);
    } catch (error) { debugWarn(`Watcher: unavailable for ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  watchSessions();
  context.subscriptions.push({ dispose: () => { if (sessionChangeTimer) clearTimeout(sessionChangeTimer); if (ledgerValidationTimer) clearTimeout(ledgerValidationTimer); sessionWatcher?.close(); } });
  void loadUsageCache(context).then((cached) => {
    if (cached) {
      snapshotCache = cached;
      updateStatusBar(cached);
      void ensureModelPricing(context).then(() => { if (snapshotCache && webviewReady) postSnapshot(snapshotCache); });
      scheduleLedgerValidation();
    }
    void refresh();
  });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexUsage.sessionsPath")) { watchSessions(); void refresh(); }
      else if (event.affectsConfiguration("codexUsage")) { if (snapshotCache && webviewReady) postSnapshot(snapshotCache); }
    })
  );
}

export function deactivate(): void {}
async function usageCacheKey(context: vscode.ExtensionContext): Promise<Buffer> {
  let encoded = await context.secrets.get(USAGE_CACHE_SECRET);
  if (!encoded) { encoded = randomBytes(32).toString("base64"); await context.secrets.store(USAGE_CACHE_SECRET, encoded); }
  return Buffer.from(encoded, "base64");
}
function usageCachePath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration("codexUsage").get<string>("sessionsPath", "").trim();
  const sessionPath = path.resolve(configured || path.join(os.homedir(), ".codex", "sessions"));
  const scope = createHash("sha256").update(sessionPath.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, `${USAGE_CACHE_FILE.replace(".json", "")}-${scope}.json`);
}
async function saveUsageCache(context: vscode.ExtensionContext, snapshot: UsageSnapshot): Promise<void> {
  const payload = JSON.stringify(snapshot);
  const signature = createHmac("sha256", await usageCacheKey(context)).update(payload).digest("base64");
  const target = usageCachePath(context);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ version: 1, payload, signature }), "utf8");
  debugLog(`Cache: saved ${snapshot.prompts.length} dashboard prompt(s).`);
}
async function loadUsageCache(context: vscode.ExtensionContext): Promise<UsageSnapshot | undefined> {
  try {
    const target = usageCachePath(context);
    const stored = object(JSON.parse(await fs.readFile(target, "utf8")));
    const payload = typeof stored?.payload === "string" ? stored.payload : undefined;
    const signature = typeof stored?.signature === "string" ? stored.signature : undefined;
    if (!payload || !signature || stored?.version !== 1) throw new Error("invalid cache envelope");
    const expected = createHmac("sha256", await usageCacheKey(context)).update(payload).digest();
    const actual = Buffer.from(signature, "base64");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("cache signature mismatch");
    const raw = object(JSON.parse(payload));
    const prompts = Array.isArray(raw?.prompts) ? raw.prompts.map(object).filter((prompt): prompt is JsonObject => Boolean(prompt)).map((prompt) => ({ timestamp: dateFrom(prompt.timestamp) ?? new Date(0), text: typeof prompt.text === "string" ? prompt.text : "", model: typeof prompt.model === "string" ? prompt.model : undefined, reasoningEffort: typeof prompt.reasoningEffort === "string" ? prompt.reasoningEffort : undefined, session: typeof prompt.session === "string" ? prompt.session : "", sessionTitle: typeof prompt.sessionTitle === "string" ? prompt.sessionTitle : undefined, inputTokens: number(prompt.inputTokens), outputTokens: number(prompt.outputTokens), cachedTokens: number(prompt.cachedTokens) })) : [];
    const scannedAt = dateFrom(raw?.scannedAt);
    if (!scannedAt || !prompts.length) throw new Error("cache snapshot missing prompts");
    const limit = (value: unknown): LimitWindow => { const item = object(value); return { remainingPercent: number(item?.remainingPercent), resetAt: dateFrom(item?.resetAt), windowDurationMins: number(item?.windowDurationMins) }; };
    const validation = object(raw?.ledgerValidation); const ledgerValidation = validation && typeof validation.valid === "boolean" && dateFrom(validation.checkedAt) ? { valid: validation.valid, checkedAt: dateFrom(validation.checkedAt)!, matchedPrompts: number(validation.matchedPrompts) ?? 0, missingPrompts: number(validation.missingPrompts) ?? 0, mismatchedPrompts: number(validation.mismatchedPrompts) ?? 0, ledgerTokens: number(validation.ledgerTokens) ?? 0, historyTokens: number(validation.historyTokens) ?? 0 } : undefined;
    debugLog(`Cache: loaded ${prompts.length} dashboard prompt(s).`);
    return { fiveHour: limit(raw?.fiveHour), weekly: limit(raw?.weekly), prompts, sessionPath: typeof raw?.sessionPath === "string" ? raw.sessionPath : "", usageSource: raw?.usageSource === "codex app-server" ? "codex app-server" : "unavailable", scannedAt, account: object(raw?.account) ? { plan: typeof object(raw?.account)?.plan === "string" ? object(raw?.account)?.plan as string : undefined, credits: typeof object(raw?.account)?.credits === "string" ? object(raw?.account)?.credits as string : undefined, renewalDate: dateFrom(object(raw?.account)?.renewalDate) } : undefined, ledgerValidation }
  } catch (error) { debugWarn(`Cache: unavailable or rejected: ${error instanceof Error ? error.message : String(error)}`); return undefined; }
}

async function collectUsage(changedFile?: string): Promise<UsageSnapshot> {
  const collectionStartedAt = performance.now();
  debugLog("Collect: reading configuration.");
  const configuration = vscode.workspace.getConfiguration("codexUsage");
  const configuredPath = configuration.get<string>("sessionsPath", "").trim();
  const sessionPath = configuredPath || path.join(os.homedir(), ".codex", "sessions");
  const limit = configuration.get<number>("historyLimit", 100);
  if (changedFile && snapshotCache && changedFile.endsWith(".jsonl")) {
    const liveLimits = await readLiveRateLimits(true);
    const session = path.basename(changedFile, ".jsonl");
    const updatedPrompts = await readSession(changedFile, true);
    const prompts = [...snapshotCache.prompts.filter((prompt) => prompt.session !== session), ...updatedPrompts].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()).slice(0, limit);
    debugLog(`Collect: updated active session ${session}; ${updatedPrompts.length} prompt(s), no historical scan.`);
    return { ...snapshotCache, fiveHour: hasLimitData(liveLimits?.fiveHour) ? liveLimits!.fiveHour : snapshotCache.fiveHour, weekly: hasLimitData(liveLimits?.weekly) ? liveLimits!.weekly : snapshotCache.weekly, account: liveLimits?.account ?? snapshotCache.account, usageSource: liveLimits ? "codex app-server" : snapshotCache.usageSource, prompts, scannedAt: new Date() };
  }
  const liveLimitsPromise = readLiveRateLimits();
  const scanStartedAt = performance.now();
  const files = await newestJsonlFiles(sessionPath, limit).catch(() => []);
  debugLog(`Performance: session scan completed in ${(performance.now() - scanStartedAt).toFixed(1)}ms.`);
  debugLog(`Collect: found ${files.length} session file(s) at ${sessionPath}.`);
  const prompts: PromptRecord[] = [];

  const parseStartedAt = performance.now();
  for (const [index, file] of files.entries()) {
    try {
      prompts.push(...(await readSession(file, index < 5)));
    } catch (error) {
      debugWarn(`Collect: failed reading ${file}: ${String(error)}`);
    }
  }
  debugLog(`Performance: session parsing completed in ${(performance.now() - parseStartedAt).toFixed(1)}ms.`);
  const liveLimits = await liveLimitsPromise;
  debugLog(`Collect: live limits ${liveLimits ? "received" : "unavailable"}; ${prompts.length} prompt(s) parsed.`);
  const usageSource = liveLimits ? "codex app-server" : "unavailable";
  debugLog(`Performance: collection completed in ${(performance.now() - collectionStartedAt).toFixed(1)}ms.`);
  prompts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return {
    fiveHour: liveLimits?.fiveHour ?? {},
    weekly: liveLimits?.weekly ?? {},
    prompts: prompts.slice(0, limit),
    sessionPath,
    usageSource,
    scannedAt: new Date(),
    account: liveLimits?.account
  };
}

async function readLiveRateLimits(force = false): Promise<{ fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined> {
  if (!force && rateLimitsCache && rateLimitsCache.expiresAt > Date.now()) {
    return rateLimitsCache.value;
  }
  if (rateLimitsInFlight) {
    return rateLimitsInFlight;
  }
  rateLimitsInFlight = requestLiveRateLimits();
  try {
    const value = await rateLimitsInFlight;
    rateLimitsCache = { value, expiresAt: Date.now() + RATE_LIMIT_CACHE_MS };
    return value;
  } finally {
    rateLimitsInFlight = undefined;
  }
}

async function requestLiveRateLimits(): Promise<{ fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined> {
  debugLog("Limits: requesting Codex app-server rate limits.");
  const result = await readAppServerResult().catch((error) => {
    debugWarn(`Limits: app-server request failed: ${String(error)}`);
    return undefined;
  });
  const limits = parseRateLimitResponse(result);
  if (!limits) {
    const warning = "Limits: Codex returned no usable quota windows.";
    if (!loggedQuotaWarnings.has(warning)) { loggedQuotaWarnings.add(warning); debugWarn(warning); }
  } else if (!hasLimitData(limits.fiveHour)) {
    const warning = "Limits: Codex returned a weekly window but did not supply a 5-hour window; preserving the last 5-hour value when available.";
    if (!loggedQuotaWarnings.has(warning)) { loggedQuotaWarnings.add(warning); debugWarn(warning); }
  }
  return limits;
}
function hasLimitData(window: LimitWindow | undefined): window is LimitWindow {
  return window?.remainingPercent !== undefined || window?.resetAt !== undefined || window?.windowDurationMins !== undefined;
}

function rateLimitSources(root: JsonObject): JsonObject[] {
  const sources: JsonObject[] = [root];
  const add = (value: unknown): void => {
    const candidate = object(value);
    if (candidate && !sources.includes(candidate)) {
      sources.push(candidate);
    }
  };
  add(root.rateLimits);
  add(root.rate_limits);
  for (const collection of [object(root.rateLimitsByLimitId), object(root.rate_limits_by_limit_id)]) {
    if (!collection) continue;
    add(collection);
    Object.values(collection).forEach(add);
  }
  for (const source of [...sources]) {
    Object.values(source).forEach(add);
  }
  return sources;
}

function findLimitWindow(sources: JsonObject[], keys: string[]): JsonObject | undefined {
  for (const source of sources) {
    const direct = firstObject(source, keys);
    if (direct) return direct;
    for (const value of Object.values(source)) {
      const nested = object(value);
      const candidate = nested && firstObject(nested, keys);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function firstObject(source: JsonObject, keys: string[]): JsonObject | undefined {
  for (const key of keys) {
    const candidate = object(source[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function readAccountSummary(root: JsonObject, rateLimits: JsonObject): AccountSummary | undefined {
  const sources = [root, rateLimits, object(root.account), object(root.subscription), object(root.plan)].filter(
    (value): value is JsonObject => Boolean(value)
  );
  const readText = (keys: string[]): string | undefined => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
      }
    }
    return undefined;
  };
  const renewal = sources
    .map(
      (source) => dateFrom(source.renews_at) ?? dateFrom(source.renewal_date) ?? dateFrom(source.renewalAt) ?? dateFrom(source.renewalDate)
    )
    .find(Boolean);
  const account: AccountSummary = {
    plan: readText(["plan", "plan_name", "planName", "subscription_plan", "subscriptionPlan"]),
    credits: readText(["credits", "credit_balance", "creditBalance", "balance"]),
    renewalDate: renewal
  };
  return account.plan || account.credits || account.renewalDate ? account : undefined;
}

function toLimitWindow(value: JsonObject | undefined): LimitWindow | undefined {
  if (!value) {
    return undefined;
  }
  const usedPercent =
    number(value.used_percent) ?? number(value.usedPercent) ?? number(value.used_percentage) ?? number(value.usedPercentage);
  const remainingPercent =
    number(value.remaining_percent) ??
    number(value.remainingPercent) ??
    number(value.remaining_percentage) ??
    number(value.remainingPercentage);
  const resetAt =
    dateFrom(value.resets_at) ??
    dateFrom(value.reset_at) ??
    dateFrom(value.resetsAt) ??
    dateFrom(value.resetAt) ??
    dateFrom(value.reset_time) ??
    dateFrom(value.resetTime);
  const windowDurationMins =
    number(value.window_duration_mins) ?? number(value.windowDurationMins) ?? number(value.window_minutes) ?? number(value.windowMinutes);
  if (usedPercent === undefined && remainingPercent === undefined) {
    return undefined;
  }
  return { remainingPercent: Math.max(0, Math.min(100, remainingPercent ?? 100 - (usedPercent ?? 0))), resetAt, windowDurationMins };
}
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "VSCode-Codex-Tracker" } }, (response) => {
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.resume(); reject(new Error(`HTTP ${response.statusCode ?? "unknown"} from ${url}`)); return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => { try { resolve(JSON.parse(text)); } catch { reject(new Error(`Invalid JSON from ${url}`)); } });
    }).on("error", reject);
  });
}
function modelKey(value: string): string { return value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value; }
async function accessibleModelKeys(): Promise<Set<string>> {
  const result = object(await readAppServerResult("model/list", {}));
  const models = Array.isArray(result?.models) ? result.models : Array.isArray(result?.data) ? result.data : [];
  const ids = new Set<string>();
  for (const item of models) {
    const model = object(item); const id = typeof model?.id === "string" ? model.id : typeof model?.slug === "string" ? model.slug : typeof model?.name === "string" ? model.name : undefined;
    if (id) ids.add(modelKey(id));
  }
  debugLog(`Pricing: Codex access filter contains ${ids.size} model(s).`);
  return ids;
}
async function ensureModelPricing(context: vscode.ExtensionContext): Promise<void> {
  if (modelPricingLoaded) return;
  if (modelPricingLoadInFlight) return modelPricingLoadInFlight;
  modelPricingLoadInFlight = (async () => {
    const cachePath = path.join(context.globalStorageUri.fsPath, MODEL_PRICING_FILE);
    let cached: ModelPricingCache | undefined;
    try {
      cached = JSON.parse(await fs.readFile(cachePath, "utf8")) as ModelPricingCache;
      for (const [id, rate] of Object.entries(cached.rates ?? {})) modelPricing.set(id, { ...rate, source: rate.source === "openrouter" || rate.source === "litellm" ? rate.source : "cache" });
      debugLog(`Pricing: loaded ${modelPricing.size} cached rate(s) from local model-prices.json; provider metadata=${cached.version >= 3 ? "preserved" : "unavailable (legacy cache)"}.`);
    } catch (error) { debugLog(`Pricing: local model-prices.json unavailable: ${error instanceof Error ? error.message : String(error)}.`); }
    debugLog(`Pricing: retained ${modelPricing.size} cached rate(s), including historical models.`);
    modelPricingLoaded = true;
    if (!cached || cached.version < 3 || cached.refreshedAt + MODEL_PRICING_REFRESH_MS <= Date.now()) void refreshModelPricing(context, cachePath);
  })();
  try { await modelPricingLoadInFlight; } finally { modelPricingLoadInFlight = undefined; }
}
async function refreshModelPricing(context: vscode.ExtensionContext, cachePath: string): Promise<boolean> {
  const merged = new Map<string, ModelPricing>();
  const cachedRates = new Map(modelPricing);
  let openRouterOk = false;
  let liteLlmOk = false;
  try {
    const root = object(await fetchJson(OPENROUTER_MODELS_URL));
    for (const item of Array.isArray(root?.data) ? root.data : []) {
      const model = object(item); const pricing = object(model?.pricing); const id = typeof model?.id === "string" ? model.id : undefined;
      const input = typeof pricing?.prompt === "string" ? Number(pricing.prompt) * 1_000_000 : undefined;
      const output = typeof pricing?.completion === "string" ? Number(pricing.completion) * 1_000_000 : undefined;
      if (id?.startsWith("openai/") && input !== undefined && output !== undefined && Number.isFinite(input) && Number.isFinite(output)) merged.set(modelKey(id), { input, cachedInput: typeof pricing?.input_cache_read === "string" ? Number(pricing.input_cache_read) * 1_000_000 : input * .1, output, source: "openrouter" });
    }
    openRouterOk = true; debugLog(`Pricing: OpenRouter returned ${merged.size} usable OpenAI rate(s).`);
  } catch (error) { debugWarn(`Pricing: OpenRouter unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const root = object(await fetchJson(LITELLM_MODELS_URL));
    for (const [id, raw] of Object.entries(root ?? {})) {
      if (id.includes("/") && !id.startsWith("openai/")) continue; if (merged.has(modelKey(id))) continue;
      const model = object(raw); const input = number(model?.input_cost_per_token); const output = number(model?.output_cost_per_token);
      if (input !== undefined && output !== undefined) merged.set(modelKey(id), { input: input * 1_000_000, cachedInput: (number(model?.cache_read_input_token_cost) ?? input * .1) * 1_000_000, output: output * 1_000_000, source: "litellm" });
    }
    liteLlmOk = true; debugLog(`Pricing: LiteLLM filled missing rates; combined catalogue=${merged.size}.`);
  } catch (error) { debugWarn(`Pricing: LiteLLM unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  try {
    const accessible = await accessibleModelKeys();
    for (const id of merged.keys()) if (!accessible.has(modelKey(id))) merged.delete(id);
    const fallbackModels: string[] = [];
    for (const [id, pricing] of cachedRates) {
      if (!merged.has(id)) {
        merged.set(id, { ...pricing, source: "cache" });
        fallbackModels.push(id);
      }
    }
    debugLog(`Pricing: retained ${merged.size} rate(s); local-cache fallback=${fallbackModels.length ? fallbackModels.join(",") : "none"}.`);
  } catch (error) { debugWarn(`Pricing: access filter failed; live catalogue not saved. ${error instanceof Error ? error.message : String(error)}`); return false; }
  if (!openRouterOk && !liteLlmOk) { debugWarn("Pricing: both live providers failed; continuing with the last local catalogue."); return false; }
  if (!merged.size) { debugWarn("Pricing: live providers returned no complete rates for accessible models; continuing with the last local catalogue."); return false; }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({ version: 3, refreshedAt: Date.now(), rates: Object.fromEntries(merged) }), "utf8");
  const changed = JSON.stringify([...modelPricing]) !== JSON.stringify([...merged]);
  modelPricing.clear(); merged.forEach((pricing, id) => modelPricing.set(id, pricing));
  for (const [id, pricing] of modelPricing) debugLog(`Pricing: model=${id}; source=${pricing.source}; input=$${pricing.input}/1M; cached=$${pricing.cachedInput}/1M; output=$${pricing.output}/1M.`);
  if (changed && snapshotCache && webviewReady) postSnapshot(snapshotCache);
  debugLog(`Pricing: saved ${modelPricing.size} live rate(s) to local model-prices.json; changed=${changed}.`);
  return changed;
}
function pricingValue(model: JsonObject | undefined, keys: string[]): number | undefined {
  if (!model) return undefined;
  for (const key of keys) { const value = number(model[key]); if (value !== undefined) return value < .01 ? value * 1_000_000 : value; }
  return undefined;
}
function debugLog(message: string): void { debugOutput("INFO", message); }
function debugWarn(message: string): void { debugOutput("WARN", message); }
function debugError(message: string): void { debugOutput("ERROR", message); }
function debugOutput(level: "INFO" | "WARN" | "ERROR", message: string): void {
  if (!readAppearanceSettings().outputDebug) return;
  output.appendLine(`[${level}] ${structuredDebugMessage(message)}`);
}
function structuredDebugMessage(message: string): string {
  if (/^[A-Za-z][A-Za-z -]* \\| source=[^|]+ \\| task=[^|]+ \\| action=[^|]+/.test(message)) return message;
  const separator = message.indexOf(":");
  const source = (separator > 0 ? message.slice(0, separator) : "extension")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") || "extension";
  const detail = (separator > 0 ? message.slice(separator + 1) : message).trim();
  return `Extension | source=${source} | task=diagnostic | action=event | detail=${detail}`;
}
function appServerResponseSummary(method: string, result: unknown): string {
  if (method !== "account/rateLimits/read") return `App-server ${method}: response received.`;
  const limits = object(object(result)?.rateLimits);
  const primary = object(limits?.primary);
  const secondary = object(limits?.secondary);
  const plan = typeof limits?.planType === "string" ? limits.planType : "unknown";
  const describe = (window: JsonObject | undefined): string => window ? `${number(window.usedPercent) ?? "?"}% used / ${number(window.windowDurationMins) ?? "?"} min` : "not supplied";
  return `App-server limits: plan=${plan}; primary=${describe(primary)}; secondary=${describe(secondary)}.`;
}

async function readAppServerResult(method = "account/rateLimits/read", params: JsonObject | null = null): Promise<unknown> {
  const requestStartedAt = performance.now();
  const command = await resolveCodexCommand();
  debugLog(`App-server: starting ${command}.`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stderr.on("data", (chunk) => debugWarn(`App-server stderr: ${String(chunk).trim()}`));
    debugLog("App-server: process started.");
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      callback();
    };
    const timeout = setTimeout(
      () => finish(() => reject(new Error(`Codex app-server ${method} request timed out after 8 seconds`))),
      8_000
    );
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", () => finish(() => reject(new Error("Codex app-server exited before returning rate limits"))));
    child.stdin.on("error", () => undefined);
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (message.id !== 2) {
          return;
        }
        if (message.error) {
          finish(() => reject(new Error(message.error?.message ?? "Codex app-server rejected the request")));
          return;
        }
        finish(() => {
          debugLog(appServerResponseSummary(method, message.result));
          debugLog(`Performance: app-server response completed in ${(performance.now() - requestStartedAt).toFixed(1)}ms.`);
          resolve(message.result);
        });
      } catch {
        // Ignore non-JSON stdout lines from the CLI.
      }
    });
    const send = (payload: JsonObject): void => {
      const methodName = typeof payload.method === "string" ? payload.method : "unknown"; debugLog(`App-server request: ${methodName}.`); child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "VSCode Codex Tracker", version: "0.0.1" }, capabilities: { experimentalApi: true } }
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method, params });
  });
}

async function resolveCodexCommand(): Promise<string> {
  const configured = vscode.workspace.getConfiguration("codexUsage").get<string>("codexPath", "").trim();
  if (configured) {
    return configured;
  }
  const openAiExtension = vscode.extensions.getExtension("openai.chatgpt");
  if (openAiExtension) {
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
    const executable = process.platform === "win32" ? "codex.exe" : "codex";
    const bundled = path.join(openAiExtension.extensionPath, "bin", `${platform}-${architecture}`, executable);
    try {
      await fs.access(bundled);
      return bundled;
    } catch {
      // Fall through to PATH for standalone Codex CLI installations.
    }
  }
  return "codex";
}

async function newestJsonlFiles(root: string, limit: number): Promise<string[]> {
  if (sessionFileListCache?.root === root && sessionFileListCache.limit === limit && sessionFileListCache.expiresAt > Date.now()) return sessionFileListCache.files;
  const candidates: Array<{ file: string; modified: number }> = [];
  const directories = [root];
  const visit = async (): Promise<void> => {
    for (;;) {
      const directory = directories.pop();
      if (!directory) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(target);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stat = await fs.stat(target);
          candidates.push({ file: target, modified: stat.mtimeMs });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: DIRECTORY_SCAN_CONCURRENCY }, visit));
  const files = candidates.sort((a, b) => b.modified - a.modified).slice(0, limit).map((candidate) => candidate.file);
  sessionFileListCache = { root, limit, files, expiresAt: Date.now() + SESSION_DISCOVERY_CACHE_MS };
  return files;
}

async function readSession(file: string, forceCheck = false): Promise<PromptRecord[]> {
  const cached = sessionFileCache.get(file);
  if (cached && !forceCheck && cached.checkedAt + SESSION_STAT_CACHE_MS > Date.now()) return cached.prompts;
  const stat = await fs.stat(file);
  if (cached && cached.size === stat.size && cached.modified === stat.mtimeMs) {
    cached.checkedAt = Date.now();
    return cached.prompts;
  }
  const prompts = parseSessionText(await fs.readFile(file, "utf8"), path.basename(file, ".jsonl"));
  sessionFileCache.set(file, { size: stat.size, modified: stat.mtimeMs, checkedAt: Date.now(), prompts });
  return prompts;
}

function messageText(message: JsonObject): string | undefined {
  const content = Array.isArray(message.content) ? message.content : [];
  return (
    content
      .map((item) => object(item))
      .filter((item): item is JsonObject => Boolean(item))
      .filter((item) => item.type === "input_text" || item.type === "text")
      .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
      .filter(Boolean)
      .join("\n") || undefined
  );
}

function isSessionMetadata(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    /^<\s*(agents\.md|instructions|recommended_plugins|environment_context)/.test(normalized) ||
    normalized.startsWith("agents.md instructions") ||
    normalized.startsWith("you are codex") ||
    normalized.startsWith("# agents.md")
  );
}

function taskTitle(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 96);
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function dateFrom(value: unknown): Date | undefined {
  const date =
    typeof value === "string"
      ? new Date(value)
      : typeof value === "number"
        ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
        : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}
function calculateApiEquivalentCost(usage: { model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  const prices = modelPricing.get(usage.model) ?? modelPricing.get(modelKey(usage.model));
  if (!prices) throw new Error(`No pricing configured for: ${usage.model}`);
  if (usage.inputTokens < 0 || usage.cachedInputTokens < 0 || usage.outputTokens < 0) throw new Error("Token counts cannot be negative");
  if (usage.cachedInputTokens > usage.inputTokens) throw new Error("cachedInputTokens cannot exceed inputTokens");
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens;
  return (uncachedInputTokens / 1_000_000) * prices.input + (usage.cachedInputTokens / 1_000_000) * prices.cachedInput + (usage.outputTokens / 1_000_000) * prices.output;
}
function estimateCost(prompt: PromptRecord): number {
  const inputTokens = prompt.inputTokens ?? 0;
  const cachedInputTokens = prompt.cachedTokens ?? 0;
  const outputTokens = prompt.outputTokens ?? 0;
  const model = prompt.model ?? "unknown";
  try {
    return calculateApiEquivalentCost({ model: prompt.model ?? "", inputTokens, cachedInputTokens, outputTokens });
  } catch (error) {
    const warning = `Pricing: model=${model}; status=missing-after-cache-and-live-sources; reason=${error instanceof Error ? error.message : String(error)}; catalogueRates=${modelPricing.size}; action=cost unavailable.`;
    if (!loggedPricingWarnings.has(warning)) { loggedPricingWarnings.add(warning); debugWarn(warning); }
    return 0;
  }
}

function updateStatusBar(snapshot: UsageSnapshot): void {
  const appearance = readAppearanceSettings();
  statusBarFiveHour.text = `5H: ${formatPercent(snapshot.fiveHour)} / Rst: ${formatReset(snapshot.fiveHour)} |`;
  statusBarWeekly.text = `Weekly: ${formatPercent(snapshot.weekly)} / Rst: ${formatReset(snapshot.weekly)}`;
  statusBarFiveHour.color = statusColor(snapshot.fiveHour, appearance);
  statusBarWeekly.color = statusColor(snapshot.weekly, appearance);
  const tooltip = `Codex Usage Monitor — 5H resets ${formatReset(snapshot.fiveHour)}, weekly resets ${formatReset(snapshot.weekly)}. Source: ${snapshot.usageSource}.`;
  statusBarFiveHour.tooltip = tooltip;
  statusBarWeekly.tooltip = tooltip;
  statusBarFiveHour.show();
  statusBarWeekly.show();
}

function postSnapshot(snapshot: UsageSnapshot): void {
  const renderStartedAt = performance.now();
  if (!panel || !webviewReady) {
    debugLog("Webview: snapshot skipped because panel is unavailable.");
    return;
  }
  debugLog(`Webview: sending snapshot with ${snapshot.prompts.length} prompt(s).`);
  void panel.webview
    .postMessage({
      type: "snapshot",
      snapshot: {
        fiveHour: {
          remaining: formatPercent(snapshot.fiveHour),
          reset: formatReset(snapshot.fiveHour),
          resetPercent: formatResetPercent(snapshot.fiveHour)
        },
        weekly: {
          remaining: formatPercent(snapshot.weekly),
          reset: formatReset(snapshot.weekly),
          resetPercent: formatResetPercent(snapshot.weekly)
        },
        locale: displayLocale,
        timeZone: displayTimeZone,
        prompts: snapshot.prompts.map((prompt) => ({
          timestamp: formatDateTime(prompt.timestamp),
          time: prompt.timestamp.getTime(),
          text: prompt.text,
          model: prompt.model ?? "Codex",
          session: prompt.session,
          sessionTitle: prompt.sessionTitle ?? prompt.session,
          inputTokens: prompt.inputTokens ?? 0,
          outputTokens: prompt.outputTokens ?? 0,
          cachedTokens: prompt.cachedTokens ?? 0,
          cost: estimateCost(prompt)
        })),
        sessionPath: snapshot.sessionPath,
        usageSource: snapshot.usageSource,
        account: snapshot.account
          ? {
              plan: snapshot.account.plan,
              credits: snapshot.account.credits,
              renewal: snapshot.account.renewalDate ? formatDateOnly(snapshot.account.renewalDate) : undefined
            }
          : undefined,
        appearance: readAppearanceSettings(),
        leaderboard: leaderboardForWebview,
        ledgerValidation: snapshot.ledgerValidation ? { ...snapshot.ledgerValidation, checkedAt: snapshot.ledgerValidation.checkedAt.getTime() } : undefined,
        scannedAt: formatDateTime(snapshot.scannedAt),
        nextRefreshAt,
        metadata: { version: extensionVersion, buildTime: extensionBuildTime, lastUpdate: formatClock(snapshot.scannedAt) }
      }
    })
    .then(
      (delivered) =>
        debugLog(
          `Webview: snapshot delivery ${delivered ? "accepted" : "rejected"}; render handoff ${(performance.now() - renderStartedAt).toFixed(1)}ms.`
        ),
      (error) => debugLog(`Webview: snapshot delivery failed: ${String(error)}`)
    );
}

function formatPercent(window: LimitWindow): string {
  return window.remainingPercent === undefined ? "N/A" : `${Math.round(window.remainingPercent).toString().padStart(2, "0")}%`;
}
function formatReset(window: LimitWindow): string {
  return window.resetAt ? formatDateTime(window.resetAt) : "N/A";
}
function formatResetPercent(window: LimitWindow): number {
  if (!window.resetAt || !window.windowDurationMins) return 0;
  return Math.max(0, Math.min(100, ((window.resetAt.getTime() - Date.now()) / (window.windowDurationMins * 60_000)) * 100));
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(displayLocale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(displayTimeZone ? { timeZone: displayTimeZone } : {})
  }).format(date);
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat(displayLocale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    ...(displayTimeZone ? { timeZone: displayTimeZone } : {})
  }).format(date);
}

function formatDateOnly(date: Date): string {
  return new Intl.DateTimeFormat(displayLocale, {
    day: "2-digit",
    month: "2-digit",
    ...(displayTimeZone ? { timeZone: displayTimeZone } : {})
  }).format(date);
}

interface AppearanceSettings {
  warningThreshold: number;
  criticalThreshold: number;
  warningColor: string;
  criticalColor: string;
  belowFullColor: string;
  refreshIntervalSeconds: number;
  outputDebug: boolean;
}

function readAppearanceSettings(): AppearanceSettings {
  const configuration = vscode.workspace.getConfiguration("codexUsage");
  const warningThreshold = clampPercentage(configuration.get<number>("warningThresholdPercent", 40));
  const criticalThreshold = Math.min(clampPercentage(configuration.get<number>("criticalThresholdPercent", 30)), warningThreshold);
  return {
    warningThreshold,
    criticalThreshold,
    warningColor: validColor(configuration.get<string>("warningColor", "#d97706"), "#d97706"),
    criticalColor: validColor(configuration.get<string>("criticalColor", "#dc2626"), "#dc2626"),
    belowFullColor: validColor(configuration.get<string>("belowFullColor", "#cccccc"), "#cccccc"),
    refreshIntervalSeconds: Math.max(10, Math.min(3600, configuration.get<number>("refreshIntervalSeconds", 60))),
    outputDebug: configuration.get<boolean>("outputDebug", false)
  };
}

function statusColor(window: LimitWindow, appearance: AppearanceSettings): string | undefined {
  const value = window.remainingPercent;
  if (value === undefined) {
    return undefined;
  }
  if (value <= appearance.criticalThreshold) {
    return appearance.criticalColor;
  }
  if (value <= appearance.warningThreshold) {
    return appearance.warningColor;
  }
  if (value < 100) {
    return appearance.belowFullColor;
  }
  return undefined;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}
function validColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}
async function saveAppearanceSettings(value: unknown): Promise<void> {
  const appearance = normalizeAppearanceSettings(value);
  const configuration = vscode.workspace.getConfiguration("codexUsage");
  await Promise.all([
    configuration.update("warningThresholdPercent", appearance.warningThreshold, vscode.ConfigurationTarget.Global),
    configuration.update("criticalThresholdPercent", appearance.criticalThreshold, vscode.ConfigurationTarget.Global),
    configuration.update("warningColor", appearance.warningColor, vscode.ConfigurationTarget.Global),
    configuration.update("criticalColor", appearance.criticalColor, vscode.ConfigurationTarget.Global),
    configuration.update("belowFullColor", appearance.belowFullColor, vscode.ConfigurationTarget.Global),
    configuration.update("refreshIntervalSeconds", appearance.refreshIntervalSeconds, vscode.ConfigurationTarget.Global),
    configuration.update("outputDebug", appearance.outputDebug, vscode.ConfigurationTarget.Global)
  ]);
}
function enhancedPanelHtml(): string {
  return String.raw`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;margin:0}.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.title{font-size:28px}.actions{display:flex;gap:12px;align-items:center}.muted{color:var(--vscode-descriptionForeground)}button{font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:5px 9px}.summary,.charts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}.quota,.panel{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:7px;padding:14px}.quota strong{display:block;font-size:24px;margin:5px 0}.spend{grid-column:span 2}.charts{grid-template-columns:1fr 2fr}.chart{width:100%;height:170px}.legend{font-size:12px;margin-bottom:7px}.settings{margin-bottom:14px;padding:14px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border);border-radius:7px}.settings[hidden]{display:none}.setting-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.settings label{display:grid;gap:4px;color:var(--vscode-descriptionForeground)}input{font:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px}.settings input[type=color]{height:28px;padding:1px}.table-panel{padding:0;overflow:auto}.table-heading{display:flex;justify-content:space-between;padding:14px;border-bottom:1px solid var(--vscode-panel-border)}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border)}.num{text-align:right}.prompt-cell{max-width:0}.prompt-line{display:flex;gap:8px}.prompt-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.expand{color:var(--vscode-textLink-foreground);padding:0;border:0;background:none}.prompt-full{white-space:pre-wrap;margin-top:8px}@media(max-width:700px){.summary,.charts{grid-template-columns:1fr 1fr}}@media(max-width:500px){.summary,.charts{grid-template-columns:1fr}}</style></head><body><div class="toolbar"><div class="title">Usage</div><div class="actions"><span id="updated" class="muted">Loading…</span><button id="settingsToggle">⚙</button></div></div><section id="settings" class="settings" hidden><form id="settingsForm"><div class="setting-grid"><label>Refresh seconds<input id="refreshIntervalSeconds" type="number" min="10" max="3600"></label><label>Warning threshold %<input id="warningThreshold" type="number" min="0" max="100"></label><label>Critical threshold %<input id="criticalThreshold" type="number" min="0" max="100"></label><label>Below 100% colour<input id="belowFullColor" type="color"></label><label>Warning colour<input id="warningColor" type="color"></label><label>Critical colour<input id="criticalColor" type="color"></label></div><button type="submit">Save settings</button></form></section><div id="content">Loading…</div><script>const vscode=acquireVsCodeApi(),content=document.getElementById('content'),settingsToggle=document.getElementById('settingsToggle'),settings=document.getElementById('settings'),settingsForm=document.getElementById('settingsForm'),updated=document.getElementById('updated');let nextRefreshAt=0;setTimeout(()=>vscode.postMessage({command:'ready'}),0);window.onerror=(message)=>vscode.postMessage({command:'webviewError',error:String(message)});const esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),fmt=v=>new Intl.NumberFormat().format(v||0),money=v=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:4}).format(v||0);const chart=(p,keys,colors)=>{const w=600,h=170,m=24,max=Math.max(1,...p.flatMap(x=>keys.map(k=>x[k]||0))),x=i=>m+i*(w-2*m)/Math.max(1,p.length-1),y=v=>h-m-v/max*(h-2*m);return '<svg class="chart" viewBox="0 0 '+w+' '+h+'">'+keys.map((k,n)=>'<polyline fill="none" stroke="'+colors[n]+'" stroke-width="2" points="'+p.map((v,i)=>x(i)+','+y(v[k]||0)).join(' ')+'"/>').join('')+'</svg>'};const buckets=ps=>{const m=new Map();ps.forEach(p=>{const k=new Date(p.time).toLocaleDateString(undefined,{month:'short',day:'numeric'}),r=m.get(k)||{input:0,output:0,cached:0,cost:0};r.input+=p.inputTokens||0;r.output+=p.outputTokens||0;r.cached+=p.cachedTokens||0;r.cost+=p.cost||0;m.set(k,r)});return [...m.values()].reverse().slice(-7)};settingsToggle.onclick=()=>settings.hidden=!settings.hidden;settingsForm.onsubmit=e=>{e.preventDefault();vscode.postMessage({command:'saveAppearance',appearance:{refreshIntervalSeconds:+refreshIntervalSeconds.value,warningThreshold:+warningThreshold.value,criticalThreshold:+criticalThreshold.value,belowFullColor:belowFullColor.value,warningColor:warningColor.value,criticalColor:criticalColor.value}})};content.onclick=e=>{const b=e.target.closest('[data-expand]');if(b){const f=b.closest('td').querySelector('.prompt-full');f.hidden=!f.hidden;b.textContent=f.hidden?'Expand':'Collapse'}};setInterval(()=>{if(updated.dataset.updated){const s=Math.max(0,Math.ceil((nextRefreshAt-Date.now())/1000));updated.textContent=updated.dataset.updated+' · Update in: '+(s>=60?Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s':s+'s')}},1000);window.onmessage=e=>{const d=e.data;if(d.type==='error'){content.textContent=d.message;return}if(d.type!=='snapshot')return;const s=d.snapshot,a=s.appearance;nextRefreshAt=s.nextRefreshAt;['refreshIntervalSeconds','warningThreshold','criticalThreshold','belowFullColor','warningColor','criticalColor'].forEach(id=>document.getElementById(id).value=a[id]);updated.dataset.updated='Updated '+s.scannedAt;updated.textContent=updated.dataset.updated+' · Update in: '+Math.ceil((nextRefreshAt-Date.now())/1000)+'s';const t=s.prompts.reduce((x,p)=>({input:x.input+p.inputTokens,output:x.output+p.outputTokens,cached:x.cached+p.cachedTokens,cost:x.cost+p.cost}),{input:0,output:0,cached:0,cost:0}),days=buckets(s.prompts);content.innerHTML='<div class="summary"><div class="quota spend"><span class="muted">Total Spend</span><strong>'+money(t.cost)+'</strong></div><div class="quota"><span>Input Tokens</span><strong>'+fmt(t.input)+'</strong></div><div class="quota"><span>Output Tokens</span><strong>'+fmt(t.output)+'</strong></div><div class="quota"><span>Cached Tokens</span><strong>'+fmt(t.cached)+'</strong></div><div class="quota"><span>Requests</span><strong>'+fmt(s.prompts.length)+'</strong></div></div><div class="charts"><section class="panel"><h2>Spend over time</h2>'+chart(days,['cost'],['var(--vscode-charts-blue)'])+'</section><section class="panel"><h2>Tokens over time</h2><div class="legend">In '+fmt(t.input)+' · Out '+fmt(t.output)+' · Cached '+fmt(t.cached)+'</div>'+chart(days,['input','output','cached'],['var(--vscode-charts-blue)','var(--vscode-charts-purple)','var(--vscode-charts-green)'])+'</section></div><section class="panel table-panel"><div class="table-heading"><h2>Prompt Usage</h2><span class="muted">Costs estimated</span></div><table><thead><tr><th>Prompt</th><th class="num">Input Tokens</th><th class="num">Output Tokens</th><th class="num">Cached Tokens</th><th class="num">Cost</th></tr></thead><tbody>'+s.prompts.map(p=>'<tr><td class="prompt-cell"><div class="prompt-line"><span class="prompt-text">'+esc(p.text)+'</span><button class="expand" data-expand>Expand</button></div><div class="prompt-full" hidden>'+esc(p.text)+'</div></td><td class="num">'+fmt(p.inputTokens)+'</td><td class="num">'+fmt(p.outputTokens)+'</td><td class="num">'+fmt(p.cachedTokens)+'</td><td class="num">'+money(p.cost)+'</td></tr>').join('')+'</tbody></table></section>'};</script></body></html>`;
}
