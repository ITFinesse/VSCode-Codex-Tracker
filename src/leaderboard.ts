import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export interface LeaderboardSettings { enabled: boolean; name: string; code: string; position?: number; }
interface UsageLedger { total: number; estimatedSpend: number; promptCount: number; prompts: Record<string, { input: number; spend: number }>; }
interface LegacyInputLedger { total: number; promptCount: number; prompts: Record<string, number>; }
interface PromptUsage { session: string; timestamp: Date; inputTokens?: number; estimatedCost?: number; }
export interface LeaderboardLogger { info(message: string): void; warn(message: string): void; }
export interface LedgerValidation { valid: boolean; checkedAt: Date; matchedPrompts: number; missingPrompts: number; mismatchedPrompts: number; ledgerTokens: number; historyTokens: number; }
const CODE_KEY = "leaderboard.code";
const DEVICE_KEY = "leaderboard.deviceId";
const LEDGER_KEY = "leaderboard.usageLedger.v2";
const LEGACY_LEDGER_KEY = "leaderboard.inputLedger.v1";
const LAST_SENT_KEY = "leaderboard.lastSentTotal";
const LAST_SENT_AT_KEY = "leaderboard.lastSentAt";
const LEGACY_MIGRATION_SUBMITTED_KEY = "leaderboard.legacyMigrationSubmitted";
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
  const hasLegacyLedger = Boolean(context.globalState.get<LegacyInputLedger>(LEGACY_LEDGER_KEY));
  const updated = await updateLedger(context, prompts);
  const ledger = updated.ledger;
  const settings = await readLeaderboardSettings(context);
  const lastTotal = context.globalState.get<number>(LAST_SENT_KEY, 0);
  const lastPromptCount = context.globalState.get<number>("leaderboard.lastSentPromptCount", 0);
  const lastSentAt = context.globalState.get<number>(LAST_SENT_AT_KEY, 0);
  const migrationSyncPending = hasLegacyLedger && context.globalState.get<boolean>(LEGACY_MIGRATION_SUBMITTED_KEY) !== true;
  if (updated.migrated || migrationSyncPending) {
    log.info(
      `Ledger | source=leaderboard.inputLedger.v1 | task=migration | action=start | v2Tokens=${ledger.total}; prompts=${ledger.promptCount}.`
    );
  }
  const unchanged = ledger.total <= lastTotal && ledger.promptCount <= lastPromptCount;
  const skipReason = !settings.enabled ? "disabled" : ledger.total < 1_000 ? "below-1,000-token minimum" : !migrationSyncPending && unchanged ? "token and prompt totals unchanged" : !migrationSyncPending && Date.now() - lastSentAt < LEADERBOARD_MIN_SUBMIT_MS ? "submission throttle active" : undefined;
  if (skipReason) {
    log.info(`Leaderboard | source=usage-ledger | task=submission | action=skip | reason=${skipReason}; tokens=${ledger.total}; prompts=${ledger.promptCount}; estimatedSpend=$${ledger.estimatedSpend.toFixed(6)}.`);
    return undefined;
  }
  let deviceId = context.globalState.get<string>(DEVICE_KEY);
  if (!deviceId) { deviceId = randomBytes(18).toString("base64url"); await context.globalState.update(DEVICE_KEY, deviceId); }
  try {
    log.info(`Leaderboard | source=usage-ledger | task=submission | action=start | reason=${migrationSyncPending ? "legacy-migration-sync" : "usage-increase"}; tokens=${ledger.total}; prompts=${ledger.promptCount}.`);
    const response = await request(LEADERBOARD_ENDPOINT, { action: "submit", name: settings.name, code: settings.code, device_id: deviceId, input_tokens_total: ledger.total, prompt_count_total: ledger.promptCount, estimated_spend_total: Number(ledger.estimatedSpend.toFixed(6)) });
    if (response.ok !== true) throw new Error(String(response.message ?? "Leaderboard rejected the submission."));
    const position = Number(response.position ?? response.rank);
    if (Number.isInteger(position) && position > 0) await context.globalState.update("leaderboard.position", position);
    await Promise.all([context.globalState.update(LAST_SENT_KEY, ledger.total), context.globalState.update("leaderboard.lastSentPromptCount", ledger.promptCount), context.globalState.update(LAST_SENT_AT_KEY, Date.now()), ...(migrationSyncPending ? [context.globalState.update(LEGACY_MIGRATION_SUBMITTED_KEY, true)] : [])]);
    log.info(`Leaderboard | source=usage-ledger | task=submission | action=complete | result=success; tokens=${ledger.total.toLocaleString()}; prompts=${ledger.promptCount}; estimatedSpend=$${ledger.estimatedSpend.toFixed(2)}; position=${Number.isInteger(position) && position > 0 ? position : "unavailable"}.`);
    if (migrationSyncPending) {
      log.info(`Ledger | source=leaderboard.inputLedger.v1 | task=migration | action=complete | result=submitted; tokens=${ledger.total}; prompts=${ledger.promptCount}.`);
    }
    return Number.isInteger(position) && position > 0 ? position : undefined;
  } catch (error) { log.warn(`Leaderboard | source=usage-ledger | task=submission | action=complete | result=failed; retry=next-token-increase; reason=${error instanceof Error ? error.message : String(error)}.`); }
}

