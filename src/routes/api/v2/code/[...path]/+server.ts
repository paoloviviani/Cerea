/**
 * The proxy to a paired person's machine, for the surfaces the browser may
 * use — routed per device through the in-process machine registry
 * (`$lib/server/code/machines.ts`) instead of a relay-hopped daemon.
 *
 * Same discipline as before: each allowed browser path maps to exactly one
 * typed op (`MachineLink`, spec §6), the browser never talks to the machine
 * directly, and every call is scoped to a device row owned by
 * `locals.user` and `status: "paired"` (`getPairedDevice`, C6).
 *
 * The wire vocabulary changed underneath (workspace/session/backend ops
 * instead of paseo's agent RPCs), but this route keeps the URLs and response
 * shapes `$lib/codeApi.ts` already expects — an "agent" in the UI is a
 * `Session`; the mapping functions below are the seam.
 *
 * Deliberately NOT offered, and why:
 * - any timeline stream: the SSE bridge (`agents/[id]/stream`) owns the
 *   subscription and calls `session.sync`/events directly.
 * - any pairing/enroll hook: pairing happens on connect (`machines.ts`), and
 *   confirm/reject/revoke live in `devices/+server.ts`.
 * - the `messages`/`timeline` GET routes the old forwarder carried: they were
 *   byte-identical dead code (O8) with no caller in `codeApi.ts`.
 * - everything else a machine can do beyond one backend's sessions
 *   (workspace roots outside policy, raw backend config): the panel drives
 *   sessions, not machines.
 */

