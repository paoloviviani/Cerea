/**
 * How a local connector (a server on one of the person's own machines, ADR 0102) is named, in
 * the two places a name has to travel: the chat's connector selection, and the server config
 * the MCP client pool keys on.
 *
 * - the **connector id** is `local:<deviceId>:<server>`, which cannot collide with a configured
 *   or user connector (those are 24-hex Mongo ids) and survives the selection plumbing as an
 *   opaque string;
 * - the **server url** is `machine://<deviceId>/<server>?user=<userId>`: the one string every
 *   `McpServerConfig` already carries, so a local server rides tool listing, the pool, approval
 *   cards, elicitation, sub-agents and schedules without any of them learning a new field.
 *   The pool key is therefore (person, device, server) by construction.
 *
 * The url scheme is **not trusted**: a browser can send any custom server url, so the opener
 * (`localTransport.ts`) re-checks that the person named in it owns the paired device, and
 * `withoutLocalUrls` strips the scheme from anything a browser supplied.
 */

/** A server name as `mcp.json` allows it (PROTOCOL.md §10.1). */
export const LOCAL_SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/;

export const LOCAL_URL_SCHEME = "machine:";

export function localConnectorId(deviceId: string, server: string): string {
	return `local:${deviceId}:${server}`;
}

export interface LocalServerRef {
	deviceId: string;
	server: string;
}

export function parseLocalConnectorId(id: string): LocalServerRef | null {
	const match = /^local:([0-9a-f]{24}):(.+)$/.exec(id);
	if (!match || !LOCAL_SERVER_NAME.test(match[2])) return null;
	return { deviceId: match[1], server: match[2] };
}

export function isLocalConnectorId(id: string): boolean {
	return id.startsWith("local:");
}

export function localServerUrl(userId: string, deviceId: string, server: string): string {
	return `machine://${deviceId}/${server}?user=${userId}`;
}

export function isLocalServerUrl(url: string): boolean {
	return url.toLowerCase().startsWith("machine:");
}

export function parseLocalServerUrl(
	url: string
): { userId: string; deviceId: string; server: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== LOCAL_URL_SCHEME) return null;
	const deviceId = parsed.hostname;
	const server = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
	const userId = parsed.searchParams.get("user") ?? "";
	if (!OBJECT_ID.test(deviceId) || !OBJECT_ID.test(userId) || !LOCAL_SERVER_NAME.test(server)) {
		return null;
	}
	return { userId, deviceId, server };
}

/** Drop what a browser sent that names a local server: only the server's own selection
 * resolution (`resolveLocalSelection`) may produce such a url. */
export function withoutLocalUrls<T extends { url: string }>(servers: T[]): T[] {
	return servers.filter((server) => !isLocalServerUrl(server.url));
}
