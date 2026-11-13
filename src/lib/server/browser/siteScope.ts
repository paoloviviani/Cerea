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

import type { BrowserAction } from "./contract";
import { normalizeKey, type Classification } from "./classifier";

/** The allowance key for an ask, or undefined when only "Allow this action" is offered. */
export function scopeKey(
	action: BrowserAction,
	classification: Classification
): string | undefined {
	if (classification.class !== "commit") return undefined;
	if (action.type === "click" && classification.reason === "unclassified") {
		return "click:unclassified";
	}
	if (action.type === "press" && classification.reason === "unknown-element") {
		const { key, kind } = normalizeKey(action.key);
		// Enter or Space with nothing named acts on whatever has focus: it may submit. Only a key
		// the browser does not know qualifies.
		if (kind !== "unknown") return undefined;
		// Paste would put the user's clipboard into the page.
		if (/(^|\+)(v|insert)$/i.test(action.key)) return undefined;
		return `press:${key}`;
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
