/**
 * "Allow on this site for this chat" (ADR 0116 §4): which asks may be allowed for a whole site,
 * and the key one allowance is stored under.
 *
 * Only the asks that are about not knowing what a control does qualify: a button whose name the
 * browser cannot read, a key it does not know. A hard commit (submitting a form, a named pay, buy,
 * order, send, delete, remove, confirm, publish or sign control, a download, a new domain, a tab
 * of the user's, a page that is not a web page) always asks again: only "Allow this action" is
 * offered for those. Pasting is left out too, as it puts the user's clipboard into the page.
 */

import { createHash } from "node:crypto";
import type { BrowserAction, SnapshotElement } from "./contract";
import { normalizeKey, normalizeName, type Classification } from "./classifier";
import { sanitizeText } from "./sanitize";

const MODIFIER_NAMES: Record<string, string> = {
	control: "control",
	ctrl: "control",
	alt: "alt",
	option: "alt",
	shift: "shift",
	meta: "meta",
	cmd: "meta",
	command: "meta",
	mod: "mod",
	controlormeta: "mod",
};

/** A key as one canonical chord (sorted, lower-case modifiers and the key), or undefined when it is not one. */
function chordOf(raw: string): string | undefined {
	const plus = raw.endsWith("++") || raw === "+";
	const parts = plus ? [...(raw === "+" ? [] : raw.slice(0, -2).split("+")), "+"] : raw.split("+");
	const last = parts.at(-1) ?? "";
	const names: string[] = [];
	for (const m of parts.slice(0, -1)) {
		const name = MODIFIER_NAMES[m.trim().toLowerCase()];
		if (!name) return undefined;
		names.push(name);
	}
	const key = last.toLowerCase();
	if (!key.trim() || ["enter", "return", "numpadenter", "space", "spacebar"].includes(key)) {
		return undefined;
	}
	return [...new Set(names)].sort().concat(key).join("+");
}

/** The allowance key for an ask, or undefined when only "Allow this action" is offered. */
export function scopeKey(
	action: BrowserAction,
	classification: Classification,
	element?: SnapshotElement
): string | undefined {
	if (classification.class !== "commit") return undefined;
	if (action.type === "click" && classification.reason === "unclassified") {
		// Only a control that is a bare symbol ("+", "⋯"): a button named in another script
		// ("Оплатить", "購入する") could be anything, and is asked about each time. The key names
		// the control, so one allowance is for that one symbol.
		if (!element) return undefined;
		const text = sanitizeText(element.name.trim() ? element.name : (element.hint ?? "")).trim();
		if (!text || /\p{L}/u.test(text)) return undefined;
		return `click:unclassified:${createHash("sha256").update(normalizeName(text)).digest("hex").slice(0, 16)}`;
	}
	if (action.type === "press" && classification.reason === "unknown-element") {
		const { kind } = normalizeKey(action.key);
		// Enter or Space with nothing named acts on whatever has focus: it may submit. Only a key
		// the browser does not know qualifies.
		if (kind !== "unknown") return undefined;
		const chord = chordOf(action.key);
		if (!chord) return undefined;
		// Paste would put the user's clipboard into the page.
		if (/(^|\+)(v|insert)$/.test(chord)) return undefined;
		return `press:${chord}`;
	}
	return undefined;
}

/** The origin an allowance is for; undefined for a page that is not on the web. */
export function scopeOrigin(url: string): string | undefined {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
	} catch {
		return undefined;
	}
}
