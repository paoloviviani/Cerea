/**
 * What may be shown of a connector's address, and what to warn about in one.
 *
 * An address can carry a credential in its query string (`?apiKey=...`) or in
 * userinfo (`https://user:pass@host/`). The administrator who set it up may
 * see it; everybody else, and every log line, gets the address without them.
 */

/** The address without userinfo, query string or fragment. Unparseable input is returned as it came. */
export function stripAddress(address: string): string {
	try {
		const parsed = new URL(address);
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return address;
	}
}

const CREDENTIAL_PARAM =
	/^(api[-_]?key|key|token|access[-_]?token|auth|secret|password|pwd|sig|signature)$/i;

/** Query parameters of an address whose names look like a credential. */
export function credentialLikeParams(address: string): string[] {
	try {
		return [...new URL(address).searchParams.keys()].filter((name) => CREDENTIAL_PARAM.test(name));
	} catch {
		return [];
	}
}
