/**
 * The words and the colour of the turn-details overlay, kept out of the
 * component so they can be tested without rendering it.
 */
import { m } from "$lib/paraglide/messages";
import { formatCost } from "$lib/utils/gatewayUsage";
import type { RedactionEntity, TurnRedaction, TurnStats } from "$lib/types/TurnStats";

export type DotState = "neutral" | "applied" | "blocked";

/** Grey by default, yellow when values were hidden, red when the request was refused. */
export function dotState(stats: TurnStats | undefined): DotState {
	const redaction = stats?.redaction;
	if (redaction?.blocked) return "blocked";
	if (redaction?.applied) return "applied";
	return "neutral";
}

/** The dot's name for a screen reader and a tooltip: the colour is never the only signal. */
export function dotLabel(state: DotState): string {
	if (state === "blocked") return m["chat.turn_details.button_blocked"]();
	if (state === "applied") return m["chat.turn_details.button_applied"]();
	return m["chat.turn_details.button"]();
}

/** Short visible word beside the title, empty for the neutral state. */
export function dotStateWord(state: DotState): string {
	if (state === "blocked") return m["chat.turn_details.state_blocked"]();
	if (state === "applied") return m["chat.turn_details.state_applied"]();
	return "";
}

const TYPE_NAMES: Record<string, [() => string, () => string]> = {
	PERSON: [m["chat.turn_details.type.PERSON.one"], m["chat.turn_details.type.PERSON.other"]],
	LOCATION: [m["chat.turn_details.type.LOCATION.one"], m["chat.turn_details.type.LOCATION.other"]],
	EMAIL_ADDRESS: [
		m["chat.turn_details.type.EMAIL_ADDRESS.one"],
		m["chat.turn_details.type.EMAIL_ADDRESS.other"],
	],
	PHONE_NUMBER: [
		m["chat.turn_details.type.PHONE_NUMBER.one"],
		m["chat.turn_details.type.PHONE_NUMBER.other"],
	],
	IBAN_CODE: [
		m["chat.turn_details.type.IBAN_CODE.one"],
		m["chat.turn_details.type.IBAN_CODE.other"],
	],
	IT_FISCAL_CODE: [
		m["chat.turn_details.type.IT_FISCAL_CODE.one"],
		m["chat.turn_details.type.IT_FISCAL_CODE.other"],
	],
	IT_IDENTITY_CARD: [
		m["chat.turn_details.type.IT_IDENTITY_CARD.one"],
		m["chat.turn_details.type.IT_IDENTITY_CARD.other"],
	],
	IT_PASSPORT: [
		m["chat.turn_details.type.IT_PASSPORT.one"],
		m["chat.turn_details.type.IT_PASSPORT.other"],
	],
	IT_DRIVER_LICENSE: [
		m["chat.turn_details.type.IT_DRIVER_LICENSE.one"],
		m["chat.turn_details.type.IT_DRIVER_LICENSE.other"],
	],
	CREDIT_CARD: [
		m["chat.turn_details.type.CREDIT_CARD.one"],
		m["chat.turn_details.type.CREDIT_CARD.other"],
	],
	DATE_TIME: [
		m["chat.turn_details.type.DATE_TIME.one"],
		m["chat.turn_details.type.DATE_TIME.other"],
	],
};

/** A Presidio type in plain words (singular or plural by `count`); a custom pattern's name stays as it is. */
export function typeName(type: string, count = 1): string {
	const names = TYPE_NAMES[type];
	if (!names) return type;
	return (count === 1 ? names[0] : names[1])();
}

export type ModeKind = "restore" | "hide" | "block";

/** Maps the gateway's mode word onto the three the overlay speaks of. */
export function modeKind(mode: string | undefined): ModeKind | undefined {
	if (!mode || mode.toLowerCase() === "off") return undefined;
	const word = mode.toLowerCase();
	if (/block|refus|reject|deny/.test(word)) return "block";
	if (/restor|revers|round|unmask|pseudonym/.test(word)) return "restore";
	return "hide";
}

export function modeLabel(mode: string | undefined): string {
	const kind = modeKind(mode);
	if (kind === "restore") return m["chat.turn_details.redaction.mode_restore"]();
	if (kind === "block") return m["chat.turn_details.redaction.mode_block"]();
	if (kind === "hide") return m["chat.turn_details.redaction.mode_hide"]();
	return "";
}

export function sourceLabel(source: string): string {
	const word = source.toLowerCase();
	if (/^(user|message|prompt|input)/.test(word))
		return m["chat.turn_details.redaction.source_user"]();
	if (/tool|mcp|function/.test(word)) return m["chat.turn_details.redaction.source_tool"]();
	return m["chat.turn_details.redaction.source_other"]({ source });
}

function ruleLabel(rule: RedactionEntity["rule"]): string {
	if (!rule || (!rule.owner && !rule.name)) return "";
	if (rule.owner === "user") {
		return rule.name
			? m["chat.turn_details.redaction.rule_user"]({ name: rule.name })
			: m["chat.turn_details.redaction.rule_user_unnamed"]();
	}
	if (rule.owner === "admin") {
		return rule.name
			? m["chat.turn_details.redaction.rule_admin"]({ name: rule.name })
			: m["chat.turn_details.redaction.rule_admin_unnamed"]();
	}
	return rule.name ?? "";
}

/**
 * "Hidden from the model: 2 names, 1 fiscal code (admin rule "Cloud providers");
 * 1 record number (your rule)." Entities group by the rule that hid them.
 */
export function redactionSummary(redaction: TurnRedaction): string {
	const groups = new Map<string, Map<string, number>>();
	for (const entity of redaction.entities) {
		const rule = ruleLabel(entity.rule);
		const counts = groups.get(rule) ?? new Map<string, number>();
		counts.set(entity.type, (counts.get(entity.type) ?? 0) + entity.count);
		groups.set(rule, counts);
	}
	const parts = [...groups.entries()].map(([rule, counts]) => {
		const items = [...counts.entries()]
			.map(([type, count]) => `${count} ${typeName(type, count)}`)
			.join(", ");
		return rule ? `${items} (${rule})` : items;
	});
	return m["chat.turn_details.redaction.summary"]({ items: parts.join("; ") });
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null) return "—";
	if (ms < 1000) return m["chat.turn_details.ms"]({ n: String(Math.round(ms)) });
	return m["chat.turn_details.seconds"]({ n: (ms / 1000).toFixed(1) });
}

export function formatSpeed(tokensPerSecond: number | null | undefined): string {
	return tokensPerSecond == null
		? "—"
		: m["chat.turn_details.per_second"]({ n: String(tokensPerSecond) });
}

export function formatCount(n: number | null | undefined): string {
	return n == null ? "—" : new Intl.NumberFormat().format(n);
}

/**
 * The turn's cost for the overlay. A plain decimal (read later from the
 * gateway's usage) is formatted in the deployment's currency, as the quota
 * summary does; a cost the gateway wrote itself ("0.0042 USD") is shown as it
 * came. Nothing known shows "—".
 */
export function formatTurnCost(
	cost: string | null | undefined,
	currency: string | null | undefined
): string {
	if (!cost) return "—";
	return /^\d+(\.\d+)?$/.test(cost) ? formatCost(cost, currency ?? null) : cost;
}
