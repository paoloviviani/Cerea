/**
 * COPY of Cerea's `src/lib/server/browser/classifier.ts` (made by scripts/sync-contract.mjs): never edit it here.
 */
/**
 * Action classes for browsing (ADR 0116 §4): a pure function from what Cerea knows of the
 * element (the runtime's snapshot metadata) and the action, to read, input or commit.
 *
 * - **read**: scroll, wait, open something on the current site, navigate within it.
 * - **input**: typing into a field, picking an option.
 * - **commit**: anything that submits, spends, sends, removes, publishes, signs or downloads, and
 *   leaving for another site. These are what the user is asked about.
 *
 * It fails closed: a click on an element Cerea has no metadata for is a commit. The name rule is
 * deliberately broad (a "Remove filter" button asks too); asking is cheap, a wrong click is not.
 * Verbs are listed in English, Italian, Spanish, French and German; a name in another language
 * that is not matched still asks when the element submits a form or leaves the site.
 */

import type { BrowserAction, SnapshotElement } from "./contract.ts";
import { hostOf, sameSite, siteOf } from "./siteRules.ts";
import { createHash } from "node:crypto";
import { sanitizeText } from "./cereaSanitize.ts";

export type ActionClass = "read" | "input" | "commit";

export type CommitReason =
	| "submit"
	| "verb"
	| "download"
	| "new-domain"
	| "unknown-element"
	| "unclassified"
	| "bad-url"
	| "user-tab";

export interface Classification {
	class: ActionClass;
	reason?: CommitReason;
	/** For a navigation or a link that leaves the page: the host it goes to. */
	targetHost?: string;
}

/** The names of controls that mean pay, buy, order, send, delete, remove, confirm, publish or sign. */
const COMMIT_WORDS: ReadonlySet<string> = new Set([
	// en
	"pay",
	"buy",
	"purchase",
	"order",
	"checkout",
	"send",
	"submit",
	"delete",
	"remove",
	"confirm",
	"publish",
	"sign",
	"book",
	"reserve",
	"donate",
	"subscribe",
	"transfer",
	"post",
	"save",
	"apply",
	"accept",
	"approve",
	"share",
	"reply",
	"upload",
	"cancel",
	"unsubscribe",
	"deactivate",
	// it
	"paga",
	"pagare",
	"paghi",
	"acquista",
	"acquistare",
	"compra",
	"comprare",
	"ordina",
	"ordinare",
	"invia",
	"inviare",
	"elimina",
	"eliminare",
	"cancella",
	"cancellare",
	"rimuovi",
	"rimuovere",
	"conferma",
	"confermare",
	"pubblica",
	"pubblicare",
	"firma",
	"firmare",
	"prenota",
	"prenotare",
	"iscriviti",
	"dona",
	"trasferisci",
	"bonifico",
	"salva",
	"salvare",
	"applica",
	"applicare",
	"accetta",
	"accettare",
	"approva",
	"approvare",
	"condividi",
	"condividere",
	"rispondi",
	"rispondere",
	"carica",
	"caricare",
	"annulla",
	"annullare",
	"disiscriviti",
	"disattiva",
	"disattivare",
	// es
	"pagar",
	"comprar",
	"enviar",
	"eliminar",
	"borrar",
	"confirmar",
	"publicar",
	"firmar",
	"reservar",
	"pedir",
	// fr
	"payer",
	"acheter",
	"commander",
	"envoyer",
	"supprimer",
	"confirmer",
	"publier",
	"signer",
	"reserver",
	// de
	"bezahlen",
	"kaufen",
	"bestellen",
	"senden",
	"absenden",
	"loschen",
	"entfernen",
	"bestatigen",
	"veroffentlichen",
	"unterschreiben",
	"buchen",
]);

/** "Sign in", "sign up" and "sign out" are not signing a document. */
const NOT_A_SIGNATURE = /\b(sign|log)\s*(in|up|out|on|off)\b/;

