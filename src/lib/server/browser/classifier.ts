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

import type { BrowserAction, SnapshotElement } from "./contract";
import { hostOf } from "./siteRules";
import { createHash } from "node:crypto";

export type ActionClass = "read" | "input" | "commit";

export type CommitReason =
	"submit" | "verb" | "download" | "new-domain" | "unknown-element" | "bad-url";

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

/** Roles whose name says what pressing them does. */
const ACTING_ROLES: ReadonlySet<string> = new Set([
	"button",
	"link",
	"menuitem",
	"switch",
	"generic",
	"img",
	"image",
	"treeitem",
	"cell",
]);

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

/** The registrable part of a host, approximately: `shop.example.co.uk` and `www.example.co.uk` agree. */
export function siteOf(host: string): string {
	const labels = host.toLowerCase().split(".");
	if (labels.length <= 2) return host.toLowerCase();
	const tld = labels[labels.length - 1];
	const second = labels[labels.length - 2];
	const twoLevel =
		tld.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(second);
	return labels.slice(twoLevel ? -3 : -2).join(".");
}

export function sameSite(a: string, b: string): boolean {
	return siteOf(a) === siteOf(b);
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
function submitClass(el: SnapshotElement | undefined): Classification {
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
			return action.submit ? submitClass(ctx.element) : { class: "input" };
		case "press": {
			const enter = /^(enter|return)$/i.test(action.key);
			if (!enter) return { class: "input" };
			// Enter in a field of a form submits it; Enter where Cerea does not know the
			// element, too. Enter on a link or a plain button opens it, which the click rules own.
			const el = ctx.element;
			if (action.ref && !el) return { class: "commit", reason: "unknown-element" };
			if (el && (el.form || el.submits)) return submitClass(el);
			if (el && (el.role === "button" || el.role === "link")) {
				return classifyAction({ type: "click", ref: el.ref }, ctx);
			}
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
			if (el.submits) {
				// A search button (a GET form) is a read; any other submit commits.
				const submitted = submitClass(el);
				if (submitted.class === "commit") return submitted;
			}
			if (ACTING_ROLES.has(el.role) && nameMeansCommit(el.name)) {
				return { class: "commit", reason: "verb" };
			}
			// A relative href resolves on the current site; only an absolute one can leave it.
			const hrefHost = el.href
				? resolveUrl(el.href, ctx.currentUrl)?.hostname.toLowerCase()
				: undefined;
			const linkHost = el.linkDomain ? el.linkDomain.toLowerCase() : hrefHost;
			if (el.role === "link" && linkHost && current && !sameSite(linkHost, current)) {
				return { class: "commit", reason: "new-domain", targetHost: linkHost };
			}
			return { class: "read" };
		}
	}
}

// ----- the sentence and the digest --------------------------------------------------------

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The plain sentence an approval card shows: "Click 'Pay €120' on shop.example.com". */
export function describeAction(action: BrowserAction, ctx: ClassifyContext): string {
	const site = hostOf(ctx.currentUrl) ?? ctx.currentUrl;
	const label = ctx.element?.name ? `'${clip(ctx.element.name.trim(), 80)}'` : undefined;
	switch (action.type) {
		case "click":
			if (ctx.element?.download) {
				return `Download ${label ?? "a file"} from ${site}`;
			}
			return `Click ${label ?? "an element"} on ${site}`;
		case "fill":
			return `Type into ${label ?? "a field"} on ${site}${action.submit ? " and press Enter" : ""}`;
		case "select":
			return `Choose '${clip(action.value, 60)}' in ${label ?? "a list"} on ${site}`;
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
			return action.key;
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

export function actionDigest(action: BrowserAction, ctx: ClassifyContext): string {
	let origin = "";
	try {
		origin = new URL(ctx.currentUrl).origin;
	} catch {
		origin = ctx.currentUrl;
	}
	const ref = "ref" in action && action.ref ? action.ref : "";
	const canonical = JSON.stringify([
		action.type,
		ref,
		actionValue(action),
		origin,
		ctx.element?.name ?? "",
	]);
	return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
