/**
 * The proxy to a paired person's daemon, for the surfaces the browser may
 * use — now routed per device through the relay.
 *
 * This is the gateway forwarder's discipline applied to a different
 * upstream, with the allowlist promoted from path patterns to operations:
 * each allowed browser path maps to exactly one typed SDK call (ADR 0085 —
 * the daemon's control surface is its WebSocket session protocol, not a
 * REST API). The browser still never talks to the daemon, and never picks
 * the upstream: every call carries `?device=`, the row is checked against
 * the caller before anything dials, and the connection itself is the
 * per-device relay link in `codeDaemon.ts`.
 *
 * Deliberately NOT offered, and why:
 * - any timeline stream: the SSE bridge (`agents/[id]/stream`) owns the
 *   subscription; a browser-direct stream would bypass the pairing scope
 *   the bridge enforces.
 * - any pairing/enroll hook: Cerea brokers pairing itself (`devices`,
 *   `enroll`) because the relay is identity-blind.
 * - everything else the daemon can do (terminals, worktree management,
 *   checkout operations, daemon config): the panel drives agents, not
 *   machines.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { linkForDevice, toFileChanges } from "$lib/server/codeDaemon";
import { timelineEntryToUpdate } from "$lib/server/codeTimeline";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";

const ID = "[A-Za-z0-9_.:~-]+";

const RULES: Array<{ method: "GET" | "POST" | "DELETE"; pattern: RegExp }> = [
	{ method: "GET", pattern: /^v1\/workspaces$/ },
	{ method: "POST", pattern: /^v1\/workspaces$/ },
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

async function readJson(request: Request): Promise<unknown> {
	return request.json().catch(() => null);
}

export const GET: RequestHandler = async (event) => {
	requireCodeAgents(event.locals);
	const path = event.params.path ?? "";
	const method = "GET";
	if (!RULES.some((rule) => rule.method === method && rule.pattern.test(path))) {
		// 404 rather than 403: this proxy does not offer that path at all,
		// and "forbidden" would imply it might with other credentials.
		error(404, "Not available through this endpoint.");
	}
	const link = await linkForDevice(event.locals, event.url.searchParams.get("device"));

	if (path === "v1/workspaces") {
		return superjsonResponse({ workspaces: await link.listWorkspaces() });
	}

	const workspaceMatch = /^v1\/workspaces\/([^/]+)$/.exec(path);
	if (workspaceMatch) {
		return superjsonResponse({
			workspace: await link.getWorkspace(decodeURIComponent(workspaceMatch[1])),
		});
	}

	const workspaceAgentsMatch = /^v1\/workspaces\/([^/]+)\/agents$/.exec(path);
	if (workspaceAgentsMatch) {
		const workspace = await link.getWorkspace(decodeURIComponent(workspaceAgentsMatch[1]));
		return superjsonResponse({ agents: await link.listAgents(workspace.id) });
	}

	if (path === "v1/agents") {
		return superjsonResponse({ agents: await link.listAgents() });
	}

	const agentMatch = new RegExp(`^v1/agents/(${ID})$`).exec(path);
	if (agentMatch) {
		return superjsonResponse({ agent: await link.getAgent(decodeURIComponent(agentMatch[1])) });
	}

	const messagesMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messagesMatch) {
		const timeline = await link.fetchTimeline(decodeURIComponent(messagesMatch[1]));
		return superjsonResponse({
			updates: timeline.entries.map(timelineEntryToUpdate).filter((u) => u !== null),
		});
	}

	const timelineMatch = new RegExp(`^v1/agents/(${ID})/timeline$`).exec(path);
	if (timelineMatch) {
		const timeline = await link.fetchTimeline(decodeURIComponent(timelineMatch[1]));
		return superjsonResponse({
			updates: timeline.entries.map(timelineEntryToUpdate).filter((u) => u !== null),
		});
	}

	const diffMatch = new RegExp(`^v1/agents/(${ID})/diff$`).exec(path);
	if (diffMatch) {
		const diff = await link.fetchDiff(decodeURIComponent(diffMatch[1]));
		return superjsonResponse({ files: toFileChanges(diff) });
	}

	error(404, "Not available through this endpoint.");
};

const messageSchema = z.object({
	text: z.string().trim().min(1).max(16_000),
	provider: z.string().trim().min(1).max(64).default("opencode"),
	posture: z.enum(["plan", "write"]).default("plan"),
});

const createSchema = z.object({
	cwd: z.string().trim().min(1).max(1024),
	provider: z.string().trim().min(1).max(64).default("opencode"),
	posture: z.enum(["plan", "write"]).default("plan"),
	title: z.string().trim().max(120).optional(),
});

const workspaceSchema = z.object({
	// An absolute directory on the daemon's machine (a checkout the person
	// can see there). Relative paths would resolve against whatever cwd the
	// daemon process was born with — unguessable from here, so refused.
	path: z
		.string()
		.trim()
		.min(1)
		.max(1024)
		.refine(
			(p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p),
			"Expected an absolute path on the daemon's machine."
		),
	title: z.string().trim().max(120).optional(),
});

export const POST: RequestHandler = async (event) => {
	requireCodeAgents(event.locals);
	const path = event.params.path ?? "";
	const method = "POST";
	if (!RULES.some((rule) => rule.method === method && rule.pattern.test(path))) {
		error(404, "Not available through this endpoint.");
	}
	const link = await linkForDevice(event.locals, event.url.searchParams.get("device"));
	const body = await readJson(event.request);

	if (path === "v1/workspaces") {
		const parsed = workspaceSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { path, title? } with an absolute path.");
		return superjsonResponse({ workspace: await link.createWorkspace(parsed.data) });
	}

	const createMatch = /^v1\/agents$/.test(path);
	if (createMatch) {
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { cwd, provider?, posture?, title? }.");
		return superjsonResponse({ agent: await link.createAgent(parsed.data) });
	}

	const messageMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messageMatch) {
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { text, provider?, posture? }.");
		await link.sendAgentMessage(
			decodeURIComponent(messageMatch[1]),
			parsed.data.text,
			parsed.data.posture
		);
		return superjsonResponse({ ok: true });
	}

	const permissionMatch = new RegExp(`^v1/agents/(${ID})/permissions/(${ID})$`).exec(path);
	if (permissionMatch) {
		const parsed = z.object({ decision: z.enum(["approve", "deny"]) }).safeParse(body);
		if (!parsed.success) error(400, "Expected { decision: 'approve' | 'deny' }.");
		await link.respondPermission(
			decodeURIComponent(permissionMatch[1]),
			decodeURIComponent(permissionMatch[2]),
			parsed.data.decision
		);
		return superjsonResponse({ ok: true });
	}

	error(404, "Not available through this endpoint.");
};

export const DELETE: RequestHandler = async (event) => {
	requireCodeAgents(event.locals);
	const path = event.params.path ?? "";
	const agentMatch = new RegExp(`^v1/agents/(${ID})$`).exec(path);
	if (!agentMatch) {
		error(404, "Not available through this endpoint.");
	}
	const link = await linkForDevice(event.locals, event.url.searchParams.get("device"));
	await link.deleteAgent(decodeURIComponent(agentMatch[1]));
	return superjsonResponse({ ok: true });
};