function readUsageLedger(context: vscode.ExtensionContext): { ledger: UsageLedger; migrated: boolean } {
  const stored = context.globalState.get<UsageLedger>(LEDGER_KEY);
  const legacy = context.globalState.get<LegacyInputLedger>(LEGACY_LEDGER_KEY);
  const storedValid = stored && isObject(stored.prompts) && Number.isFinite(stored.total);
  const legacyValid = legacy && isObject(legacy.prompts) && Number.isFinite(legacy.total);
  if (storedValid) {
    const ledger: UsageLedger = {
      total: stored.total,
      estimatedSpend: Number.isFinite(stored.estimatedSpend) ? stored.estimatedSpend : 0,
      promptCount: Number.isFinite(stored.promptCount) ? stored.promptCount : Object.keys(stored.prompts).length,
      prompts: stored.prompts
    };
    let migrated = false;
    if (legacyValid) {
      for (const [key, input] of Object.entries(legacy.prompts)) {
        const legacyInput = Math.max(0, Math.floor(Number(input) || 0));
        const current = ledger.prompts[key];
        if (!current || legacyInput > current.input) {
          ledger.prompts[key] = { input: legacyInput, spend: current?.spend ?? 0 };
          migrated = true;
        }
      }
      if (legacy.total > ledger.total) {
        ledger.total = Math.floor(legacy.total);
        migrated = true;
      }
      const legacyPromptCount = Number.isFinite(legacy.promptCount) ? Math.floor(legacy.promptCount) : Object.keys(legacy.prompts).length;
      if (legacyPromptCount > ledger.promptCount) {
        ledger.promptCount = legacyPromptCount;
        migrated = true;
      }
    }
    return { ledger, migrated };
  }
  if (legacyValid) {
    const prompts: UsageLedger["prompts"] = {};
    for (const [key, input] of Object.entries(legacy.prompts)) {
      prompts[key] = { input: Math.max(0, Math.floor(Number(input) || 0)), spend: 0 };
    }
    return {
      ledger: {
        total: Math.max(0, Math.floor(legacy.total)),
        estimatedSpend: 0,
        promptCount: Number.isFinite(legacy.promptCount) ? Math.max(0, Math.floor(legacy.promptCount)) : Object.keys(prompts).length,
        prompts
      },
      migrated: true
    };
  }
  return { ledger: { total: 0, estimatedSpend: 0, promptCount: 0, prompts: {} }, migrated: false };
}

async function updateLedger(context: vscode.ExtensionContext, prompts: PromptUsage[]): Promise<{ ledger: UsageLedger; migrated: boolean }> {
  const loaded = readUsageLedger(context);
  const ledger = loaded.ledger;
  let changed = loaded.migrated;
  const lastSentTotal = context.globalState.get<number>(LAST_SENT_KEY, 0);
  const lastSentPromptCount = context.globalState.get<number>("leaderboard.lastSentPromptCount", 0);
  if (lastSentTotal > ledger.total) {
    ledger.total = lastSentTotal;
    changed = true;
  }
  if (lastSentPromptCount > ledger.promptCount) {
    ledger.promptCount = lastSentPromptCount;
    changed = true;
  }
  for (const prompt of prompts) {
    const input = Math.max(0, Math.floor(prompt.inputTokens ?? 0));
    const spend = Math.max(0, Number(prompt.estimatedCost ?? 0));
    const key = promptKey(prompt);
    const previous = ledger.prompts[key];
    if (!previous) {
      ledger.prompts[key] = { input, spend };
      ledger.promptCount += 1;
      ledger.total += input;
      ledger.estimatedSpend += spend;
      changed = true;
      continue;
    }
    if (input > previous.input) {
      ledger.total += input - previous.input;
      previous.input = input;
      changed = true;
    }
    if (spend > previous.spend) {
      ledger.estimatedSpend += spend - previous.spend;
      previous.spend = spend;
      changed = true;
    }
  }
  if (changed) await context.globalState.update(LEDGER_KEY, ledger);
  return { ledger, migrated: loaded.migrated };
}
export async function validateLedgerHistory(context: vscode.ExtensionContext, prompts: PromptUsage[]): Promise<LedgerValidation> {
  const { ledger } = await updateLedger(context, prompts);
  const history = new Map<string, number>();
  for (const prompt of prompts) {
    const key = promptKey(prompt);
    const input = Math.max(0, Math.floor(prompt.inputTokens ?? 0));
    history.set(key, Math.max(history.get(key) ?? 0, input));
  }
  let matchedPrompts = 0;
  let missingPrompts = 0;
  let mismatchedPrompts = 0;
  let historyTokens = 0;
  for (const [key, value] of Object.entries(ledger.prompts)) {
    const input = history.get(key);
    if (input === undefined) {
      missingPrompts += 1;
      continue;
    }
    matchedPrompts += 1;
    historyTokens += input;
    if (!Number.isFinite(value.input) || input > value.input) mismatchedPrompts += 1;
  }
  return {
    valid: missingPrompts === 0 && mismatchedPrompts === 0,
    checkedAt: new Date(),
    matchedPrompts,
    missingPrompts,
    mismatchedPrompts,
    ledgerTokens: ledger.total,
    historyTokens
  };
}

function promptKey(prompt: PromptUsage): string {
  return prompt.session + "|" + prompt.timestamp.getTime();
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
