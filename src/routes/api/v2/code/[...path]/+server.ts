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
	{ method: "POST", pattern: new RegExp(`^v1/workspaces/${ID}/title$`) },
	{ method: "GET", pattern: new RegExp(`^v1/workspaces/${ID}/agents$`) },
	{ method: "GET", pattern: /^v1\/agents$/ },
	{ method: "POST", pattern: /^v1\/agents$/ },
	{ method: "GET", pattern: /^v1\/providers$/ },
	{ method: "GET", pattern: new RegExp(`^v1/providers/${ID}/modes$`) },
	{ method: "GET", pattern: new RegExp(`^v1/providers/${ID}/models$`) },
	{ method: "GET", pattern: new RegExp(`^v1/providers/${ID}/features$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}$`) },
	{ method: "DELETE", pattern: new RegExp(`^v1/agents/${ID}$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/messages$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/messages$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/timeline$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/subagents$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/subagents/${ID}/timeline$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/permissions/${ID}$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/mode$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/model$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/feature$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/cancel$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/name$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/archive$`) },
	{ method: "POST", pattern: new RegExp(`^v1/workspaces/${ID}/archive$`) },
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

	if (path === "v1/providers") {
		return superjsonResponse({ providers: await link.listProviders() });
	}

	// The two live option lists for the composer's pills: the provider's
	// modes (paseo's permission vocabulary) and models, exactly as the
	// daemon defines them. The provider id names the daemon's provider —
	// the ID regex guards the path, the daemon answers the rest.
	const modesMatch = new RegExp(`^v1/providers/(${ID})/modes$`).exec(path);
	if (modesMatch) {
		return superjsonResponse({ modes: await link.listProviderModes(modesMatch[1]) });
	}

	const modelsMatch = new RegExp(`^v1/providers/(${ID})/models$`).exec(path);
	if (modelsMatch) {
		return superjsonResponse({ models: await link.listProviderModels(modelsMatch[1]) });
	}

	// The third live option list, beside modes and models: the provider's
	// features — the toggles a person can flip on an agent (opencode's
	// auto-accept). The daemon resolves them per working directory, so
	// `cwd` is required here the way it is in the daemon's own draft
	// config; the agent's mode and model ride along when known so the
	// draft mirrors the config the agent actually runs. The list carries
	// what EXISTS and what it is called; the agent snapshot (below) is
	// where a live value comes from.
	const featuresMatch = new RegExp(`^v1/providers/(${ID})/features$`).exec(path);
	if (featuresMatch) {
		const cwd = event.url.searchParams.get("cwd");
		if (!cwd?.trim()) {
			error(400, "A working directory is required: pass ?cwd=.");
		}
		const modeId = event.url.searchParams.get("modeId") ?? undefined;
		const model = event.url.searchParams.get("model") ?? undefined;
		const features = await link.listProviderFeatures({
			provider: decodeURIComponent(featuresMatch[1]),
			cwd,
			...(modeId ? { modeId } : {}),
			...(model ? { model } : {}),
		});
		return superjsonResponse({ features });
	}

	const agentMatch = new RegExp(`^v1/agents/(${ID})$`).exec(path);
	if (agentMatch) {
		// The open screen's snapshot: the session, the features the agent
		// itself reports (the auto-accept toggle's live value — the
		// provider's list above only says what exists), and the cwd the
		// feature query requires. All three leave together so the pills
		// and the toggle label from one read.
		const detail = await link.getAgentDetail(decodeURIComponent(agentMatch[1]));
		return superjsonResponse({
			agent: detail.session,
			features: detail.features,
			cwd: detail.cwd,
		});
	}

	const messagesMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messagesMatch) {
		const timeline = await link.fetchTimeline(decodeURIComponent(messagesMatch[1]));
		return superjsonResponse({
			updates: timeline.entries.flatMap(timelineEntryToUpdate),
		});
	}

	const timelineMatch = new RegExp(`^v1/agents/(${ID})/timeline$`).exec(path);
	if (timelineMatch) {
		const timeline = await link.fetchTimeline(decodeURIComponent(timelineMatch[1]));
		return superjsonResponse({
			updates: timeline.entries.flatMap(timelineEntryToUpdate),
		});
	}

	// The subagent surfaces, polled by the transcript on turn boundaries
	// (never on an interval): the roster is the authority for each
	// subagent's title/status/subtitle, and the second route serves the
	// transcript a card expands to, through the same timeline translation
	// the parent's routes use. Both are reads keyed by the path alone —
	// there is no body to validate.
	const subagentsMatch = new RegExp(`^v1/agents/(${ID})/subagents$`).exec(path);
	if (subagentsMatch) {
		const subagents = await link.listSubagents(decodeURIComponent(subagentsMatch[1]));
		return superjsonResponse({ subagents });
	}

	const subagentTimelineMatch = new RegExp(`^v1/agents/(${ID})/subagents/(${ID})/timeline$`).exec(
		path
	);
	if (subagentTimelineMatch) {
		const timeline = await link.fetchSubagentTimeline(
			decodeURIComponent(subagentTimelineMatch[1]),
			decodeURIComponent(subagentTimelineMatch[2])
		);
		return superjsonResponse({
			updates: timeline.rows.flatMap(timelineEntryToUpdate),
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
});

// The mode/model switches apply live to the open agent — the composer's
// pills carry them, not the send. A mode the provider refused comes back
// as a notice string (null when applied silently); a model switch answers
// void, so there is nothing to carry but ok.
const modeSchema = z.object({
	modeId: z.string().trim().min(1).max(120),
});

const modelSchema = z.object({
	modelId: z.string().trim().min(1).max(200).nullable(),
});

const titleSchema = z.object({
	title: z.string().trim().min(1).max(120).nullable(),
});

// The stop control. The daemon takes the request, not the outcome: the
// transcript's own stream carries the turn's end (`turn_canceled`) and the
// denied resolutions of any outstanding permission requests, so this
// response is only the POST's receipt. Any body — or none — is accepted:
// the path fully names the act.
const cancelSchema = z.unknown();

const featureSchema = z.object({
	featureId: z.string().trim().min(1).max(120),
	value: z.boolean(),
});

const createSchema = z.object({
	cwd: z.string().trim().min(1).max(1024),
	provider: z.string().trim().min(1).max(64).default("opencode"),
	posture: z.enum(["plan", "write"]).default("plan"),
	title: z.string().trim().max(120).optional(),
	workspaceId: z.string().trim().min(1).max(120).optional(),
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
		if (!parsed.success) error(400, "Expected { cwd, provider?, posture?, title?, workspaceId? }.");
		return superjsonResponse({ agent: await link.createAgent(parsed.data) });
	}

	const messageMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messageMatch) {
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { text }.");
		await link.sendAgentMessage(decodeURIComponent(messageMatch[1]), parsed.data.text);
		return superjsonResponse({ ok: true });
	}

	// The live mode/model switches, the composer's pills. The mode answers
	// with the provider's notice (null when applied without comment); the
	// model answers void. Both leave the truth to the next snapshot read.
	const modeMatch = new RegExp(`^v1/agents/(${ID})/mode$`).exec(path);
	if (modeMatch) {
		const parsed = modeSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { modeId }.");
		const notice = await link.setAgentMode(decodeURIComponent(modeMatch[1]), parsed.data.modeId);
		return superjsonResponse({ ok: true, notice });
	}

	const modelMatch = new RegExp(`^v1/agents/(${ID})/model$`).exec(path);
	if (modelMatch) {
		const parsed = modelSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { modelId: string | null }.");
		await link.setAgentModel(decodeURIComponent(modelMatch[1]), parsed.data.modelId);
		return superjsonResponse({ ok: true });
	}

	// The stop control: interrupt the agent's live turn. Where a permission
	// request is outstanding the daemon ends the turn AND resolves the
	// request denied, so the fold's existing resolution path settles the
	// approval card — no hanging card, no hanging dots, and this endpoint
	// has nothing to say about either.
	const cancelMatch = new RegExp(`^v1/agents/(${ID})/cancel$`).exec(path);
	if (cancelMatch) {
		cancelSchema.parse(body);
		await link.cancelAgent(decodeURIComponent(cancelMatch[1]));
		return superjsonResponse({ ok: true });
	}

	// One provider feature flipped live on the open agent — the auto-accept
	// toggle and its kind. The daemon answers accepted/error; a refusal
	// throws here as a 502 and the pill keeps the value the snapshot
	// reported, because the flip is claimed only when the next snapshot
	// read agrees (the mode pill's discipline).
	const featureMatch = new RegExp(`^v1/agents/(${ID})/feature$`).exec(path);
	if (featureMatch) {
		const parsed = featureSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { featureId, value } with a boolean value.");
		await link.setAgentFeature(
			decodeURIComponent(featureMatch[1]),
			parsed.data.featureId,
			parsed.data.value
		);
		return superjsonResponse({ ok: true });
	}

	// The agent rename — the daemon's updateAgent name, answering { ok }.
	// The tree redraws from the daemon's next listing, not from the string
	// that was typed (same discipline as the workspace title above).
	const agentNameMatch = new RegExp(`^v1/agents/(${ID})/name$`).exec(path);
	if (agentNameMatch) {
		const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(body);
		if (!parsed.success) error(400, "Expected { name }.");
		await link.renameAgent(decodeURIComponent(agentNameMatch[1]), parsed.data.name);
		return superjsonResponse({ ok: true });
	}

	// The workspace rename — the daemon's own setWorkspaceTitle, answering
	// the title as the daemon recorded it.
	const titleMatch = new RegExp(`^v1/workspaces/(${ID})/title$`).exec(path);
	if (titleMatch) {
		const parsed = titleSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { title: string | null }.");
		const title = await link.renameWorkspace(decodeURIComponent(titleMatch[1]), parsed.data.title);
		return superjsonResponse({ title });
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

	// The two removals. Both are the daemon's own archive operations under
	// their user-facing names, fully named by the path — there is no body to
	// validate — and both answer { ok: true } rather than the daemon's
	// payload, whose shape is none of the browser's business (ADR 0085).
	const archiveAgentMatch = new RegExp(`^v1/agents/(${ID})/archive$`).exec(path);
	if (archiveAgentMatch) {
		await link.archiveAgentSession(decodeURIComponent(archiveAgentMatch[1]));
		return superjsonResponse({ ok: true });
	}

	const archiveWorkspaceMatch = new RegExp(`^v1/workspaces/(${ID})/archive$`).exec(path);
	if (archiveWorkspaceMatch) {
		await link.archiveWorkspace(decodeURIComponent(archiveWorkspaceMatch[1]));
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
