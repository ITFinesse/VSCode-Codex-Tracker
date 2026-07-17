import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { professionalPanelHtml } from "./dashboard";
import { checkLeaderboardName, readLeaderboardSettings, saveLeaderboardSettings, submitLeaderboardUsage } from "./leaderboard";
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
const sessionFileCache = new Map<string, { size: number; modified: number; prompts: PromptRecord[] }>();
let rateLimitsCache:
  { expiresAt: number; value: { fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined } | undefined;
let rateLimitsInFlight: Promise<{ fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined> | undefined;
const RATE_LIMIT_CACHE_MS = 15_000;
const DIRECTORY_SCAN_CONCURRENCY = 8;

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
  output.info("Extension activated.");
  output.info(`Performance: activation completed in ${(performance.now() - activationStartedAt).toFixed(1)}ms.`);
  // Right-aligned status items are ordered by priority; keep the 5H segment first.
  statusBarFiveHour = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10_000);
  statusBarWeekly = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9_999);
  statusBarFiveHour.command = "codexUsage.showPanel";
  statusBarWeekly.command = "codexUsage.showPanel";
  context.subscriptions.push(statusBarFiveHour, statusBarWeekly);

  let refreshInFlight = false;
  let refreshQueued = false;
  let initialRefreshScheduled = false;
  const refresh = async (): Promise<void> => {
    if (refreshInFlight) {
      if (!refreshQueued) {
        refreshQueued = true;
        output.info("Refresh requested while one is running; one follow-up refresh queued.");
      }
      return;
    }
    refreshInFlight = true;
    {
      refreshQueued = false;
      output.info("Refresh started.");
      try {
        const snapshot = await collectUsage();
        snapshotCache = snapshot;
        nextRefreshAt = Date.now() + readAppearanceSettings().refreshIntervalSeconds * 1_000;
        updateStatusBar(snapshot);
        void submitLeaderboardUsage(context, snapshot.prompts, output).then(async (position) => { if (!position || !snapshotCache) return; leaderboardForWebview = await readLeaderboardSettings(context); postSnapshot(snapshotCache); });
        if (webviewReady) {
          postSnapshot(snapshotCache);
        } else {
          output.info("Webview not ready; cached snapshot will be sent after readiness confirmation.");
        }
        output.info(`Usage refreshed from ${snapshot.usageSource}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not read Codex usage";
        output.error(`Refresh failed: ${message}`);
        if (error instanceof Error && error.stack) {
          output.error(error.stack);
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
    setTimeout(() => void refresh(), 2_000);
  };

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view): void {
      panel = view;
      webviewReady = false;
      output.info("Webview provider resolved.");
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "resources")] };
      const chartScriptUri = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "resources", "chart.umd.js")).toString();
      view.webview.html = professionalPanelHtml(chartScriptUri, view.webview.cspSource, randomBytes(16).toString("base64"));
      output.info("Webview HTML assigned; scripts enabled.");
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
            output.info("Webview: ready message received.");
            displayLocale = typeof message.locale === "string" && message.locale ? message.locale : displayLocale;
            displayTimeZone = typeof message.timeZone === "string" && message.timeZone ? message.timeZone : displayTimeZone;
            webviewReady = true;
            if (snapshotCache) {
              updateStatusBar(snapshotCache);
              postSnapshot(snapshotCache);
            } else {
              scheduleInitialRefresh();
            }
          } else if (message.command === "saveAppearance") {
            void saveAppearanceSettings(message.appearance).then(refresh, () => undefined);
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
            output.error(`Dashboard webview error: ${error}`);
            view.webview.postMessage({ type: "error", message: `Dashboard script error: ${error}` });
          }
        },
        undefined,
        context.subscriptions
      );
      output.info("Webview message listener registered.");
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

  scheduleInitialRefresh();
  let refreshTimer: NodeJS.Timeout | undefined;
  const resetTimer = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    const seconds = vscode.workspace.getConfiguration("codexUsage").get<number>("refreshIntervalSeconds", 60);
    const delay = Math.max(10, seconds) * 1_000;
    nextRefreshAt = Date.now() + delay;
    refreshTimer = setTimeout(async () => {
      await refresh();
      resetTimer();
    }, delay);
  };
  resetTimer();
  context.subscriptions.push({ dispose: () => refreshTimer && clearTimeout(refreshTimer) });
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("codexUsage.refreshIntervalSeconds")) {
        resetTimer();
      }
      if (event.affectsConfiguration("codexUsage")) {
        void refresh();
      }
    })
  );
}

export function deactivate(): void {}

async function collectUsage(): Promise<UsageSnapshot> {
  const collectionStartedAt = performance.now();
  output.info("Collect: reading configuration.");
  const configuration = vscode.workspace.getConfiguration("codexUsage");
  const configuredPath = configuration.get<string>("sessionsPath", "").trim();
  const sessionPath = configuredPath || path.join(os.homedir(), ".codex", "sessions");
  const limit = configuration.get<number>("historyLimit", 100);
  const liveLimitsPromise = readLiveRateLimits();
  const scanStartedAt = performance.now();
  const files = await newestJsonlFiles(sessionPath, limit).catch(() => []);
  output.info(`Performance: session scan completed in ${(performance.now() - scanStartedAt).toFixed(1)}ms.`);
  output.info(`Collect: found ${files.length} session file(s) at ${sessionPath}.`);
  const prompts: PromptRecord[] = [];

  const parseStartedAt = performance.now();
  for (const file of files) {
    try {
      prompts.push(...(await readSession(file)));
    } catch (error) {
      output.warn(`Collect: failed reading ${file}: ${String(error)}`);
    }
  }
  output.info(`Performance: session parsing completed in ${(performance.now() - parseStartedAt).toFixed(1)}ms.`);
  const liveLimits = await liveLimitsPromise;
  output.info(`Collect: live limits ${liveLimits ? "received" : "unavailable"}; ${prompts.length} prompt(s) parsed.`);
  const usageSource = liveLimits ? "codex app-server" : "unavailable";
  output.info(`Performance: collection completed in ${(performance.now() - collectionStartedAt).toFixed(1)}ms.`);
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

async function readLiveRateLimits(): Promise<{ fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined> {
  if (rateLimitsCache && rateLimitsCache.expiresAt > Date.now()) {
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
  output.info("Limits: requesting Codex app-server rate limits.");
  const result = await readAppServerResult().catch((error) => {
    output.warn(`Limits: app-server request failed: ${String(error)}`);
    return undefined;
  });
  return parseRateLimitResponse(result);
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

async function readAppServerResult(): Promise<unknown> {
  const requestStartedAt = performance.now();
  const command = await resolveCodexCommand();
  output.info(`App-server: starting ${command}.`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    child.stderr.on("data", (chunk) => output.warn(`App-server stderr: ${String(chunk).trim()}`));
    output.info("App-server: process started.");
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
      () => finish(() => reject(new Error("Codex app-server rate-limit request timed out after 8 seconds"))),
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
          output.info(`Performance: app-server response completed in ${(performance.now() - requestStartedAt).toFixed(1)}ms.`);
          resolve(message.result);
        });
      } catch {
        // Ignore non-JSON stdout lines from the CLI.
      }
    });
    const send = (payload: JsonObject): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "VSCode Codex Tracker", version: "0.0.1" }, capabilities: { experimentalApi: true } }
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
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
  return candidates
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)
    .map((candidate) => candidate.file);
}

async function readSession(file: string): Promise<PromptRecord[]> {
  const stat = await fs.stat(file);
  const cached = sessionFileCache.get(file);
  if (cached && cached.size === stat.size && cached.modified === stat.mtimeMs) {
    return cached.prompts;
  }
  const prompts = parseSessionText(await fs.readFile(file, "utf8"), path.basename(file, ".jsonl"));
  sessionFileCache.set(file, { size: stat.size, modified: stat.mtimeMs, prompts });
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
function estimateCost(prompt: PromptRecord): number {
  // Conservative, model-agnostic estimate shown as an estimate in the dashboard.
  return ((prompt.inputTokens ?? 0) * 1.25 + (prompt.cachedTokens ?? 0) * 0.125 + (prompt.outputTokens ?? 0) * 10) / 1_000_000;
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
    output.warn("Webview: snapshot not sent because panel is unavailable.");
    return;
  }
  output.info(`Webview: sending snapshot with ${snapshot.prompts.length} prompt(s).`);
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
        scannedAt: formatDateTime(snapshot.scannedAt),
        nextRefreshAt,
        metadata: { version: extensionVersion, buildTime: extensionBuildTime, lastUpdate: formatClock(snapshot.scannedAt) }
      }
    })
    .then(
      (delivered) =>
        output.info(
          `Webview: snapshot delivery ${delivered ? "accepted" : "rejected"}; render handoff ${(performance.now() - renderStartedAt).toFixed(1)}ms.`
        ),
      (error) => output.error(`Webview: snapshot delivery failed: ${String(error)}`)
    );
}

function formatPercent(window: LimitWindow): string {
  return window.remainingPercent === undefined ? "N/A" : `${Math.round(window.remainingPercent).toString().padStart(2, "0")}%`;
}
function formatReset(window: LimitWindow): string {
  return window.resetAt ? formatDateTime(window.resetAt) : "--";
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
  theme: "dark" | "light";
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
    theme: configuration.get<"dark" | "light">("theme", "dark") === "light" ? "light" : "dark"
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
    configuration.update("theme", appearance.theme, vscode.ConfigurationTarget.Global)
  ]);
}
function enhancedPanelHtml(): string {
  return String.raw`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;margin:0}.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.title{font-size:28px}.actions{display:flex;gap:12px;align-items:center}.muted{color:var(--vscode-descriptionForeground)}button{font:inherit;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:5px 9px}.summary,.charts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}.quota,.panel{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:7px;padding:14px}.quota strong{display:block;font-size:24px;margin:5px 0}.spend{grid-column:span 2}.charts{grid-template-columns:1fr 2fr}.chart{width:100%;height:170px}.legend{font-size:12px;margin-bottom:7px}.settings{margin-bottom:14px;padding:14px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-editorWidget-border);border-radius:7px}.settings[hidden]{display:none}.setting-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.settings label{display:grid;gap:4px;color:var(--vscode-descriptionForeground)}input{font:inherit;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px}.settings input[type=color]{height:28px;padding:1px}.table-panel{padding:0;overflow:auto}.table-heading{display:flex;justify-content:space-between;padding:14px;border-bottom:1px solid var(--vscode-panel-border)}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border)}.num{text-align:right}.prompt-cell{max-width:0}.prompt-line{display:flex;gap:8px}.prompt-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.expand{color:var(--vscode-textLink-foreground);padding:0;border:0;background:none}.prompt-full{white-space:pre-wrap;margin-top:8px}@media(max-width:700px){.summary,.charts{grid-template-columns:1fr 1fr}}@media(max-width:500px){.summary,.charts{grid-template-columns:1fr}}</style></head><body><div class="toolbar"><div class="title">Usage</div><div class="actions"><span id="updated" class="muted">Loading…</span><button id="settingsToggle">⚙</button></div></div><section id="settings" class="settings" hidden><form id="settingsForm"><div class="setting-grid"><label>Refresh seconds<input id="refreshIntervalSeconds" type="number" min="10" max="3600"></label><label>Warning threshold %<input id="warningThreshold" type="number" min="0" max="100"></label><label>Critical threshold %<input id="criticalThreshold" type="number" min="0" max="100"></label><label>Below 100% colour<input id="belowFullColor" type="color"></label><label>Warning colour<input id="warningColor" type="color"></label><label>Critical colour<input id="criticalColor" type="color"></label></div><button type="submit">Save settings</button></form></section><div id="content">Loading…</div><script>const vscode=acquireVsCodeApi(),content=document.getElementById('content'),settingsToggle=document.getElementById('settingsToggle'),settings=document.getElementById('settings'),settingsForm=document.getElementById('settingsForm'),updated=document.getElementById('updated');let nextRefreshAt=0;setTimeout(()=>vscode.postMessage({command:'ready'}),0);window.onerror=(message)=>vscode.postMessage({command:'webviewError',error:String(message)});const esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),fmt=v=>new Intl.NumberFormat().format(v||0),money=v=>new Intl.NumberFormat(undefined,{style:'currency',currency:'USD',maximumFractionDigits:4}).format(v||0);const chart=(p,keys,colors)=>{const w=600,h=170,m=24,max=Math.max(1,...p.flatMap(x=>keys.map(k=>x[k]||0))),x=i=>m+i*(w-2*m)/Math.max(1,p.length-1),y=v=>h-m-v/max*(h-2*m);return '<svg class="chart" viewBox="0 0 '+w+' '+h+'">'+keys.map((k,n)=>'<polyline fill="none" stroke="'+colors[n]+'" stroke-width="2" points="'+p.map((v,i)=>x(i)+','+y(v[k]||0)).join(' ')+'"/>').join('')+'</svg>'};const buckets=ps=>{const m=new Map();ps.forEach(p=>{const k=new Date(p.time).toLocaleDateString(undefined,{month:'short',day:'numeric'}),r=m.get(k)||{input:0,output:0,cached:0,cost:0};r.input+=p.inputTokens||0;r.output+=p.outputTokens||0;r.cached+=p.cachedTokens||0;r.cost+=p.cost||0;m.set(k,r)});return [...m.values()].reverse().slice(-7)};settingsToggle.onclick=()=>settings.hidden=!settings.hidden;settingsForm.onsubmit=e=>{e.preventDefault();vscode.postMessage({command:'saveAppearance',appearance:{refreshIntervalSeconds:+refreshIntervalSeconds.value,warningThreshold:+warningThreshold.value,criticalThreshold:+criticalThreshold.value,belowFullColor:belowFullColor.value,warningColor:warningColor.value,criticalColor:criticalColor.value}})};content.onclick=e=>{const b=e.target.closest('[data-expand]');if(b){const f=b.closest('td').querySelector('.prompt-full');f.hidden=!f.hidden;b.textContent=f.hidden?'Expand':'Collapse'}};setInterval(()=>{if(updated.dataset.updated){const s=Math.max(0,Math.ceil((nextRefreshAt-Date.now())/1000));updated.textContent=updated.dataset.updated+' · Update in: '+(s>=60?Math.floor(s/60)+'m '+String(s%60).padStart(2,'0')+'s':s+'s')}},1000);window.onmessage=e=>{const d=e.data;if(d.type==='error'){content.textContent=d.message;return}if(d.type!=='snapshot')return;const s=d.snapshot,a=s.appearance;nextRefreshAt=s.nextRefreshAt;['refreshIntervalSeconds','warningThreshold','criticalThreshold','belowFullColor','warningColor','criticalColor'].forEach(id=>document.getElementById(id).value=a[id]);updated.dataset.updated='Updated '+s.scannedAt;updated.textContent=updated.dataset.updated+' · Update in: '+Math.ceil((nextRefreshAt-Date.now())/1000)+'s';const t=s.prompts.reduce((x,p)=>({input:x.input+p.inputTokens,output:x.output+p.outputTokens,cached:x.cached+p.cachedTokens,cost:x.cost+p.cost}),{input:0,output:0,cached:0,cost:0}),days=buckets(s.prompts);content.innerHTML='<div class="summary"><div class="quota spend"><span class="muted">Total Spend</span><strong>'+money(t.cost)+'</strong></div><div class="quota"><span>Input Tokens</span><strong>'+fmt(t.input)+'</strong></div><div class="quota"><span>Output Tokens</span><strong>'+fmt(t.output)+'</strong></div><div class="quota"><span>Cached Tokens</span><strong>'+fmt(t.cached)+'</strong></div><div class="quota"><span>Requests</span><strong>'+fmt(s.prompts.length)+'</strong></div></div><div class="charts"><section class="panel"><h2>Spend over time</h2>'+chart(days,['cost'],['var(--vscode-charts-blue)'])+'</section><section class="panel"><h2>Tokens over time</h2><div class="legend">In '+fmt(t.input)+' · Out '+fmt(t.output)+' · Cached '+fmt(t.cached)+'</div>'+chart(days,['input','output','cached'],['var(--vscode-charts-blue)','var(--vscode-charts-purple)','var(--vscode-charts-green)'])+'</section></div><section class="panel table-panel"><div class="table-heading"><h2>Prompt Usage</h2><span class="muted">Costs estimated</span></div><table><thead><tr><th>Prompt</th><th class="num">Input Tokens</th><th class="num">Output Tokens</th><th class="num">Cached Tokens</th><th class="num">Cost</th></tr></thead><tbody>'+s.prompts.map(p=>'<tr><td class="prompt-cell"><div class="prompt-line"><span class="prompt-text">'+esc(p.text)+'</span><button class="expand" data-expand>Expand</button></div><div class="prompt-full" hidden>'+esc(p.text)+'</div></td><td class="num">'+fmt(p.inputTokens)+'</td><td class="num">'+fmt(p.outputTokens)+'</td><td class="num">'+fmt(p.cachedTokens)+'</td><td class="num">'+money(p.cost)+'</td></tr>').join('')+'</tbody></table></section>'};</script></body></html>`;
}
