"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.object = object;
exports.number = number;
exports.dateFrom = dateFrom;
exports.parseSessionText = parseSessionText;
exports.parseRateLimitResponse = parseRateLimitResponse;
exports.normalizeAppearanceSettings = normalizeAppearanceSettings;
exports.aggregateChartData = aggregateChartData;
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function dateFrom(value) {
    const date = typeof value === "string"
        ? new Date(value)
        : typeof value === "number"
            ? new Date(value < 10_000_000_000 ? value * 1_000 : value)
            : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
}
function messageText(message) {
    const content = Array.isArray(message.content) ? message.content : [];
    return (content
        .map(object)
        .filter((item) => Boolean(item))
        .filter((item) => item.type === "input_text" || item.type === "text")
        .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
        .join("\n") || undefined);
}
function isSessionMetadata(text) {
    const normalized = text.trim().toLowerCase();
    return (/^<\s*(agents\.md|instructions|recommended_plugins|environment_context)/.test(normalized) ||
        normalized.startsWith("agents.md instructions") ||
        normalized.startsWith("you are codex") ||
        normalized.startsWith("# agents.md"));
}
function taskTitle(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 96);
}
function parseSessionText(text, session) {
    const prompts = [];
    let sessionTitle;
    let currentPrompt;
    let currentModel;
    let currentReasoningEffort;
    for (const line of text.split(/\r?\n/)) {
        if (!line)
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        const timestamp = dateFrom(event.timestamp);
        const payload = object(event.payload);
        if (event.type === "turn_context") {
            currentModel = typeof payload?.model === "string" ? payload.model : currentModel;
            const reasoning = object(payload?.reasoning) ?? object(payload?.reasoning_effort);
            currentReasoningEffort = typeof payload?.reasoning_effort === "string" ? payload.reasoning_effort : typeof payload?.reasoningEffort === "string" ? payload.reasoningEffort : typeof reasoning?.effort === "string" ? reasoning.effort : currentReasoningEffort;
        }
        const message = object(payload?.type === "message" ? payload : undefined);
        if (message?.role === "user") {
            const prompt = messageText(message);
            if (prompt && timestamp && !isSessionMetadata(prompt)) {
                sessionTitle ??= taskTitle(prompt);
                currentPrompt = { timestamp, text: prompt, model: currentModel, reasoningEffort: currentReasoningEffort, session, sessionTitle };
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
function firstObject(source, keys) {
    for (const key of keys) {
        const candidate = object(source[key]);
        if (candidate)
            return candidate;
    }
    return undefined;
}
function rateLimitSources(root) {
    const sources = [root];
    const add = (value) => {
        const candidate = object(value);
        if (candidate && !sources.includes(candidate))
            sources.push(candidate);
    };
    add(root.rateLimits);
    add(root.rate_limits);
    for (const collection of [object(root.rateLimitsByLimitId), object(root.rate_limits_by_limit_id)]) {
        if (!collection)
            continue;
        add(collection);
        Object.values(collection).forEach(add);
    }
    for (const source of [...sources])
        Object.values(source).forEach(add);
    return sources;
}
function findLimitWindow(sources, keys) {
    for (const source of sources) {
        const direct = firstObject(source, keys);
        if (direct)
            return direct;
        for (const value of Object.values(source)) {
            const nested = object(value);
            const candidate = nested && firstObject(nested, keys);
            if (candidate)
                return candidate;
        }
    }
    return undefined;
}
function toLimitWindow(value) {
    if (!value)
        return undefined;
    const usedPercent = number(value.used_percent) ?? number(value.usedPercent) ?? number(value.used_percentage) ?? number(value.usedPercentage);
    const remainingPercent = number(value.remaining_percent) ??
        number(value.remainingPercent) ??
        number(value.remaining_percentage) ??
        number(value.remainingPercentage);
    const resetAt = dateFrom(value.resets_at) ??
        dateFrom(value.reset_at) ??
        dateFrom(value.resetsAt) ??
        dateFrom(value.resetAt) ??
        dateFrom(value.reset_time) ??
        dateFrom(value.resetTime);
    const windowDurationMins = number(value.window_duration_mins) ?? number(value.windowDurationMins) ?? number(value.window_minutes) ?? number(value.windowMinutes);
    return usedPercent === undefined && remainingPercent === undefined
        ? undefined
        : { remainingPercent: Math.max(0, Math.min(100, remainingPercent ?? 100 - (usedPercent ?? 0))), resetAt, windowDurationMins };
}
function readAccountSummary(root, rateLimits) {
    const sources = [root, rateLimits, object(root.account), object(root.subscription), object(root.plan)].filter((value) => Boolean(value));
    const readText = (keys) => {
        for (const source of sources) {
            for (const key of keys) {
                const value = source[key];
                if (typeof value === "string" && value.trim())
                    return value.trim();
                if (typeof value === "number" && Number.isFinite(value))
                    return value.toLocaleString();
            }
        }
        return undefined;
    };
    const renewal = sources
        .map((source) => dateFrom(source.renews_at) ?? dateFrom(source.renewal_date) ?? dateFrom(source.renewalAt) ?? dateFrom(source.renewalDate))
        .find(Boolean);
    const account = {
        plan: readText(["plan", "plan_name", "planName", "subscription_plan", "subscriptionPlan"]),
        credits: readText(["credits", "credit_balance", "creditBalance", "balance"]),
        renewalDate: renewal
    };
    return account.plan || account.credits || account.renewalDate ? account : undefined;
}
function parseRateLimitResponse(value) {
    const root = object(value);
    if (!root)
        return undefined;
    const sources = rateLimitSources(root);
    const primary = toLimitWindow(findLimitWindow(sources, ["primary", "primary_window", "primaryWindow", "five_hour", "fiveHour"]));
    const secondary = toLimitWindow(findLimitWindow(sources, ["secondary", "secondary_window", "secondaryWindow", "weekly", "weekly_window", "weeklyWindow"]));
    const primaryIsWeekly = (primary?.windowDurationMins ?? 0) >= 24 * 60;
    const fiveHour = primary && !primaryIsWeekly ? primary : undefined;
    const weekly = secondary ?? (primaryIsWeekly ? primary : undefined);
    return fiveHour || weekly
        ? { fiveHour: fiveHour ?? {}, weekly: weekly ?? {}, account: readAccountSummary(root, sources[1] ?? root) }
        : undefined;
}
function normalizeAppearanceSettings(value) {
    const appearance = object(value) ?? {};
    const clamp = (numberValue) => Math.max(0, Math.min(100, numberValue));
    const color = (candidate, fallback) => typeof candidate === "string" && /^#[0-9a-f]{6}$/i.test(candidate) ? candidate : fallback;
    const warningThreshold = clamp(number(appearance.warningThreshold) ?? 40);
    return {
        warningThreshold,
        criticalThreshold: Math.min(clamp(number(appearance.criticalThreshold) ?? 30), warningThreshold),
        warningColor: color(appearance.warningColor, "#d97706"),
        criticalColor: color(appearance.criticalColor, "#dc2626"),
        belowFullColor: color(appearance.belowFullColor, "#cccccc"),
        outputDebug: appearance.outputDebug === true
    };
}
function aggregateChartData(prompts) {
    return prompts.reduce((totals, prompt) => ({
        input: totals.input + (prompt.inputTokens ?? 0),
        output: totals.output + (prompt.outputTokens ?? 0),
        cached: totals.cached + (prompt.cachedTokens ?? 0),
        cost: totals.cost + (prompt.cost ?? 0),
        requests: totals.requests + 1
    }), { input: 0, output: 0, cached: 0, cost: 0, requests: 0 });
}
//# sourceMappingURL=usage.js.map