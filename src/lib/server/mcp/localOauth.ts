/**
 * Signing in to a local http connector from the chat (ADR 0102, PROTOCOL.md §10.5).
 *
 * The machine does the OAuth: it reads the server's metadata, registers a client, keeps the PKCE
 * verifier and, when the provider redirects back, exchanges the code and stores the tokens. Cerea
 * only carries the browser there and back, so **no token and no verifier ever reaches Cerea**.
 *
 * What Cerea keeps is a short-lived record keyed by the `state` the machine put in the
 * authorization URL: which person, in which session, for which device and server. The callback
 * accepts a state only from that person's session, once, within ten minutes, and only while the
 * person still owns the paired device. Anything else is refused before the machine is asked.
 */

import { ObjectId } from "mongodb";
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { isMachineOnline, MachineLink } from "$lib/server/code/machines";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { OpError } from "$lib/types/machineProtocol";
import { localConnectorId, parseLocalConnectorId } from "./localUrl";
import { resetLocalListCache } from "./local";

/** How long a person has to finish the provider's consent screen. */
export const LOCAL_OAUTH_TTL_MS = 10 * 60_000;

export class LocalOauthError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 502,
		/** A short code the callback puts in the redirect; the message is for logs and the API. */
		readonly detail: "unknown" | "offline" | "expired" | "refused" | "machine",
		message: string
	) {
		super(message);
		this.name = "LocalOauthError";
	}
}

/** Cerea's own callback, from `PUBLIC_ORIGIN` and not from the request: an address that varied
 * with the `Host` header would let a forged one move where a code is delivered. */
export function localOauthRedirectUri(): string {
	const origin = config.PUBLIC_ORIGIN;
	if (!origin) {
		throw new Error("PUBLIC_ORIGIN is not set, so the sign-in redirect address cannot be built");
	}
	return `${origin.replace(/\/$/, "")}${base}/api/v2/local-connectors/oauth/callback`;
}

/** A path inside this app, or the app's root: the only places a callback sends a browser. */
export function safeNext(next: string | null | undefined): string {
	if (next && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\")) return next;
	return `${base}/`;
}

async function ownedPairedDevice(userId: ObjectId, deviceId: string) {
	const device = await collections.codeDevices.findOne({
		_id: new ObjectId(deviceId),
		userId,
		status: "paired",
	});
	// Not the caller's and not there read the same: ids stay unguessable.
	if (!device)
		throw new LocalOauthError(404, "unknown", "No such machine is paired to this account.");
	return device;
}

function mapOpError(err: unknown, machineName: string): LocalOauthError {
	if (err instanceof LocalOauthError) return err;
	if (err instanceof OpError) {
		if (err.code === "unavailable") {
			return new LocalOauthError(
				502,
				"machine",
				`${machineName} could not do that: ${err.message}`
			);
		}
		if (err.code === "not_found") return new LocalOauthError(404, "unknown", err.message);
		if (err.code === "invalid") return new LocalOauthError(400, "refused", err.message);
		return new LocalOauthError(502, "machine", err.message);
	}
	return new LocalOauthError(502, "machine", err instanceof Error ? err.message : String(err));
}

/** Begin a sign-in: ask the machine for the authorization URL and remember who asked. */
export async function startLocalSignIn(options: {
	userId: ObjectId;
	sessionId: string;
	connectorId: string;
	next?: string | null;
}): Promise<{ authorizeUrl: string }> {
	if (!localConnectorsEnabled()) throw new LocalOauthError(404, "unknown", "Not enabled.");
	const ref = parseLocalConnectorId(options.connectorId);
	if (!ref) throw new LocalOauthError(404, "unknown", "No such local connector.");
	const device = await ownedPairedDevice(options.userId, ref.deviceId);
	if (!isMachineOnline(ref.deviceId)) {
		throw new LocalOauthError(
			409,
			"offline",
			`${device.name} is offline. Start galopin there first.`
		);
	}

	let authorizationUrl: string;
	try {
		({ authorizationUrl } = await new MachineLink(ref.deviceId).mcpLogin({
			server: ref.server,
			redirectUri: localOauthRedirectUri(),
		}));
	} catch (err) {
		throw mapOpError(err, device.name);
	}

	let target: URL;
	try {
		target = new URL(authorizationUrl);
	} catch {
		throw new LocalOauthError(502, "machine", "The machine answered an address that is not a URL.");
	}
	const state = target.searchParams.get("state");
	if (!["https:", "http:"].includes(target.protocol) || !state) {
		throw new LocalOauthError(
			502,
			"machine",
			"The machine's sign-in address is not usable (no http(s) scheme, or no state)."
		);
	}

	await collections.localConnectorOauth.insertOne({
		_id: new ObjectId(),
		state,
		userId: options.userId,
		sessionId: options.sessionId,
		deviceId: ref.deviceId,
		server: ref.server,
		next: safeNext(options.next),
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + LOCAL_OAUTH_TTL_MS),
	});
	return { authorizeUrl: target.toString() };
}

/**
 * Finish a sign-in: consume the state (only this person's, in this session, once), check the
 * person still owns the paired device, and hand the machine the code. Resolves with where to
 * land and which connector it was.
 */
export async function completeLocalSignIn(options: {
	userId: ObjectId;
	sessionId: string;
	state: string;
	code: string;
}): Promise<{ next: string; connectorId: string; machineName: string; server: string }> {
	if (!localConnectorsEnabled()) throw new LocalOauthError(404, "unknown", "Not enabled.");
	// One step, and filtered on the caller: a state held by somebody else (or another session)
	// matches nothing and is left alone for its owner; a replayed one finds nothing at all.
	const result = await collections.localConnectorOauth.findOneAndDelete({
		state: options.state,
		userId: options.userId,
		sessionId: options.sessionId,
	});
	const pending = result?.value ?? null;
	if (!pending) {
		logger.warn({ state: options.state.slice(0, 8) }, "mcp_local_oauth_state_refused");
		throw new LocalOauthError(
			400,
			"expired",
			"This sign-in has expired, was already used, or was not started here."
		);
	}
	if (pending.expiresAt.getTime() < Date.now()) {
		throw new LocalOauthError(400, "expired", "This sign-in expired before it was completed.");
	}
	const device = await ownedPairedDevice(options.userId, pending.deviceId);
	if (!isMachineOnline(pending.deviceId)) {
		throw new LocalOauthError(
			409,
			"offline",
			`${device.name} went offline before the sign-in finished.`
		);
	}
	try {
		await new MachineLink(pending.deviceId).mcpLoginComplete({
			server: pending.server,
			code: options.code,
			state: options.state,
		});
	} catch (err) {
		throw mapOpError(err, device.name);
	}
	// The server was `needs-login` in the list; it is `ready` now.
	resetLocalListCache(pending.deviceId);
	return {
		next: pending.next,
		connectorId: localConnectorId(pending.deviceId, pending.server),
		machineName: device.name,
		server: pending.server,
	};
}
