/**
 * The allowlisted proxy to the paseo daemon, for the surfaces the browser may use.
 *
 * This is the gateway forwarder's discipline applied to a different upstream:
 * the allowlist is the security property, not tidiness. A path forwarded
 * blindly would hand the browser the deployment's whole daemon credential —
 * attached server-side in `codeDaemon.ts`, never reaching the page — applied
 * to any daemon endpoint it can name. So the daemon's v1 paths are
 * enumerated per method, and anything else is a 404 rather than a proxied
 * request.
 *
 * Coded against paseo daemon API v1 (see `PASEO_API_VERSION`): workspaces,
 * agents, sessions, messages, permissions and diff. The daemon persists
 * sessions and worktrees; Cerea persists only pairing rows and proxies live
 * state — there is deliberately no second agent store here, so there is
 * nothing to sync, only to relay.
 *
 * Deliberately NOT forwarded, and why:
 * - `v1/agents/{id}/timeline/stream`: the SSE bridge
 *   (`agents/[id]/stream`) owns the only subscription. A browser-direct
 *   stream would bypass the pairing scope the bridge enforces, and two
 *   subscribers would split the daemon's log cursor between them.
 * - any pairing/enroll hook: Cerea brokers pairing itself (`devices`,
 *   `enroll`) because the relay is identity-blind.
 *
 * Multi-device routing is the known stub: every call here goes to the one
 * configured `CODE_DAEMON_URL`, whatever device is selected. Per-device
 * daemon addresses, keyed off the pairing row's `daemonId`, land when the
 * relay topology is decided — until then a deployment serves one daemon.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { daemonBaseUrl, daemonHeaders, relayDaemon } from "$lib/server/codeDaemon";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { logger } from "$lib/server/logger";
import { PASEO_API_VERSION } from "$lib/server/codeDaemon";

const ID = "[A-Za-z0-9_.:~-]+";

const ALLOWLIST: Array<{ method: "GET" | "POST" | "DELETE"; pattern: RegExp }> = [
	{ method: "GET", pattern: /^v1\/workspaces$/ },
	{ method: "GET", pattern: new RegExp(`^v1/workspaces/${ID}$`) },
	{ method: "GET", pattern: new RegExp(`^v1/workspaces/${ID}/agents$`) },
	{ method: "GET", pattern: /^v1\/agents$/ },
	{ method: "POST", pattern: /^v1\/agents$/ },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}$`) },
	{ method: "DELETE", pattern: new RegExp(`^v1/agents/${ID}$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/messages$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/messages$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/timeline$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/permissions/${ID}$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/diff$`) },
];

async function forward(
	event: Parameters<RequestHandler>[0],
	method: "GET" | "POST" | "DELETE"
): Promise<Response> {
	requireCodeAgents(event.locals);
	const path = event.params.path ?? "";
	if (!ALLOWLIST.some((rule) => rule.method === method && rule.pattern.test(path))) {
		// 404 rather than 403: this forwarder does not offer that path at
		// all, and "forbidden" would imply it might with other credentials.
		error(404, "Not available through this endpoint.");
	}

	const url = `${daemonBaseUrl()}/${path}${event.url.search}`;
	const headers: Record<string, string> = daemonHeaders();
	let body: BodyInit | undefined;
	if (method === "POST") {
		headers["content-type"] = event.request.headers.get("content-type") ?? "application/json";
		body = await event.request.text();
	}

	try {
		const response = await event.fetch(url, { method, headers, body });
		const advertised = response.headers.get("x-paseo-version");
		if (advertised && advertised !== PASEO_API_VERSION) {
			// A version skew would fail in ways neither side describes well;
			// refuse loudly rather than relay a conversation between strangers.
			logger.error({ path, advertised }, "paseo daemon version mismatch");
			error(502, "The coding-agent daemon speaks an unsupported API version.");
		}
		return await relayDaemon(response);
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error({ err, path }, "paseo daemon forward failed");
		error(502, "The coding-agent daemon could not be reached.");
	}
}

export const GET: RequestHandler = (event) => forward(event, "GET");
export const POST: RequestHandler = (event) => forward(event, "POST");
export const DELETE: RequestHandler = (event) => forward(event, "DELETE");
