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
	"submit" | "verb" | "download" | "new-domain" | "unknown-element" | "unclassified" | "bad-url";

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

/** What `fill` into a submit-capable field etc. means for a key: modifiers stripped, aliases folded. */
export function normalizeKey(raw: string): { key: string; modified: boolean } {
	if (raw === " ") return { key: "space", modified: false };
	const parts = raw.split("+").map((p) => p.trim());
	// "Control++" style: a trailing empty part after "+" means the key itself is "+".
	const last = (parts.at(-1) || (raw.endsWith("+") ? "+" : "")).toLowerCase();
	const modifiers = parts
		.slice(0, -1)
		.filter((p) => /^(control|ctrl|shift|alt|meta|cmd|command|option|mod|controlormeta)$/i.test(p));
	const key =
		last === "numpadenter" || last === "return"
			? "enter"
			: last === " " || last === "spacebar" || last === ""
				? "space"
				: last;
	return { key, modified: modifiers.length > 0 };
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
	switch (action.type) {
		case "scroll":
		case "wait_for":
			return { class: "read" };
		case "select":
			return { class: "input" };
		case "fill":
			return action.submit ? submitClass(ctx.element, ctx.currentUrl) : { class: "input" };
		case "press": {
			const { key, modified } = normalizeKey(action.key);
			if (key !== "enter" && key !== "space") return { class: "input" };
			// Enter or Space with no target element acts on whatever has focus: unknown.
			if (!action.ref) return { class: "commit", reason: "unknown-element" };
			const el = ctx.element;
			if (!el) return { class: "commit", reason: "unknown-element" };
			// A modified Enter (Control+Enter, Meta+Enter) sends or submits in most apps.
			if (key === "enter" && modified) return { class: "commit", reason: "submit" };
			if (el.role === "button" || el.role === "link") {
				return classifyAction({ type: "click", ref: el.ref }, ctx);
			}
			if (key === "enter" && (el.form || el.submits)) return submitClass(el, ctx.currentUrl);
			return { class: "input" };
		}
		case "navigate": {
			const target = resolveUrl(action.url, ctx.currentUrl);
			if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
				// about:blank is the one non-web address a browser starts from.
				if (target && target.protocol === "about:" && target.pathname === "blank") {
					return { class: "read" };
				}
				return { class: "commit", reason: "bad-url" };
			}
			const host = target.hostname.toLowerCase();
			if (current && !sameSite(host, current)) {
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
			if (el.role === "link" && linkHost && current && !sameSite(linkHost, current)) {
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
		case "press":
			return normalizeKey(action.key).key + (normalizeKey(action.key).modified ? "+mod" : "");
		case "navigate":
			return action.url;
		case "scroll":
			return `${action.direction}:${action.amount ?? ""}`;
		case "wait_for":
			return action.text ?? String(action.ms ?? "");
		case "click":
			return "";
	}
}

/** The page URL as the digest takes it: without its fragment. */
export function urlWithoutFragment(url: string): string {
	const hash = url.indexOf("#");
	return hash === -1 ? url : url.slice(0, hash);
}

export function actionDigest(action: BrowserAction, ctx: ClassifyContext): string {
	const ref = "ref" in action && action.ref ? action.ref : "";
	const canonical = JSON.stringify([
		action.type,
		ref,
		actionValue(action),
		urlWithoutFragment(ctx.currentUrl),
		ctx.element?.name ?? "",
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
