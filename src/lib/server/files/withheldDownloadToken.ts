import { createHash, randomBytes } from "node:crypto";
import { error } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";

/**
 * The owner's download of a file a privacy rule withheld (C99c).
 *
 * A withheld file is never read by the model, a tool, an MCP server or the
 * sandbox. Its owner may still save their own bytes, but only after an explicit
 * click, through two requests:
 *
 *   1. `POST .../withheld-download` mints a token. It must be a same-origin
 *      `fetch` that carries `GESTURE_HEADER`: a custom header makes any
 *      cross-origin caller (a preview iframe, another site) fail its CORS
 *      preflight, and the browser's own `Sec-Fetch-Site` must say `same-origin`.
 *      The in-browser code sandbox runs same-origin with the session cookie, but
 *      its network gate (`utils/execution/gate.ts`) lets it fetch nothing
 *      outside `<base>/pyodide/`, so this route is unreachable from it; the
 *      server sandbox has no cookies. The token goes only to the page that
 *      clicked: never to a message, a tool result or a log.
 *   2. `GET .../withheld-download?token=` serves the bytes once.
 *
 * The token is 256 random bits, valid `TTL_MS`, single use (deleted on the
 * first try, success or not), bound to the user (or anonymous session), the
 * conversation and the file. Only its SHA-256 is stored.
 */

export const GESTURE_HEADER = "x-cerea-withheld-download";
export const GESTURE_VALUE = "click";
export const TTL_MS = 60_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Throws a 403 unless the request is a same-origin `fetch` that a page script
 * of this app made on purpose. Browsers set `Sec-Fetch-*` themselves and a
 * script cannot override them; a client that sends none is refused too.
 */
export function assertGestureRequest(request: Request): void {
	if (request.headers.get(GESTURE_HEADER) !== GESTURE_VALUE) {
		error(403, "This download must be started from the file's card.");
	}
	if (request.headers.get("sec-fetch-site") !== "same-origin") {
		error(403, "This download must be started from this page.");
	}
	if (request.headers.get("sec-fetch-dest") !== "empty") {
		error(403, "This download must be started from this page.");
	}
	const origin = request.headers.get("origin");
	if (origin) {
		const valid = [
			new URL(request.url).host,
			...(config.PUBLIC_ORIGIN ? [new URL(config.PUBLIC_ORIGIN).host] : []),
		];
		let host = "";
		try {
			host = new URL(origin).host;
		} catch {
			/* an unparsable origin is not valid */
		}
		if (!valid.includes(host)) error(403, "Invalid origin for this request.");
	}
}

/** Mint a token for this owner, conversation and file. Returns the secret, once. */
export async function mintWithheldDownloadToken(args: {
	owner: string;
	conversationId: ObjectId;
	sha256: string;
}): Promise<string> {
	const token = randomBytes(32).toString("base64url");
	const now = new Date();
	await collections.withheldDownloadTokens.insertOne({
		tokenHash: hash(token),
		owner: args.owner,
		conversationId: args.conversationId,
		sha256: args.sha256,
		createdAt: now,
		expiresAt: new Date(now.getTime() + TTL_MS),
	} as never);
	return token;
}

/**
 * Spend a token: the row is deleted by the first attempt whatever its result,
 * so a token cannot be probed. Refuses (403) an unknown, spent or expired
 * token, and one minted for another user, conversation or file.
 */
export async function consumeWithheldDownloadToken(
	token: string | null,
	expected: { owner: string; conversationId: ObjectId; sha256?: string }
): Promise<{ sha256: string }> {
	if (!token) error(403, "A download token is required.");
	const row = (
		await collections.withheldDownloadTokens.findOneAndDelete({ tokenHash: hash(token) })
	).value;
	if (!row) error(403, "This download link was already used or has expired.");
	if (row.expiresAt.getTime() < Date.now()) error(403, "This download link has expired.");
	if (
		row.owner !== expected.owner ||
		!row.conversationId.equals(expected.conversationId) ||
		(expected.sha256 !== undefined && row.sha256 !== expected.sha256)
	) {
		error(403, "This download link is not for you.");
	}
	return { sha256: row.sha256 };
}