/** Lower-case, accents folded, so "Bestätigen" and "Réserver" match their plain spellings. */
export function normalizeName(name: string): string {
	return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Whether a control's name means a commit. */
export function nameMeansCommit(name: string): boolean {
	const text = normalizeName(name);
	if (!text.trim()) return false;
	const words = text.split(/[^a-z]+/).filter(Boolean);
	return words.some((word) => {
		if (!COMMIT_WORDS.has(word)) return false;
		return !(word === "sign" && NOT_A_SIGNATURE.test(text));
	});
}

export { sameSite, siteOf };

/** Whether a name has a letter we can read (Latin script). A button without one cannot be classified by name. */
function hasLatinLetters(name: string): boolean {
	return /[a-z]/i.test(normalizeName(name));
}

const MODIFIER = /^(control|ctrl|shift|alt|meta|cmd|command|option|mod|controlormeta)$/i;
/** A modifier that turns a key into a shortcut (Shift alone only changes the character). */
const SHORTCUT_MODIFIER = /^(control|ctrl|alt|meta|cmd|command|option|mod|controlormeta)$/i;
/** Navigation and editing keys that do nothing but move or edit in the field. */
const SAFE_NAMED = new Set([
	"tab",
	"escape",
	"esc",
	"backspace",
	"delete",
	"arrowup",
	"arrowdown",
	"arrowleft",
	"arrowright",
	"home",
	"end",
	"pageup",
	"pagedown",
]);

export type KeyKind = "enter" | "space" | "safe" | "unknown";

/**
 * A key press as Cerea reads it, failing closed. Aliases fold (`\n`, `\r`, `Return`,
 * `NumpadEnter` are Enter; a lone space and `Spacebar` are Space). Only a printable character or
 * a known navigation or editing key is `safe`; anything else (a function key, a control or
 * whitespace character, a key with a shortcut modifier, an unknown name) is `unknown`, which the
 * classifier treats as a commit.
 */
export function normalizeKey(raw: string): { key: string; modified: boolean; kind: KeyKind } {
	let modifiers: string[];
	let last: string;
	if (raw.endsWith("++") || raw === "+") {
		modifiers = raw === "+" ? [] : raw.slice(0, -2).split("+");
		last = "+";
	} else {
		const parts = raw.split("+");
		last = parts.at(-1) ?? "";
		modifiers = parts.slice(0, -1);
	}
	const modified = modifiers.length > 0;
	const unknown = (): { key: string; modified: boolean; kind: KeyKind } => ({
		key: last.toLowerCase(),
		modified,
		kind: "unknown",
	});
	if (!modifiers.every((m) => MODIFIER.test(m.trim()))) return unknown();
	const lower = last.toLowerCase();
	if (
		last === "\n" ||
		last === "\r" ||
		last === "\r\n" ||
		["enter", "return", "numpadenter"].includes(lower)
	) {
		return { key: "enter", modified, kind: "enter" };
	}
	const shortcut = modifiers.some((m) => SHORTCUT_MODIFIER.test(m.trim()));
	if (last === " " || lower === "space" || lower === "spacebar") {
		return shortcut ? unknown() : { key: "space", modified, kind: "space" };
	}
	// Any other whitespace or control character.
	// eslint-disable-next-line no-control-regex
	if (/[\s\u0000-\u001f\u007f]/.test(last)) return unknown();
	if (shortcut) return unknown();
	if (SAFE_NAMED.has(lower)) return { key: lower, modified, kind: "safe" };
	if ([...last].length === 1) return { key: last, modified, kind: "safe" };
	return unknown();
}

function resolveUrl(url: string, base: string): URL | undefined {
	try {
		return new URL(url, base);
	} catch {
		return undefined;
	}
}

export interface ClassifyContext {
	/** The element the action names, from the latest snapshot, when it is there. */
	element?: SnapshotElement;
	/** The page the action runs on. */
	currentUrl: string;
	/**
	 * The host of the last real site the task was on. A page with no host (`about:blank`) is judged
	 * against it, so a blank page is no stepping stone to another site.
	 */
	lastSite?: string;
	/**
	 * This is the task's first navigation, from a blank start page, to the address the chat asked
	 * for (`start_url`): the one move that may leave a page with no site without asking.
	 */
	firstNavigation?: boolean;
	/** For `use_tab`: the tab as `tabs()` listed it (id, address, title). */
	tab?: { id: string; url: string; title: string };
}

/** Submitting a form: a read when it is a GET form (a search), else a commit. */
function submitClass(el: SnapshotElement | undefined, currentUrl: string): Classification {
	const current = hostOf(currentUrl);
	const target = el?.formActionHost ? hostOf(el.formActionHost) : undefined;
	// A form that posts to another site leaves it, whatever its method.
	if (target && current && !sameSite(target, current)) {
		return { class: "commit", reason: "new-domain", targetHost: target };
	}
	if (el?.formMethod === "get" && !nameMeansCommit(el.name)) return { class: "read" };
	return { class: "commit", reason: "submit" };
}

export function classifyAction(action: BrowserAction, ctx: ClassifyContext): Classification {
	const current = hostOf(ctx.currentUrl);
	// The runtime could not read this element's metadata: nothing about it can be trusted.
	if ("ref" in action && action.ref && ctx.element?.metaUnknown) {
		return { class: "commit", reason: "unknown-element" };
	}
	switch (action.type) {
		case "use_tab":
			// Always asks: the page is the user's own, with its logins. The tab's host is what the
			// deny list is checked against; no allow list ever covers it.
			return {
				class: "commit",
				reason: "user-tab",
				...(ctx.tab ? { targetHost: hostOf(ctx.tab.url) } : {}),
			};
		case "scroll":
		case "wait_for":
			return { class: "read" };
		case "select":
			return { class: "input" };
		case "fill":
			return action.submit ? submitClass(ctx.element, ctx.currentUrl) : { class: "input" };
		case "press": {
			const { kind, modified } = normalizeKey(action.key);
			if (kind === "unknown") return { class: "commit", reason: "unknown-element" };
			if (kind === "safe") return { class: "input" };
			// Enter or Space with no target element acts on whatever has focus: unknown.
			if (!action.ref) return { class: "commit", reason: "unknown-element" };
			const el = ctx.element;
			if (!el) return { class: "commit", reason: "unknown-element" };
			// A modified Enter (Control+Enter, Meta+Enter, Shift+Enter) sends or submits in most apps.
			if (kind === "enter" && modified) return { class: "commit", reason: "submit" };
			const typing = el.role === "textbox" || el.role === "searchbox" || el.role === "combobox";
			// Enter or Space on anything that is not a place to type is a click on it: the verb,
			// href, download and cross-site rules apply whatever its role.
			if (!typing) return classifyAction({ type: "click", ref: el.ref }, ctx);
			if (kind === "enter") {
				if (el.form || el.submits) return submitClass(el, ctx.currentUrl);
				// A search box is a read; a text box or a combobox with no form is a chat box or a
				// contenteditable that sends on Enter (Slack, WhatsApp Web, Discord).
				if (el.role === "searchbox") return { class: "input" };
				return { class: "commit", reason: "submit" };
			}
			return { class: "input" };
		}
		case "navigate": {
			const target = resolveUrl(action.url, ctx.currentUrl);
			if (!target || !isWebUrl(target)) {
				// Not even about:blank: a blank page is a stepping stone, never a destination.
				return { class: "commit", reason: "bad-url" };
			}
			const host = target.hostname.toLowerCase();
			// A page with no host is judged against the last real site of the task; with none,
			// anywhere is a new site, except the task's own first move to its start address.
			const from = current ?? ctx.lastSite;
			if (!from) {
				return ctx.firstNavigation
					? { class: "read", targetHost: host }
					: { class: "commit", reason: "new-domain", targetHost: host };
			}
			if (!sameSite(host, from)) {
				return { class: "commit", reason: "new-domain", targetHost: host };
			}
			return { class: "read", targetHost: host };
		}
		case "click": {
			const el = ctx.element;
			if (!el) return { class: "commit", reason: "unknown-element" };
			if (el.download) return { class: "commit", reason: "download" };
			if (el.href) {
				const target = resolveUrl(el.href, ctx.currentUrl);
				if (
					target &&
					!isWebUrl(target) &&
					!(target.protocol === "about:" && target.pathname === "blank")
				) {
					return { class: "commit", reason: "bad-url" };
				}
			}
			if (el.submits) {
				// A search button (a GET form) is a read; any other submit commits.
				const submitted = submitClass(el, ctx.currentUrl);
				if (submitted.class === "commit") return submitted;
			}
			// The name of every click target counts, whatever its role: a div with an onclick is
			// still "Delete".
			if (nameMeansCommit(el.name)) return { class: "commit", reason: "verb" };
			// A button we cannot read the name of (empty, or no Latin letters) cannot be classified.
			if (el.role === "button" && (!el.name.trim() || !hasLatinLetters(el.name))) {
				return { class: "commit", reason: "unclassified" };
			}
			// A relative href resolves on the current site; only an absolute one can leave it.
			const hrefHost = el.href
				? resolveUrl(el.href, ctx.currentUrl)?.hostname.toLowerCase()
				: undefined;
			const linkHost = el.linkDomain ? hostOf(el.linkDomain) : hrefHost && hostOf(hrefHost);
			const from = current ?? ctx.lastSite;
			// Any element that leads away counts, not only a link: a menu item with an href too.
			if (linkHost && (!from || !sameSite(linkHost, from))) {
				return { class: "commit", reason: "new-domain", targetHost: linkHost };
			}
			return { class: "read" };
		}
	}
}

function isWebUrl(url: URL): boolean {
	return url.protocol === "http:" || url.protocol === "https:";
}

// ----- the sentence and the digest --------------------------------------------------------

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** A string from the page, safe to put in a sentence: fence tags removed, one line, quoted. */
export function quoted(text: string, max: number): string {
	return JSON.stringify(clip(sanitizeText(text).trim(), max));
}

/** The plain sentence an approval card shows: 'Click "Pay €120" on shop.example.com'. */
export function describeAction(action: BrowserAction, ctx: ClassifyContext): string {
	const site = hostOf(ctx.currentUrl) ?? ctx.currentUrl;
	const label = ctx.element?.name ? quoted(ctx.element.name, 80) : undefined;
	switch (action.type) {
		case "use_tab": {
			const host = ctx.tab ? (hostOf(ctx.tab.url) ?? "") : "";
			return `Let Cerea use your tab ${quoted(ctx.tab?.title || host || "a tab", 80)}${host ? ` (${host})` : ""}?`;
		}
		case "click":
			if (ctx.element?.download) {
				return `Download ${label ?? "a file"} from ${site}`;
			}
			return `Click ${label ?? "an element"} on ${site}`;
		case "fill":
			return `Type into ${label ?? "a field"} on ${site}${action.submit ? " and press Enter" : ""}`;
		case "select":
			return `Choose ${quoted(action.value, 60)} in ${label ?? "a list"} on ${site}`;
		case "press":
			return `Press ${action.key}${label ? ` in ${label}` : ""} on ${site}`;
		case "scroll":
			return `Scroll ${action.direction} on ${site}`;
		case "wait_for":
			return `Wait on ${site}`;
		case "navigate": {
			const target = resolveUrl(action.url, ctx.currentUrl);
			const to = target ? target.hostname : clip(action.url, 80);
			return `Open ${to} from ${site}`;
		}
	}
}

/**
 * Binds an approval to one exact action: the action, the element's name and the page's origin.
 * The runtime recomputes it from what it is about to do, so a grant for "Pay €120" does not
 * cover a different click, a changed button or another site.
 */
/** The action's value, as the digest defines it (see `approvalGrantSchema`). */
export function actionValue(action: BrowserAction): string {
	switch (action.type) {
		case "fill":
			return action.text + (action.submit ? "\n#submit" : "");
		case "select":
			return action.value;
		case "press": {
			const { key, modified } = normalizeKey(action.key);
			return key + (modified ? "+mod" : "");
		}
		case "navigate":
			return action.url;
		case "scroll":
			return `${action.direction}:${action.amount ?? ""}`;
		case "wait_for":
			return action.text ?? String(action.ms ?? "");
		case "click":
			return "";
		case "use_tab":
			return "";
	}
}

/** The page URL as the digest takes it: without its fragment. */
export function urlWithoutFragment(url: string): string {
	const hash = url.indexOf("#");
	return hash === -1 ? url : url.slice(0, hash);
}

export function actionDigest(action: BrowserAction, ctx: ClassifyContext): string {
	if (action.type === "use_tab") {
		// Binds the tab, its address and its title as `tabs()` showed them: a tab that navigated or
		// was retitled since the user approved no longer matches.
		const canonical = JSON.stringify([
			"use_tab",
			ctx.tab?.id ?? action.tab,
			"",
			urlWithoutFragment(ctx.tab?.url ?? ""),
			ctx.tab?.title ?? "",
			"user-tab",
			"",
			"0",
		]);
		return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
	}
	const ref = "ref" in action && action.ref ? action.ref : "";
	// The facts that decided the class are bound too: a page that rewrites a link or a form
	// action after the approval no longer matches.
	const decided = classifyAction(action, ctx);
	const canonical = JSON.stringify([
		action.type,
		ref,
		actionValue(action),
		urlWithoutFragment(ctx.currentUrl),
		ctx.element?.name ?? "",
		decided.reason ?? "",
		decided.targetHost ?? "",
		ctx.element?.download ? "1" : "0",
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
