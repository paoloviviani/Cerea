/**
 * Same-resource URL equivalences for the "auto-fetch with verification" web-fetch
 * policy (`Settings.webFetchPolicy === "auto-verified"`, see `fetchVerification.ts`).
 *
 * A search rarely turns up a raw-content URL directly — search engines index the
 * page, not the asset behind its "raw" button — so a strict "the exact URL must
 * appear in results" check would fail closed on the case that motivated this
 * policy: a user pastes a `github.com/org/repo` link, and the model needs
 * `raw.githubusercontent.com/...` to actually read a file's contents.
 *
 * This table is the one place that gap is allowed to close, and only in the
 * reviewed, mechanical direction below — never by the model inventing a
 * transform. Each rule maps a URL to the *other* form of the same resource;
 * verification then treats either form as trusted once one of them has been
 * found (in `allowedFetchUrls` or in fresh search results).
 */

interface EquivalenceRule {
	/** The other form of the same resource, or null if this URL doesn't match the rule. */
	counterpart(url: URL): string | null;
}

const GITHUB_RAW_HOST = "raw.githubusercontent.com";
const GITHUB_HOST = "github.com";

/** `raw.githubusercontent.com/{org}/{repo}/{ref}/{path}` -> `github.com/{org}/{repo}/blob/{ref}/{path}` */
const githubRawToBlob: EquivalenceRule = {
	counterpart(url) {
		if (url.hostname.toLowerCase() !== GITHUB_RAW_HOST) return null;
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 4) return null;
		const [org, repo, ref, ...rest] = parts;
		return `https://${GITHUB_HOST}/${org}/${repo}/blob/${ref}/${rest.join("/")}`;
	},
};

/** `github.com/{org}/{repo}/blob/{ref}/{path}` -> `raw.githubusercontent.com/{org}/{repo}/{ref}/{path}` */
const githubBlobToRaw: EquivalenceRule = {
	counterpart(url) {
		if (url.hostname.toLowerCase() !== GITHUB_HOST) return null;
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length < 5 || parts[2] !== "blob") return null;
		const [org, repo, , ref, ...rest] = parts;
		return `https://${GITHUB_RAW_HOST}/${org}/${repo}/${ref}/${rest.join("/")}`;
	},
};

const RULES: EquivalenceRule[] = [githubRawToBlob, githubBlobToRaw];

/**
 * Every URL a reviewer would accept as "the same resource" as the one given —
 * never including the input itself. Empty when no rule matches.
 */
export function equivalentUrls(requested: string): string[] {
	let parsed: URL;
	try {
		parsed = new URL(requested);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const rule of RULES) {
		const match = rule.counterpart(parsed);
		if (match) out.push(match);
	}
	return out;
}
