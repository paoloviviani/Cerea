/**
 * Is this text a page, or a wall in front of one?
 *
 * Pure functions, shared by the fetch-first decision (`index.ts`: is the direct
 * result good enough, or does the page need a browser?) and by the honest-failure
 * check in `web_fetch` (does the final text still look like a consent notice or a
 * "pay or accept" wall?). One vocabulary, so the two cannot disagree.
 */

/** Hosts a site sends a visitor to for consent, before the page they asked for. */
const CONSENT_HOSTS = [
	"consent.google.com",
	"consent.youtube.com",
	"consent.yahoo.com",
	"guce.yahoo.com",
	"guce.techcrunch.com",
	"consent.cmp.oath.com",
	"privacy.truste.com",
];

export function isConsentRedirectHost(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return CONSENT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
	} catch {
		return false;
	}
}

/** Terms a consent notice is made of, in the languages the clicker lists used to cover. */
const CONSENT_TERMS: RegExp[] = [
	/\bcookies?\b/gi,
	/\bconsent\b/gi,
	/\bpartners?\b/gi,
	/\b(?:legitimate interest|vendors?)\b/gi,
	/\b(?:personali[sz]ed (?:ads|advertising|content)|tracking|trackers?)\b/gi,
	/\b(?:privacy (?:settings|preferences|policy)|manage (?:your )?preferences)\b/gi,
	/\b(?:accept all|reject all|accept and continue)\b/gi,
	// it, de, fr, es, nl, pt
	/\b(?:consenso|rifiuta tutto|accetta tutto|dati personali|trattamento dei dati)\b/gi,
	/\b(?:einwilligung|zustimmen|alle akzeptieren|alle ablehnen|datenschutz|privatsphäre)\b/gi,
	/\b(?:consentement|tout accepter|tout refuser|traceurs|données personnelles)\b/gi,
	/\b(?:consentimiento|aceptar todo|rechazar todo|datos personales)\b/gi,
	/\b(?:toestemming|alles accepteren|alles weigeren|privacyinstellingen)\b/gi,
	/\b(?:consentimento|aceitar tudo|rejeitar tudo|dados pessoais)\b/gi,
];

/** "Pay or accept" walls: read on only by accepting tracking or subscribing. */
const PAYWALL_PHRASES: RegExp[] = [
	/\b(?:pay or accept|accept (?:cookies )?(?:or|and) (?:subscribe|continue reading)|subscribe or accept)\b/i,
	/\b(?:mit werbung und tracking|werbefrei lesen|pur[- ]abo|zustimmen und weiterlesen|akzeptieren und weiterlesen)\b/i,
	/\b(?:accetta e continua|accetta e leggi|abbonati o accetta)\b/i,
	/\b(?:accepter et continuer|accepter ou s'abonner|accepter et lire)\b/i,
	/\b(?:aceptar y continuar|aceptar o suscribirse)\b/i,
	/\b(?:accepteren en doorgaan|accepteren of abonneren)\b/i,
	/\b(?:aceitar e continuar|aceitar ou subscrever)\b/i,
];

export interface ConsentScore {
	/** How many different terms occur. */
	distinct: number;
	/** How many occurrences in all. */
	total: number;
}

export function consentScore(text: string): ConsentScore {
	let distinct = 0;
	let total = 0;
	for (const re of CONSENT_TERMS) {
		const n = text.match(re)?.length ?? 0;
		if (n > 0) distinct += 1;
		total += n;
	}
	return { distinct, total };
}

export type GateKind = "consent" | "paywall";

/**
 * Whether text is a consent notice or a pay-or-accept wall rather than the page.
 * Short text only: a long article that merely discusses cookies is not a wall.
 */
export function detectGate(text: string, url?: string): GateKind | null {
	if (url && isConsentRedirectHost(url)) return "consent";
	const t = text.trim();
	if (PAYWALL_PHRASES.some((re) => re.test(t)) && t.length < 4_000) return "paywall";
	const { distinct, total } = consentScore(t);
	if (t.length < 800 && distinct >= 2 && total >= 3) return "consent";
	if (t.length < 4_000 && distinct >= 3 && total >= 6) return "consent";
	return null;
}

/** The smallest amount of prose that counts as a page. */
export const MIN_REAL_PAGE_CHARS = 600;

const JS_SHELL =
	/\b(?:enable javascript|javascript (?:is|must be) (?:required|disabled|enabled)|you need to enable javascript|please turn on javascript)\b/i;

/**
 * Whether the readable text of a direct fetch is a real page, so rendering it
 * in a browser would add nothing. `text` is the page's readable text (the
 * `readablePageText` of what was fetched, so a homepage that Readability finds no
 * article in still counts when it has plenty of text); `html` is what came back.
 */
export function looksLikeRealPage(text: string, url: string, html = ""): boolean {
	const t = text.trim();
	if (isConsentRedirectHost(url)) return false;
	if (t.length < MIN_REAL_PAGE_CHARS) return false;
	if (detectGate(t) !== null) return false;
	if (t.length < 2_000 && JS_SHELL.test(t)) return false;
	// A near-empty body behind a <noscript> notice: little text next to a lot of markup.
	if (/<noscript\b/i.test(html) && t.length < 1_500 && html.length > t.length * 40) return false;
	return true;
}
