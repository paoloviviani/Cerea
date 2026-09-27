/**
 * One normalisation, shared with Pystino (ADR 0093 §6.1).
 *
 * `normalize_email(s) = NFKC(s).strip()`, then `casefold()` in Python; here,
 * `s.normalize("NFKC").trim().toLowerCase()`. For ASCII, `casefold` and
 * `toLowerCase` agree, which is why every automatic trust decision (link,
 * admin email, bootstrap) requires the normalised address to be ASCII —
 * outside ASCII the two languages' case folding can differ, and that gap is
 * also where homoglyph addresses live (R2). `normalizeEmailVectors.json` is
 * the shared proof: both repositories' suites read the same file, and an
 * entry with `normalized: null` only asserts `trusted: false`, because that
 * is a vector where Python and TypeScript legitimately disagree on the
 * normalised string itself.
 */

// RFC 5322 `atext` plus dots, no leading, trailing or doubled dot — the same
// rule §6.1 gives the bundled users' email validator, reused here since the
// shared vectors (`.lead@example.org`) test exactly this.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_PART = new RegExp(`^${ATEXT}(\\.${ATEXT})*$`);
// LDH labels, at least two, an alphabetic TLD of two or more characters.
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^(${LABEL}\\.)+[a-z]{2,}$`);

export function normalizeEmail(input: string): string {
	return input.normalize("NFKC").trim().toLowerCase();
}

function isAscii(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /^[\x00-\x7f]*$/.test(value);
}

/**
 * May this address take part in an automatic trust decision (link-by-email,
 * `OIDC_ADMIN_EMAIL`, the bootstrap)? ASCII after normalisation, exactly one
 * `@`, and a syntactically valid address — the same conditions §6.1 states,
 * checked directly rather than inferred from whether `normalize_email`
 * happened to change anything.
 */
export function isTrustedEmail(input: string): boolean {
	if (!input) return false;
	const normalized = normalizeEmail(input);
	if (!isAscii(normalized)) return false;
	const parts = normalized.split("@");
	if (parts.length !== 2) return false;
	const [local, domain] = parts;
	return LOCAL_PART.test(local) && DOMAIN.test(domain);
}
