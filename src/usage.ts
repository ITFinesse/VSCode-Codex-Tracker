export type JsonObject = Record<string, unknown>;

export interface LimitWindow {
  remainingPercent?: number;
  resetAt?: Date;
  windowDurationMins?: number;
}

export interface PromptRecord {
  timestamp: Date;
  text: string;
  model?: string;
  session: string;
  sessionTitle?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

export interface AccountSummary {
  plan?: string;
  credits?: string;
  renewalDate?: Date;
}

export interface AppearanceSettings {
  warningThreshold: number;
  criticalThreshold: number;
  warningColor: string;
  criticalColor: string;
  belowFullColor: string;
  refreshIntervalSeconds: number;
  theme: "dark" | "light";
}

export interface ChartTotals {
  input: number;
  output: number;
  cached: number;
  cost: number;
  requests: number;
}

export function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function dateFrom(value: unknown): Date | undefined {
  const date =
    typeof value === "string"
      ? new Date(value)
      : typeof value === "number"
        ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
        : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function messageText(message: JsonObject): string | undefined {
  const content = Array.isArray(message.content) ? message.content : [];
  return (
    content
      .map(object)
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

export function parseSessionText(text: string, session: string): PromptRecord[] {
  const prompts: PromptRecord[] = [];
  let sessionTitle: string | undefined;
  let currentPrompt: PromptRecord | undefined;
  let currentModel: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let event: JsonObject;
    try {
      event = JSON.parse(line) as JsonObject;
    } catch {
      continue;
    }
    const timestamp = dateFrom(event.timestamp);
    const payload = object(event.payload);
    if (event.type === "turn_context" && typeof payload?.model === "string") currentModel = payload.model;
    const message = object(payload?.type === "message" ? payload : undefined);
    if (message?.role === "user") {
      const prompt = messageText(message);
      if (prompt && timestamp && !isSessionMetadata(prompt)) {
        sessionTitle ??= taskTitle(prompt);
        currentPrompt = { timestamp, text: prompt, model: currentModel, session, sessionTitle };
        prompts.push(currentPrompt);
      }
    }
    const info = object(payload?.type === "token_count" ? payload.info : undefined);
    const usage = currentPrompt && info && (object(info.last_token_usage) ?? object(info.total_token_usage));
    if (currentPrompt && usage) {
      currentPrompt.inputTokens = (currentPrompt.inputTokens ?? 0) + (number(usage.input_tokens) ?? 0);
      currentPrompt.outputTokens =
        (currentPrompt.outputTokens ?? 0) + (number(usage.output_tokens) ?? 0) + (number(usage.reasoning_output_tokens) ?? 0);
      currentPrompt.cachedTokens = (currentPrompt.cachedTokens ?? 0) + (number(usage.cached_input_tokens) ?? 0);
    }
  }
  return prompts.map((prompt) => ({ ...prompt, sessionTitle: sessionTitle ?? prompt.sessionTitle }));
}

function firstObject(source: JsonObject, keys: string[]): JsonObject | undefined {
  for (const key of keys) {
    const candidate = object(source[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function rateLimitSources(root: JsonObject): JsonObject[] {
  const sources: JsonObject[] = [root];
  const add = (value: unknown): void => {
    const candidate = object(value);
    if (candidate && !sources.includes(candidate)) sources.push(candidate);
  };
  add(root.rateLimits);
  add(root.rate_limits);
  for (const collection of [object(root.rateLimitsByLimitId), object(root.rate_limits_by_limit_id)]) {
    if (!collection) continue;
    add(collection);
    Object.values(collection).forEach(add);
  }
  for (const source of [...sources]) Object.values(source).forEach(add);
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

function toLimitWindow(value: JsonObject | undefined): LimitWindow | undefined {
  if (!value) return undefined;
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
  return usedPercent === undefined && remainingPercent === undefined
    ? undefined
    : { remainingPercent: Math.max(0, Math.min(100, remainingPercent ?? 100 - (usedPercent ?? 0))), resetAt, windowDurationMins };
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
  const account = {
    plan: readText(["plan", "plan_name", "planName", "subscription_plan", "subscriptionPlan"]),
    credits: readText(["credits", "credit_balance", "creditBalance", "balance"]),
    renewalDate: renewal
  };
  return account.plan || account.credits || account.renewalDate ? account : undefined;
}

export function parseRateLimitResponse(
  value: unknown
): { fiveHour: LimitWindow; weekly: LimitWindow; account?: AccountSummary } | undefined {
  const root = object(value);
  if (!root) return undefined;
  const sources = rateLimitSources(root);
  const primary = toLimitWindow(findLimitWindow(sources, ["primary", "primary_window", "primaryWindow", "five_hour", "fiveHour"]));
  const secondary = toLimitWindow(
    findLimitWindow(sources, ["secondary", "secondary_window", "secondaryWindow", "weekly", "weekly_window", "weeklyWindow"])
  );
  const primaryIsWeekly = (primary?.windowDurationMins ?? 0) >= 24 * 60;
  const fiveHour = primary && !primaryIsWeekly ? primary : undefined;
  const weekly = secondary ?? (primaryIsWeekly ? primary : undefined);
  return fiveHour || weekly
    ? { fiveHour: fiveHour ?? {}, weekly: weekly ?? {}, account: readAccountSummary(root, sources[1] ?? root) }
    : undefined;
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const appearance = object(value) ?? {};
  const clamp = (numberValue: number): number => Math.max(0, Math.min(100, numberValue));
  const color = (candidate: unknown, fallback: string): string =>
    typeof candidate === "string" && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
  const warningThreshold = clamp(number(appearance.warningThreshold) ?? 40);
  return {
    warningThreshold,
    criticalThreshold: Math.min(clamp(number(appearance.criticalThreshold) ?? 30), warningThreshold),
    warningColor: color(appearance.warningColor, "#d97706"),
    criticalColor: color(appearance.criticalColor, "#dc2626"),
    belowFullColor: color(appearance.belowFullColor, "#cccccc"),
    refreshIntervalSeconds: Math.max(10, Math.min(3600, number(appearance.refreshIntervalSeconds) ?? 60)),
    theme: appearance.theme === "light" ? "light" : "dark"
  };
}

export function aggregateChartData(prompts: Array<PromptRecord & { cost?: number }>): ChartTotals {
  return prompts.reduce<ChartTotals>(
    (totals, prompt) => ({
      input: totals.input + (prompt.inputTokens ?? 0),
      output: totals.output + (prompt.outputTokens ?? 0),
      cached: totals.cached + (prompt.cachedTokens ?? 0),
      cost: totals.cost + (prompt.cost ?? 0),
      requests: totals.requests + 1
    }),
    { input: 0, output: 0, cached: 0, cost: 0, requests: 0 }
  );
}
