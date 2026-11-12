/**
 * The deployment's browser-use settings (ADR 0116), all administrator-only and stored in the
 * chat's `config` like the sub-agent switch: off by default, with a model, budgets and site lists.
 *
 * | key                        | meaning                                              | default     |
 * |----------------------------|------------------------------------------------------|-------------|
 * | CHAT_BROWSER_ENABLED       | the `browse` tool exists at all (exactly `"true"`)   | off         |
 * | CHAT_BROWSER_MODEL         | the model the browsing sub-agent runs on             | the chat's  |
 * | CHAT_BROWSER_MAX_STEPS     | model rounds one task may take                       | 25          |
 * | CHAT_BROWSER_MAX_TOKENS    | tokens one task may spend, all requests summed       | 200 000     |
 * | CHAT_BROWSER_MAX_SECONDS   | wall time, not counting waits for an approval        | 300         |
 * | CHAT_BROWSER_SITES_ALLOW   | hosts where commit actions need no approval          | none        |
 * | CHAT_BROWSER_SITES_DENY    | hosts the browser may not use at all                 | none        |
 */

import { config } from "$lib/server/config";
import { parseSiteList, type SiteRules } from "./siteRules";

export const BROWSER_DEFAULTS = {
	maxSteps: 25,
	maxTokens: 200_000,
	maxSeconds: 300,
} as const;

/** Bounds an administrator's numbers are clamped to: a typo never removes the budget. */
export const BROWSER_LIMITS = {
	maxSteps: { min: 1, max: 100 },
	maxTokens: { min: 5_000, max: 2_000_000 },
	maxSeconds: { min: 10, max: 3_600 },
} as const;

export interface BrowserBudgets {
	maxSteps: number;
	maxTokens: number;
	maxSeconds: number;
}

export interface BrowserSettings {
	enabled: boolean;
	/** Empty means the chat's own model. */
	model: string;
	budgets: BrowserBudgets;
	rules: SiteRules;
}

export function browserEnabled(): boolean {
	return config.CHAT_BROWSER_ENABLED === "true";
}

/** A whole number within the limits; the default when the value is empty or not a number. */
export function boundedNumber(raw: string | undefined, key: keyof typeof BROWSER_LIMITS): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(parsed)) return BROWSER_DEFAULTS[key];
	const { min, max } = BROWSER_LIMITS[key];
	return Math.min(max, Math.max(min, parsed));
}

export function browserSettings(): BrowserSettings {
	return {
		enabled: browserEnabled(),
		model: config.CHAT_BROWSER_MODEL?.trim() ?? "",
		budgets: {
			maxSteps: boundedNumber(config.CHAT_BROWSER_MAX_STEPS, "maxSteps"),
			maxTokens: boundedNumber(config.CHAT_BROWSER_MAX_TOKENS, "maxTokens"),
			maxSeconds: boundedNumber(config.CHAT_BROWSER_MAX_SECONDS, "maxSeconds"),
		},
		rules: {
			allow: parseSiteList(config.CHAT_BROWSER_SITES_ALLOW),
			deny: parseSiteList(config.CHAT_BROWSER_SITES_DENY),
		},
	};
}