import { randomUUID } from "node:crypto";
import { error, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { MachineLink } from "$lib/server/code/machines";
import { getPairedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { OpError, type Session, type Workspace } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";
import type {
	CodeAgentSession,
	CodeFileChange,
	CodeProviderMode,
	CodeProviderModel,
	CodeSubagent,
	CodeTurnState,
	CodeWorkspace,
} from "$lib/types/CodeAgent";
import type { CodeProviderFeature } from "$lib/codeApi";

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
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/subagents$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/subagents/${ID}/timeline$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/messages$`) },
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

/** Every `OpError` the machine can answer with, mapped to the HTTP status
 * the browser sees. `unavailable` covers both an offline machine (the
 * registry rejects instantly, R1) and a per-op deadline expiring. */
async function callOp<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof OpError) {
			switch (err.code) {
				case "not_found":
					error(404, err.message);
					break;
				case "invalid":
					error(400, err.message);
					break;
				case "forbidden":
					error(403, err.message);
					break;
				case "unsupported":
					error(404, err.message);
					break;
				default:
					error(502, err.message);
			}
		}
		throw err;
	}
}

async function resolveWorkspace(link: MachineLink, workspaceId: string): Promise<Workspace> {
	const { workspaces } = await callOp(() => link.workspaceList());
	const found = workspaces.find((workspace) => workspace.id === workspaceId);
	if (!found) error(404, "No such workspace on this machine.");
	return found;
}

function toWorkspace(workspace: Workspace): CodeWorkspace {
	return { id: workspace.id, name: workspace.name, path: workspace.path };
}

function toSession(session: Session): CodeAgentSession {
	let state: CodeTurnState;
	switch (session.status) {
		case "busy":
			state = session.pendingPermissions > 0 ? "waiting-permission" : "running";
			break;
		case "retry":
			state = "running";
			break;
		case "error":
			state = "error";
			break;
		default:
			state = "idle";
	}
	return {
		id: session.id,
		workspaceId: session.workspaceId,
		title: session.title,
		provider: session.backend,
		state,
		updatedAt: session.updatedAt,
		modeId: session.modeId,
		modelId: session.modelId,
	};
}

/** The single feature this deployment offers: opencode's auto-accept,
 * backed directly by `session.setAutoAccept` (spec §8). Absent — not
 * disabled, the existing UI has no tri-state for a toggle — when the
 * backend lacks the capability, or the machine's own policy vetoes it
 * (C4's veto: the panel cannot override a `denied` policy). */
function autoAcceptCatalog(device: CodeDevice, backendId: string): CodeProviderFeature[] {
	const backend = device.backends.find((b) => b.id === backendId);
	if (!backend?.capabilities.autoAccept) return [];
	if (device.policy.autoAccept === "denied") return [];
	return [{ id: "auto_accept", label: "Auto-accept", value: false }];
}

function autoAcceptLive(device: CodeDevice, session: Session): CodeProviderFeature[] {
	const backend = device.backends.find((b) => b.id === session.backend);
	if (!backend?.capabilities.autoAccept) return [];
	if (device.policy.autoAccept === "denied") return [];
	return [{ id: "auto_accept", label: "Auto-accept", value: session.autoAccept }];
}

function toSubagent(session: Session): CodeSubagent {
	const status: CodeSubagent["status"] =
		session.status === "error" ? "failed" : session.status === "idle" ? "completed" : "running";
	return {
		id: session.id,
		parentAgentId: session.parentId ?? "",
		parentSubagentId: null,
		provider: session.backend,
		title: session.title,
		description: null,
		status,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		toolCallId: null,
		cwd: null,
		subtitle: null,
	};
}

function toFileChanges(
	files: Array<{ path: string; before: string; after: string }>
): CodeFileChange[] {
	return files.map((file) => ({ path: file.path, oldText: file.before, newText: file.after }));
}

function requireJsonBody(request: Request): void {
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType !== "application/json") {
		error(400, "Expected Content-Type: application/json.");
	}
}

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
	const device = await getPairedDevice(event.locals, event.url.searchParams.get("device"));
	const deviceId = device._id.toString();
	const link = new MachineLink(deviceId);

	if (path === "v1/workspaces") {
		const { workspaces } = await callOp(() => link.workspaceList());
		return superjsonResponse({ workspaces: workspaces.map(toWorkspace) });
	}

	const workspaceMatch = /^v1\/workspaces\/([^/]+)$/.exec(path);
	if (workspaceMatch) {
		const workspace = await resolveWorkspace(link, decodeURIComponent(workspaceMatch[1]));
		return superjsonResponse({ workspace: toWorkspace(workspace) });
	}

	const workspaceAgentsMatch = /^v1\/workspaces\/([^/]+)\/agents$/.exec(path);
	if (workspaceAgentsMatch) {
		const workspaceId = decodeURIComponent(workspaceAgentsMatch[1]);
		await resolveWorkspace(link, workspaceId);
		const { sessions } = await callOp(() => link.sessionList({ workspaceId }));
		return superjsonResponse({ agents: sessions.map(toSession) });
	}

	if (path === "v1/agents") {
		const { sessions } = await callOp(() => link.sessionList());
		return superjsonResponse({ agents: sessions.map(toSession) });
	}

	if (path === "v1/providers") {
		const expired = device.credentialState === "expired";
		return superjsonResponse({
			providers: device.backends.map((backend) => ({
				id: backend.id,
				available: true,
				enrollmentExpired: expired,
			})),
		});
	}

	// The two live option lists for the composer's pills: the backend's
	// modes and models, exactly as the machine defines them. The provider
	// id in the path names the backend — the ID regex guards the path, the
	// machine answers the rest.
	const modesMatch = new RegExp(`^v1/providers/(${ID})/modes$`).exec(path);
	if (modesMatch) {
		const { modes } = await callOp(() => link.backendModes({ backend: modesMatch[1] }));
		const mapped: CodeProviderMode[] = modes.map((mode) => ({
			id: mode.id,
			label: mode.label,
			...(mode.description ? { description: mode.description } : {}),
		}));
		return superjsonResponse({ modes: mapped });
	}

	const modelsMatch = new RegExp(`^v1/providers/(${ID})/models$`).exec(path);
	if (modelsMatch) {
		const { models } = await callOp(() => link.backendModels({ backend: modelsMatch[1] }));
		const mapped: CodeProviderModel[] = models.map((model) => ({
			id: model.id,
			label: model.label,
			...(model.isDefault ? { isDefault: true } : {}),
		}));
		return superjsonResponse({ models: mapped });
	}

	// The third live option list, beside modes and models: this deployment's
	// one feature (auto-accept). `cwd`/`modeId`/`model` in the query string
	// are accepted for URL compatibility with the old per-draft negotiation
	// but no longer change the answer — the feature exists or it does not,
	// per the backend's capability and the machine's own policy (C4).
	const featuresMatch = new RegExp(`^v1/providers/(${ID})/features$`).exec(path);
	if (featuresMatch) {
		return superjsonResponse({
			features: autoAcceptCatalog(device, decodeURIComponent(featuresMatch[1])),
		});
	}

	const agentMatch = new RegExp(`^v1/agents/(${ID})$`).exec(path);
	if (agentMatch) {
		const sessionId = decodeURIComponent(agentMatch[1]);
		const { session } = await callOp(() => link.sessionGet({ sessionId }));
		const workspace = await resolveWorkspace(link, session.workspaceId).catch(() => null);
		return superjsonResponse({
			agent: toSession(session),
			features: autoAcceptLive(device, session),
			cwd: workspace?.path ?? "",
			enrollmentExpired: device.credentialState === "expired",
		});
	}

	// The subagent surfaces, polled by the transcript on turn boundaries
	// (never on an interval): the roster is session.children, and its own
	// transcript is the ordinary agent-stream history (`session.sync`),
	// mapped through the same `machineTimeline` the parent's stream uses.
	const subagentsMatch = new RegExp(`^v1/agents/(${ID})/subagents$`).exec(path);
	if (subagentsMatch) {
		const { sessions } = await callOp(() =>
			link.sessionChildren({ sessionId: decodeURIComponent(subagentsMatch[1]) })
		);
		return superjsonResponse({ subagents: sessions.map(toSubagent) });
	}

	const subagentTimelineMatch = new RegExp(`^v1/agents/(${ID})/subagents/(${ID})/timeline$`).exec(
		path
	);
	if (subagentTimelineMatch) {
		const { snapshotToUpdates } = await import("$lib/server/code/machineTimeline");
		const sync = await callOp(() =>
			link.sessionSync({ sessionId: decodeURIComponent(subagentTimelineMatch[2]) })
		);
		const updates = "snapshot" in sync ? snapshotToUpdates(sync.snapshot) : [];
		return superjsonResponse({ updates });
	}

	const diffMatch = new RegExp(`^v1/agents/(${ID})/diff$`).exec(path);
	if (diffMatch) {
		const { files } = await callOp(() =>
			link.sessionDiff({ sessionId: decodeURIComponent(diffMatch[1]) })
		);
		return superjsonResponse({ files: toFileChanges(files) });
	}

	error(404, "Not available through this endpoint.");
};

const messageSchema = z.object({
	text: z.string().trim().min(1).max(16_000),
	// The key attachments (images/files) will key off once the attachment
	// store lands (spec's `session.prompt`, always carries one) — minted
	// here when the caller does not supply its own.
	messageId: z.string().trim().min(1).max(128).optional(),
});

const modeSchema = z.object({
	modeId: z.string().trim().min(1).max(120),
});

const modelSchema = z.object({
	modelId: z.string().trim().min(1).max(200).nullable(),
});

const titleSchema = z.object({
	title: z.string().trim().max(120).nullable(),
});

const cancelSchema = z.unknown();

const featureSchema = z.object({
	featureId: z.string().trim().min(1).max(120),
	value: z.boolean(),
});

const createSchema = z.object({
	provider: z.string().trim().min(1).max(64).default("opencode"),
	posture: z.enum(["plan", "write"]).default("plan"),
	title: z.string().trim().max(120).optional(),
	workspaceId: z.string().trim().min(1).max(120),
});

const workspaceSchema = z.object({
	// An absolute directory on the machine (a checkout the person can see
	// there). Relative paths would resolve against whatever cwd the
	// machine process was born with — unguessable from here, so refused.
	path: z
		.string()
		.trim()
		.min(1)
		.max(1024)
		.refine(
			(p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p),
			"Expected an absolute path on the machine."
		),
	title: z.string().trim().max(120).optional(),
});

export const POST: RequestHandler = async (event) => {
	requireCodeAgents(event.locals);
	requireJsonBody(event.request);
	const path = event.params.path ?? "";
	const method = "POST";
	if (!RULES.some((rule) => rule.method === method && rule.pattern.test(path))) {
		error(404, "Not available through this endpoint.");
	}
	const device = await getPairedDevice(event.locals, event.url.searchParams.get("device"));
	const link = new MachineLink(device._id.toString());
	const body = await readJson(event.request);

	if (path === "v1/workspaces") {
		const parsed = workspaceSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { path, title? } with an absolute path.");
		const { workspace } = await callOp(() => link.workspaceCreate(parsed.data));
		return superjsonResponse({ workspace: toWorkspace(workspace) });
	}

	if (path === "v1/agents") {
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { workspaceId, provider?, posture?, title? }.");
		const { session } = await callOp(() =>
			link.sessionCreate({
				workspaceId: parsed.data.workspaceId,
				backend: parsed.data.provider,
				modeId: parsed.data.posture === "write" ? "build" : "plan",
				...(parsed.data.title ? { title: parsed.data.title } : {}),
			})
		);
		return superjsonResponse({ agent: toSession(session) });
	}

	const messageMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messageMatch) {
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { text }.");
		await callOp(() =>
			link.sessionPrompt({
				sessionId: decodeURIComponent(messageMatch[1]),
				text: parsed.data.text,
				clientMessageId: parsed.data.messageId ?? randomUUID(),
			})
		);
		return superjsonResponse({ ok: true });
	}

	const modeMatch = new RegExp(`^v1/agents/(${ID})/mode$`).exec(path);
	if (modeMatch) {
		const parsed = modeSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { modeId }.");
		await callOp(() =>
			link.sessionSetMode({
				sessionId: decodeURIComponent(modeMatch[1]),
				modeId: parsed.data.modeId,
			})
		);
		return superjsonResponse({ ok: true, notice: null });
	}

	const modelMatch = new RegExp(`^v1/agents/(${ID})/model$`).exec(path);
	if (modelMatch) {
		const parsed = modelSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { modelId: string | null }.");
		if (parsed.data.modelId) {
			await callOp(() =>
				link.sessionSetModel({
					sessionId: decodeURIComponent(modelMatch[1]),
					modelId: parsed.data.modelId as string,
				})
			);
		}
		return superjsonResponse({ ok: true });
	}

	const cancelMatch = new RegExp(`^v1/agents/(${ID})/cancel$`).exec(path);
	if (cancelMatch) {
		cancelSchema.parse(body);
		await callOp(() => link.sessionCancel({ sessionId: decodeURIComponent(cancelMatch[1]) }));
		return superjsonResponse({ ok: true });
	}

	// This deployment's one feature: opencode's auto-accept, gated by the
	// backend's capability and the machine's own policy — a `forbidden`
	// `OpError` (policy denies it) surfaces as a 403 through `callOp`.
	const featureMatch = new RegExp(`^v1/agents/(${ID})/feature$`).exec(path);
	if (featureMatch) {
		const parsed = featureSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { featureId, value } with a boolean value.");
		if (parsed.data.featureId !== "auto_accept") {
			error(404, "No such feature on this backend.");
		}
		await callOp(() =>
			link.sessionSetAutoAccept({
				sessionId: decodeURIComponent(featureMatch[1]),
				enabled: parsed.data.value,
			})
		);
		return superjsonResponse({ ok: true });
	}

	const agentNameMatch = new RegExp(`^v1/agents/(${ID})/name$`).exec(path);
	if (agentNameMatch) {
		const parsed = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(body);
		if (!parsed.success) error(400, "Expected { name }.");
		await callOp(() =>
			link.sessionRename({
				sessionId: decodeURIComponent(agentNameMatch[1]),
				title: parsed.data.name,
			})
		);
		return superjsonResponse({ ok: true });
	}

	const titleMatch = new RegExp(`^v1/workspaces/(${ID})/title$`).exec(path);
	if (titleMatch) {
		const parsed = titleSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { title: string | null }.");
		const workspaceId = decodeURIComponent(titleMatch[1]);
		if (!parsed.data.title) return superjsonResponse({ title: null });
		const { workspace } = await callOp(() =>
			link.workspaceRename({ workspaceId, title: parsed.data.title as string })
		);
		return superjsonResponse({ title: workspace.name });
	}

	const permissionMatch = new RegExp(`^v1/agents/(${ID})/permissions/(${ID})$`).exec(path);
	if (permissionMatch) {
		const parsed = z.object({ decision: z.enum(["approve", "deny"]) }).safeParse(body);
		if (!parsed.success) error(400, "Expected { decision: 'approve' | 'deny' }.");
		await callOp(() =>
			link.permissionReply({
				sessionId: decodeURIComponent(permissionMatch[1]),
				requestId: decodeURIComponent(permissionMatch[2]),
				decision: parsed.data.decision === "approve" ? "once" : "reject",
			})
		);
		return superjsonResponse({ ok: true });
	}

	const archiveAgentMatch = new RegExp(`^v1/agents/(${ID})/archive$`).exec(path);
	if (archiveAgentMatch) {
		await callOp(() =>
			link.sessionArchive({ sessionId: decodeURIComponent(archiveAgentMatch[1]) })
		);
		return superjsonResponse({ ok: true });
	}

	const archiveWorkspaceMatch = new RegExp(`^v1/workspaces/(${ID})/archive$`).exec(path);
	if (archiveWorkspaceMatch) {
		await callOp(() =>
			link.workspaceArchive({ workspaceId: decodeURIComponent(archiveWorkspaceMatch[1]) })
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
	const device = await getPairedDevice(event.locals, event.url.searchParams.get("device"));
	const link = new MachineLink(device._id.toString());
	await callOp(() => link.sessionDelete({ sessionId: decodeURIComponent(agentMatch[1]) }));
	return superjsonResponse({ ok: true });
};
