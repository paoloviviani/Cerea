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
import { allowsModel, filterModels } from "$lib/server/code/modelPolicy";
import { buildHandoffHistory } from "$lib/server/code/handoff";
import { logger } from "$lib/server/logger";
import { promptAttachments } from "$lib/server/code/promptAttachments";
import { codeAttachmentKey } from "$lib/server/codeAttachments";
import { deleteAttachments } from "$lib/server/files/attachmentStore";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { OpError, type Directory, type Session, type Workspace } from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";
import {
	HANDOFF_TITLE_PREFIX,
	type CodeAgentSession,
	type CodeDirectory,
	type CodeFileChange,
	type CodeProviderMode,
	type CodeProviderModel,
	type CodeSubagent,
	type CodeTurnState,
	type CodeWorkspace,
} from "$lib/types/CodeAgent";
import type { CodeProviderFeature } from "$lib/codeApi";

const ID = "[A-Za-z0-9_.:~-]+";

const RULES: Array<{ method: "GET" | "POST" | "DELETE"; pattern: RegExp }> = [
	{ method: "GET", pattern: /^v1\/workspaces$/ },
	{ method: "POST", pattern: /^v1\/workspaces$/ },
	{ method: "GET", pattern: /^v1\/workspaces\/suggest$/ },
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
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/handoff$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/permissions/${ID}$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/questions/${ID}$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/mode$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/model$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/feature$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/cancel$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/compact$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/revert$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/unrevert$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/name$`) },
	{ method: "POST", pattern: new RegExp(`^v1/agents/${ID}/archive$`) },
	{ method: "POST", pattern: new RegExp(`^v1/workspaces/${ID}/archive$`) },
	{ method: "GET", pattern: new RegExp(`^v1/agents/${ID}/diff$`) },
];

/** `workspace.suggest`'s `?prefix=` — a path someone is mid-typing, so it
 * needs no shape beyond a sane length cap. */
const suggestPrefixSchema = z.string().max(1024);

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

/** Where an approval/question reply goes: the watched session itself, or
 * — for a subagent's ask, labelled with the child's session id by the
 * stream bridge — that child. The child must live on this same machine
 * (a `session.get` through this same link, already scoped to the caller's
 * paired device, proves it); anything else 404s rather than reaching
 * across to a session this route was never asked about. */
async function resolveReplyTarget(
	link: MachineLink,
	parentSessionId: string,
	childSessionId: string | undefined
): Promise<string> {
	if (!childSessionId || childSessionId === parentSessionId) return parentSessionId;
	// A child that lives nowhere on this machine is a 404 here, whatever
	// the machine's own error code for it would have been — this route
	// asked about a session it was never shown, not a malformed op.
	try {
		const { session } = await link.sessionGet({ sessionId: childSessionId });
		return session.id;
	} catch {
		error(404, "No such session on this machine.");
	}
}

function toWorkspace(workspace: Workspace): CodeWorkspace {
	return {
		id: workspace.id,
		name: workspace.name,
		path: workspace.path,
		isGitRepo: workspace.isGitRepo,
		...(workspace.worktreeOf ? { worktreeOf: workspace.worktreeOf } : {}),
		...(workspace.branch ? { branch: workspace.branch } : {}),
	};
}

function toDirectory(dir: Directory): CodeDirectory {
	return { path: dir.path, name: dir.name, isGitRepo: dir.isGitRepo };
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
		parentId: session.parentId ?? null,
		...(session.rootId ? { rootId: session.rootId } : {}),
		...(session.childSummary ? { childSummary: session.childSummary } : {}),
	};
}

/** The exact fix for a machine enrolled without the flag — carried on the
 * disabled toggle rather than left for someone to discover only after
 * wondering where auto-accept went. */
const AUTO_ACCEPT_VETO_NOTE =
	"This machine's policy vetoes auto-accept: re-run `galopin enroll … --allow-auto-accept`, then restart `run`.";

/** The single feature this deployment offers: opencode's auto-accept,
 * backed directly by `session.setAutoAccept` (spec §8). Absent — the
 * existing UI has no tri-state for a toggle it never heard of — only when
 * the backend itself lacks the capability. A policy veto (C4: the panel
 * cannot override a `denied` policy) still ships the toggle, disabled, with
 * `blockedReason` naming the fix: hiding it entirely reads as "there is no
 * such feature," not "your machine turned it off," which is what sent
 * someone looking for a setting that was never there to find. */
function autoAcceptCatalog(device: CodeDevice, backendId: string): CodeProviderFeature[] {
	const backend = device.backends.find((b) => b.id === backendId);
	if (!backend?.capabilities.autoAccept) return [];
	const vetoed = device.policy.autoAccept === "denied";
	return [
		{
			id: "auto_accept",
			label: "Auto-accept",
			value: false,
			...(vetoed ? { blockedReason: AUTO_ACCEPT_VETO_NOTE } : {}),
		},
	];
}

function autoAcceptLive(device: CodeDevice, session: Session): CodeProviderFeature[] {
	const backend = device.backends.find((b) => b.id === session.backend);
	if (!backend?.capabilities.autoAccept) return [];
	const vetoed = device.policy.autoAccept === "denied";
	return [
		{
			id: "auto_accept",
			label: "Auto-accept",
			value: session.autoAccept,
			...(vetoed ? { blockedReason: AUTO_ACCEPT_VETO_NOTE } : {}),
		},
	];
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
		// The anchor in the parent transcript: without it the card has nowhere to render.
		toolCallId: session.parentToolCallId ?? null,
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

	// Checked ahead of the generic single-workspace GET below — "suggest"
	// would otherwise match that route's `[^/]+` id capture and 404 as "no
	// such workspace" instead of answering the autocomplete.
	if (path === "v1/workspaces/suggest") {
		const parsed = suggestPrefixSchema.safeParse(event.url.searchParams.get("prefix") ?? "");
		if (!parsed.success) error(400, "Expected ?prefix= with a reasonable length.");
		const { directories } = await callOp(() => link.workspaceSuggest({ prefix: parsed.data }));
		return superjsonResponse({ directories: directories.map(toDirectory) });
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
		const listed = await callOp(() => link.backendModels({ backend: modelsMatch[1] }));
		const { models, hidden: hiddenHere } = filterModels(device, listed.models);
		// The agent filters by its own policy first and reports what it removed;
		// whatever Cerea removes on top is the defence-in-depth remainder.
		const hidden = (listed.hidden ?? 0) + hiddenHere;
		const mapped: CodeProviderModel[] = models.map((model) => ({
			id: model.id,
			label: model.label,
			...(model.isDefault ? { isDefault: true } : {}),
		}));
		// `hidden` lets the pill say why the list is short rather than look broken.
		return superjsonResponse({ models: mapped, hidden });
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

// A fork handoff (parity plan §4.2(a)): a new session, on the caller's own
// source device by default or another of their own paired devices, seeded
// with a prompt and — when `carry` — the source transcript as a markdown
// attachment. `targetDevice` and `workspaceId` are ids the machine(s) issued;
// their own `${ID}`-shaped validation happens where they are used, same as
// every other id this route decodes from a path segment.
const handoffSchema = z.object({
	prompt: z.string().trim().min(1).max(16_000),
	targetDevice: z.string().trim().min(1).max(200).optional(),
	workspaceId: z.string().trim().min(1).max(200).optional(),
	modeId: z.string().trim().min(1).max(120).optional(),
	modelId: z.string().trim().min(1).max(200).optional(),
	carry: z.boolean(),
	uptoMessageId: z.string().trim().min(1).max(128).optional(),
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
	modeId: z.string().trim().min(1).max(120).optional(),
	modelId: z.string().trim().min(1).max(200).optional(),
	title: z.string().trim().max(120).optional(),
	workspaceId: z.string().trim().min(1).max(120),
});

// An absolute directory on the machine (a checkout the person can see
// there). Relative paths would resolve against whatever cwd the machine
// process was born with — unguessable from here, so refused.
const absolutePathSchema = z
	.string()
	.trim()
	.min(1)
	.max(1024)
	.refine(
		(p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p),
		"Expected an absolute path on the machine."
	);

const worktreeSchema = z.object({
	from: z.string().trim().min(1).max(120),
	branch: z.string().trim().min(1).max(200),
	base: z.string().trim().min(1).max(200).optional(),
});

// Either an existing directory, or a git worktree of an existing workspace
// — mirrors workspace.create's two forms (PROTOCOL.md §6).
const workspaceSchema = z.union([
	z.object({ path: absolutePathSchema, title: z.string().trim().max(120).optional() }),
	z.object({ worktree: worktreeSchema, title: z.string().trim().max(120).optional() }),
]);

const archiveWorkspaceSchema = z.object({
	removeWorktree: z.boolean().optional(),
	force: z.boolean().optional(),
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
		if (!parsed.success) {
			error(
				400,
				"Expected { path, title? } with an absolute path, or { worktree: { from, branch, base? }, title? }."
			);
		}
		const { workspace } = await callOp(() => link.workspaceCreate(parsed.data));
		return superjsonResponse({ workspace: toWorkspace(workspace) });
	}

	if (path === "v1/agents") {
		const parsed = createSchema.safeParse(body);
		if (!parsed.success) {
			error(400, "Expected { workspaceId, provider?, posture?, modeId?, modelId?, title? }.");
		}
		if (parsed.data.modelId && !allowsModel(device, parsed.data.modelId)) {
			error(403, "This machine was enrolled without --allow-free-models.");
		}
		const { session } = await callOp(() =>
			link.sessionCreate({
				workspaceId: parsed.data.workspaceId,
				backend: parsed.data.provider,
				// A live mode id from the machine's list wins; the posture pair is the
				// fallback for callers that only know plan/write (opencode's ids).
				modeId: parsed.data.modeId ?? (parsed.data.posture === "write" ? "build" : "plan"),
				...(parsed.data.modelId ? { modelId: parsed.data.modelId } : {}),
				...(parsed.data.title ? { title: parsed.data.title } : {}),
			})
		);
		return superjsonResponse({ agent: toSession(session) });
	}

	const messageMatch = new RegExp(`^v1/agents/(${ID})/messages$`).exec(path);
	if (messageMatch) {
		const parsed = messageSchema.safeParse(body);
		if (!parsed.success) error(400, "Expected { text }.");
		const sessionId = decodeURIComponent(messageMatch[1]);
		// Files the composer uploaded under this message id travel with the prompt. With no
		// messageId there can be none: the browser uploads under the id it then sends.
		const attachments = parsed.data.messageId
			? await promptAttachments(
					codeAttachmentKey(device._id.toHexString(), sessionId),
					parsed.data.messageId
				)
			: [];
		await callOp(() =>
			link.sessionPrompt({
				sessionId,
				text: parsed.data.text,
				clientMessageId: parsed.data.messageId ?? randomUUID(),
				...(attachments.length ? { attachments } : {}),
			})
		);
		return superjsonResponse({ ok: true });
	}

	// A fork handoff (parity plan §4.2(a)): sync the source for its snapshot,
	// curate it into a "chat history" attachment when carrying, create the
	// child on the chosen (default: source) device/workspace, and send the
	// prompt with that attachment. No lineage label exists on this wire — the
	// child's header instead reads its own title (`AgentView`'s "Handed off
	// from ‹title›", a title-based link, per the spec's "keep it simple").
	const handoffMatch = new RegExp(`^v1/agents/(${ID})/handoff$`).exec(path);
	if (handoffMatch) {
		const parsed = handoffSchema.safeParse(body);
		if (!parsed.success) {
			error(
				400,
				"Expected { prompt, carry, targetDevice?, workspaceId?, modeId?, modelId?, uptoMessageId? }."
			);
		}
		const sourceSessionId = decodeURIComponent(handoffMatch[1]);
		const targetDevice = parsed.data.targetDevice
			? await getPairedDevice(event.locals, parsed.data.targetDevice)
			: device;
		const targetLink =
			targetDevice._id.toString() === device._id.toString()
				? link
				: new MachineLink(targetDevice._id.toString());

		if (parsed.data.modelId && !allowsModel(targetDevice, parsed.data.modelId)) {
			error(403, "The target machine was enrolled without --allow-free-models.");
		}

		const { session: sourceSession } = await callOp(() =>
			link.sessionGet({ sessionId: sourceSessionId })
		);

		let attachments: Array<{ type: "file"; mime: string; filename: string; url: string }> = [];
		if (parsed.data.carry) {
			const sync = await callOp(() => link.sessionSync({ sessionId: sourceSessionId }));
			if ("snapshot" in sync) {
				const { markdown } = buildHandoffHistory(sync.snapshot, parsed.data.uptoMessageId);
				if (markdown.trim()) {
					const base64 = Buffer.from(markdown, "utf8").toString("base64");
					attachments = [
						{
							type: "file",
							mime: "text/markdown",
							filename: "chat-history.md",
							url: `data:text/markdown;base64,${base64}`,
						},
					];
				}
			}
		}

		const { session } = await callOp(() =>
			targetLink.sessionCreate({
				workspaceId: parsed.data.workspaceId ?? sourceSession.workspaceId,
				backend: sourceSession.backend,
				title: `${HANDOFF_TITLE_PREFIX}${sourceSession.title}`.slice(0, 120),
				...(parsed.data.modeId ? { modeId: parsed.data.modeId } : {}),
				...(parsed.data.modelId ? { modelId: parsed.data.modelId } : {}),
			})
		);

		await callOp(() =>
			targetLink.sessionPrompt({
				sessionId: session.id,
				text: parsed.data.prompt,
				...(attachments.length ? { attachments } : {}),
			})
		);

		return superjsonResponse({
			agent: toSession(session),
			deviceId: targetDevice._id.toString(),
		});
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
			if (!allowsModel(device, parsed.data.modelId)) {
				error(403, "This machine was enrolled without --allow-free-models.");
			}
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

	// Manual context compaction ("Compact now", M3). `unsupported` (the
	// backend has no `compact` capability) surfaces as a 404 through
	// `callOp`, same as any other capability the machine lacks.
	const compactMatch = new RegExp(`^v1/agents/(${ID})/compact$`).exec(path);
	if (compactMatch) {
		cancelSchema.parse(body);
		await callOp(() => link.sessionCompact({ sessionId: decodeURIComponent(compactMatch[1]) }));
		return superjsonResponse({ ok: true });
	}

	// Retry and rollback (capability `revert`): roll the session back to just
	// before one of its user messages, or undo that before the next prompt.
	// `unsupported` surfaces as a 404 and a mid-turn session as a 400,
	// through `callOp` like every other op.
	const revertMatch = new RegExp(`^v1/agents/(${ID})/revert$`).exec(path);
	if (revertMatch) {
		const parsed = z.object({ messageId: z.string().trim().min(1).max(200) }).safeParse(body);
		if (!parsed.success) error(400, "Expected { messageId }.");
		await callOp(() =>
			link.sessionRevert({
				sessionId: decodeURIComponent(revertMatch[1]),
				messageId: parsed.data.messageId,
			})
		);
		return superjsonResponse({ ok: true });
	}
	const unrevertMatch = new RegExp(`^v1/agents/(${ID})/unrevert$`).exec(path);
	if (unrevertMatch) {
		cancelSchema.parse(body);
		await callOp(() => link.sessionUnrevert({ sessionId: decodeURIComponent(unrevertMatch[1]) }));
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
		// The card's own three buttons, unmediated: "once" and "always" both
		// answer through the same call the daemon's tool is waiting on, and
		// only differ in whether the grant outlives this one call
		// (`permission.reply`, spec §8). There is no fourth option to invent
		// here — the daemon owns the scoping, not this route.
		//
		// `childSessionId` carries a subagent's ask: the card's elicitation
		// id is only unique per session, so the parent's stream labels the
		// child's asks with the session the reply must reach. It is
		// validated to live on this same machine (a `session.get` on this
		// link — the link itself is already scoped to the caller's paired
		// device) before anything is forwarded to it.
		const parsed = z
			.object({
				decision: z.enum(["once", "always", "reject"]),
				childSessionId: z.string().trim().min(1).max(200).optional(),
			})
			.safeParse(body);
		if (!parsed.success)
			error(400, "Expected { decision: 'once' | 'always' | 'reject', childSessionId? }.");
		const parentSessionId = decodeURIComponent(permissionMatch[1]);
		const targetSessionId = await resolveReplyTarget(
			link,
			parentSessionId,
			parsed.data.childSessionId
		);
		await callOp(() =>
			link.permissionReply({
				sessionId: targetSessionId,
				requestId: decodeURIComponent(permissionMatch[2]),
				decision: parsed.data.decision,
			})
		);
		return superjsonResponse({ ok: true });
	}

	// The user-question tool design: the SAME "accept"/"decline" vocabulary
	// AskQuestion.svelte's own onanswer prop already emits (chat's own
	// ask_user_question answers through the same two actions), translated
	// here into question.reply's "answer"/"reject".
	const questionMatch = new RegExp(`^v1/agents/(${ID})/questions/(${ID})$`).exec(path);
	if (questionMatch) {
		const parsed = z
			.object({
				decision: z.enum(["accept", "decline"]),
				answers: z.array(z.array(z.string())).optional(),
				childSessionId: z.string().trim().min(1).max(200).optional(),
			})
			.safeParse(body);
		if (!parsed.success)
			error(
				400,
				"Expected { decision: 'accept' | 'decline', answers?: string[][], childSessionId? }."
			);
		const parentSessionId = decodeURIComponent(questionMatch[1]);
		const targetSessionId = await resolveReplyTarget(
			link,
			parentSessionId,
			parsed.data.childSessionId
		);
		await callOp(() =>
			link.questionReply({
				sessionId: targetSessionId,
				requestId: decodeURIComponent(questionMatch[2]),
				decision: parsed.data.decision === "accept" ? "answer" : "reject",
				...(parsed.data.answers ? { answers: parsed.data.answers } : {}),
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
		const parsed = archiveWorkspaceSchema.safeParse(body ?? {});
		if (!parsed.success) error(400, "Expected { removeWorktree?, force? }.");
		await callOp(() =>
			link.workspaceArchive({
				workspaceId: decodeURIComponent(archiveWorkspaceMatch[1]),
				...(parsed.data.removeWorktree ? { removeWorktree: true } : {}),
				...(parsed.data.force ? { force: true } : {}),
			})
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
	const sessionId = decodeURIComponent(agentMatch[1]);
	await callOp(() => link.sessionDelete({ sessionId }));
	// The session is gone on the machine; what it was sent goes with it.
	await deleteAttachments(codeAttachmentKey(device._id.toHexString(), sessionId)).catch((err) =>
		logger.error({ err, sessionId }, "failed to delete a deleted session's attachments")
	);
	return superjsonResponse({ ok: true });
};
