import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export interface LeaderboardSettings { enabled: boolean; name: string; code: string; position?: number; }
interface UsageLedger { total: number; estimatedSpend: number; promptCount: number; prompts: Record<string, { input: number; spend: number }>; }
interface PromptUsage { session: string; timestamp: Date; inputTokens?: number; estimatedCost?: number; }
export interface LeaderboardLogger { info(message: string): void; warn(message: string): void; }
const CODE_KEY = "leaderboard.code";
const DEVICE_KEY = "leaderboard.deviceId";
const LEDGER_KEY = "leaderboard.usageLedger.v2";
const LAST_SENT_KEY = "leaderboard.lastSentTotal";
const LAST_SENT_AT_KEY = "leaderboard.lastSentAt";
const ANONYMOUS_NAME_KEY = "leaderboard.anonymousName";
const LEADERBOARD_ENDPOINT = "https://vscodecodextracker.itfinesse.co.uk/api.php";
const LEADERBOARD_MIN_SUBMIT_MS = 60_000;

export async function readLeaderboardSettings(context: vscode.ExtensionContext): Promise<LeaderboardSettings> {
  const config = vscode.workspace.getConfiguration("codexUsage");
  let code = await context.secrets.get(CODE_KEY);
  if (!code) { code = randomBytes(24).toString("base64url"); await context.secrets.store(CODE_KEY, code); }
  const configuredName = config.get<string>("leaderboardName", "");
  const name = configuredName.trim() && configuredName.trim() !== "Anonymous" ? normalizeName(configuredName) : await anonymousName(context);
  return { enabled: config.get<boolean>("leaderboardEnabled", true), name, code, position: context.globalState.get<number>("leaderboard.position") };
}

export async function saveLeaderboardSettings(context: vscode.ExtensionContext, value: unknown): Promise<void> {
  if (!isObject(value)) throw new Error("Invalid leaderboard settings.");
  const config = vscode.workspace.getConfiguration("codexUsage");
  const code = typeof value.code === "string" && value.code.trim() ? value.code.trim() : await context.secrets.get(CODE_KEY);
  if (!code || code.length < 16 || code.length > 128) throw new Error("Your leaderboard code must be between 16 and 128 characters.");
  await Promise.all([
    config.update("leaderboardEnabled", value.enabled === true, vscode.ConfigurationTarget.Global),
    config.update("leaderboardName", normalizeName(value.name), vscode.ConfigurationTarget.Global),
    context.secrets.store(CODE_KEY, code)
  ]);
}

export async function checkLeaderboardName(context: vscode.ExtensionContext, value: unknown): Promise<{ available: boolean; message: string }> {
  if (!isObject(value)) throw new Error("Invalid name check.");
  const settings = await readLeaderboardSettings(context);
  const name = normalizeName(value.name);
  const code = typeof value.code === "string" && value.code.trim() ? validCheckCode(value.code) : settings.code;
  const response = await request(LEADERBOARD_ENDPOINT, { action: "check_name", name, code });
  return { available: response.available === true, message: String(response.message ?? "Name check failed.") };
}

export async function submitLeaderboardUsage(context: vscode.ExtensionContext, prompts: PromptUsage[], log: LeaderboardLogger): Promise<number | undefined> {
  const ledger = updateLedger(context, prompts);
  const settings = await readLeaderboardSettings(context);
  const lastTotal = context.globalState.get<number>(LAST_SENT_KEY, 0);
  const lastPromptCount = context.globalState.get<number>("leaderboard.lastSentPromptCount", 0);
  const lastSentAt = context.globalState.get<number>(LAST_SENT_AT_KEY, 0);
  if (!settings.enabled || ledger.total < 1_000 || (ledger.total <= lastTotal && ledger.promptCount <= lastPromptCount) || Date.now() - lastSentAt < LEADERBOARD_MIN_SUBMIT_MS) return undefined;
  let deviceId = context.globalState.get<string>(DEVICE_KEY);
  if (!deviceId) { deviceId = randomBytes(18).toString("base64url"); await context.globalState.update(DEVICE_KEY, deviceId); }
  try {
    const response = await request(LEADERBOARD_ENDPOINT, { action: "submit", name: settings.name, code: settings.code, device_id: deviceId, input_tokens_total: ledger.total, prompt_count_total: ledger.promptCount, estimated_spend_total: Number(ledger.estimatedSpend.toFixed(6)) });
    if (response.ok !== true) throw new Error(String(response.message ?? "Leaderboard rejected the submission."));
    const position = Number(response.position ?? response.rank);
    if (Number.isInteger(position) && position > 0) await context.globalState.update("leaderboard.position", position);
    await Promise.all([context.globalState.update(LAST_SENT_KEY, ledger.total), context.globalState.update("leaderboard.lastSentPromptCount", ledger.promptCount), context.globalState.update(LAST_SENT_AT_KEY, Date.now())]);
    log.info(`Leaderboard: submitted ${ledger.total.toLocaleString()} input tokens and $${ledger.estimatedSpend.toFixed(2)} estimated API-equivalent spend.`);
    return Number.isInteger(position) && position > 0 ? position : undefined;
  } catch (error) { log.warn(`Leaderboard: submission failed; it will retry after the next token increase. ${error instanceof Error ? error.message : String(error)}`); }
}

function updateLedger(context: vscode.ExtensionContext, prompts: PromptUsage[]): UsageLedger {
  const stored = context.globalState.get<UsageLedger>(LEDGER_KEY);
  const ledger: UsageLedger = stored && isObject(stored.prompts) && Number.isFinite(stored.total) ? { total: stored.total, estimatedSpend: Number.isFinite(stored.estimatedSpend) ? stored.estimatedSpend : 0, promptCount: Number.isFinite(stored.promptCount) ? stored.promptCount : Object.keys(stored.prompts).length, prompts: stored.prompts } : { total: 0, estimatedSpend: 0, promptCount: 0, prompts: {} };
  let changed = false;
  for (const prompt of prompts) {
    const input = Math.max(0, Math.floor(prompt.inputTokens ?? 0));
    const spend = Math.max(0, Number(prompt.estimatedCost ?? 0));
    const key = `${prompt.session}|${prompt.timestamp.getTime()}`;
    const previous = ledger.prompts[key] ?? { input: 0, spend: 0 };
    if (!(key in ledger.prompts)) { ledger.promptCount += 1; changed = true; }
    if (input > previous.input) { ledger.total += input - previous.input; previous.input = input; changed = true; }
    if (spend > previous.spend) { ledger.estimatedSpend += spend - previous.spend; previous.spend = spend; changed = true; }
    ledger.prompts[key] = previous;
  }
  if (changed) void context.globalState.update(LEDGER_KEY, ledger);
  return ledger;
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "Anonymous";
  if (name.length < 1 || name.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name)) throw new Error("Leaderboard names must be 1–32 letters, numbers, spaces, dots, hyphens, or underscores.");
  return name;
}
async function anonymousName(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>(ANONYMOUS_NAME_KEY);
  if (existing && /^Anonymous \d{6}$/.test(existing)) return existing;
  const suffix = 100_000 + (randomBytes(4).readUInt32BE(0) % 900_000);
  const name = `Anonymous ${suffix}`;
  await context.globalState.update(ANONYMOUS_NAME_KEY, name);
  return name;
}
function validCheckCode(value: string): string { const code=value.trim(); if(code.length<16||code.length>128) throw new Error("Your leaderboard code must be between 16 and 128 characters."); return code; }
async function request(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
    const data: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isObject(data)) throw new Error(isObject(data) ? String(data.message ?? `HTTP ${response.status}`) : `HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timeout); }
}
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
