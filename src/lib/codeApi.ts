/**
 * Talking to the coding-agent panel from a page, through this app's own endpoints.
 *
 * Every call goes to `/api/v2/code/<path>`. Pairing rows are brokered by Cerea
 * itself (per-user Mongo records); live agent state is proxied to the paseo
 * daemon with the deployment's credential attached server-side. Either way
 * the browser holds no secret — putting one on the page would make every
 * extension a daemon client.
 *
 * Responses from these endpoints use the superjson wire format (Dates stay
 * Dates); errors carry the server's own message, written for whoever caused
 * them, and are not replaced with a generic "request failed".
 */

import type {
	FilesListResult,
	FilesReadResult,
	FilesStatusResult,
	Terminal,
} from "$lib/types/machineProtocol";
import superjson from "superjson";
import { base } from "$app/paths";
import type { CodeDeviceView } from "$lib/server/codeDevices";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import type {
	CodeAgentSession,
	CodeDirectory,
	CodeFileChange,
	CodeProviderMode,
	CodeProviderModel,
	CodeSubagent,
	CodeWorkspace,
} from "$lib/types/CodeAgent";

export type { CodeDeviceView };

/** One provider feature the panel can toggle on an agent — the daemon's
 * `AgentFeatureToggle`, trimmed. Select features (a value chosen from a
 * list) are dropped at the forwarder: the panel offers switches, not menus. */
export interface CodeProviderFeature {
	id: string;
	label: string;
	description?: string;
	value: boolean;
	/** Set when the machine's own policy vetoes this feature (C4: the panel
	 * cannot override it) — the toggle still renders, disabled, carrying
	 * this as the exact fix rather than disappearing as if the feature
	 * never existed. */
	blockedReason?: string;
}

export class CodeApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = "CodeApiError";
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		let message = text || `The request failed with status ${response.status}.`;
		try {
			const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
			message = parsed.message ?? parsed.error?.message ?? message;
		} catch {
			/* not JSON — the raw text is the best available */
		}
		throw new CodeApiError(message, response.status);
	}
	return (text ? superjson.parse<T>(text) : null) as T;
}

const root = () => `${base}/api/v2/code`;

export async function listDevices(): Promise<{ devices: CodeDeviceView[] }> {
	return unwrap(await fetch(`${root()}/devices`));
}

/** Confirm a machine that connected and is waiting in `pending` — the fresh
 * human approval review C2 calls for. Pushes the `status: paired` frame
 * down the machine's live socket if it is still connected. */
export async function confirmDevice(id: string): Promise<{ confirmed: boolean }> {
	return unwrap(
		await fetch(`${root()}/devices?id=${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
		})
	);
}

/** Revoke a paired machine, or reject one still `pending` — the same
 * tombstoning action either way (spec §4): the row becomes `revoked` and a
 * reconnect with the same machine id is refused from then on. */
export async function revokeDevice(id: string): Promise<{ revoked: boolean }> {
	return unwrap(
		await fetch(`${root()}/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" })
	);
}

// -- live machine state, over its link, per paired device --------------------
//
// Every call names its device (`?device=`); the server checks the row
// belongs to the caller, then reaches that machine over its live link. These
// 404 when the device is unknown, and 502 when the daemon behind it cannot
// be reached. Callers treat both as "the daemon is not connected" rather
// than a failure: the panel reads cleanly on a flag-on/daemon-off
// deployment.

/** Working directories the daemon serves agents from. */
export async function listWorkspaces(deviceId: string): Promise<{ workspaces: CodeWorkspace[] }> {
	return unwrap(await fetch(`${root()}/v1/workspaces?device=${encodeURIComponent(deviceId)}`));
}

/** Directory autocomplete for the "Add workspace" dialog's path field, as
 * the daemon sees its own filesystem. */
export async function suggestWorkspaceDirectories(
	deviceId: string,
	prefix: string
): Promise<{ directories: CodeDirectory[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/suggest?prefix=${encodeURIComponent(prefix)}&device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** A workspace backed by an existing directory on the daemon's machine, or
 * a fresh `git worktree` of another workspace. */
export async function createWorkspace(
	deviceId: string,
	input:
		| { path: string; title?: string }
		| { worktree: { from: string; branch: string; base?: string }; title?: string }
): Promise<{ workspace: CodeWorkspace }> {
	return unwrap(
		await fetch(`${root()}/v1/workspaces?device=${encodeURIComponent(deviceId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		})
	);
}

/** Every session on the device, across its workspaces — the daemon groups
 * them by `workspaceId`, which is what the tree needs in one call. */
export async function listAgents(deviceId: string): Promise<{ agents: CodeAgentSession[] }> {
	return unwrap(await fetch(`${root()}/v1/agents?device=${encodeURIComponent(deviceId)}`));
}

/** Coding sessions in one workspace. Live on the daemon; never cached here. */
export async function listWorkspaceAgents(
	deviceId: string,
	workspaceId: string
): Promise<{ agents: CodeAgentSession[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/agents?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The backend ids this machine actually runs, from `hello` (spec §5).
 * `enrollmentExpired` is the paired device row's own `credentialState`. */
export async function listProviders(
	deviceId: string
): Promise<{ providers: Array<{ id: string; available: boolean; enrollmentExpired: boolean }> }> {
	return unwrap(await fetch(`${root()}/v1/providers?device=${encodeURIComponent(deviceId)}`));
}

/** Whether a device's credential is answering as good: `"ok"` when the
 * paired row's `credentialState` (kept live by every `hello`/`credential`
 * frame the machine sends, spec §5) is not `"expired"`, `"expired"` when it
 * is, and `"unreachable"` for a device this deployment cannot currently read
 * at all. Unlike the paseo-era probe this replaces, nothing here makes a
 * network call: the device row already carries the answer. */
export type EnrollmentCheck = "ok" | "expired" | "unreachable";

/** The provider's modes — paseo's permission vocabulary (plan, build, …),
 * as the daemon itself defines it. */
export async function listProviderModes(
	deviceId: string,
	provider: string
): Promise<{ modes: CodeProviderMode[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/modes?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The provider's models, as the daemon reports them (selectable only). */
export async function listProviderModels(
	deviceId: string,
	provider: string
): Promise<{ models: CodeProviderModel[]; hidden?: number }> {
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/models?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The provider's features — the toggles a person can flip on an agent
 * (opencode's auto-accept) — as the daemon drafts them for a config like
 * the agent's. The query needs the agent's working directory; the agent's
 * mode and model ride along when known. This list says what EXISTS and
 * what it is called; the live value is the agent snapshot's word
 * (`getAgent`), never this list's. */
export async function listProviderFeatures(
	deviceId: string,
	provider: string,
	draft: { cwd: string; modeId?: string; model?: string }
): Promise<{ features: CodeProviderFeature[] }> {
	const params = new URLSearchParams({
		device: deviceId,
		cwd: draft.cwd,
		...(draft.modeId ? { modeId: draft.modeId } : {}),
		...(draft.model ? { model: draft.model } : {}),
	});
	return unwrap(
		await fetch(
			`${root()}/v1/providers/${encodeURIComponent(provider)}/features?${params.toString()}`
		)
	);
}

/** A new coding session on the daemon, scoped to one of its workspaces. */
export async function createAgent(
	deviceId: string,
	input: {
		provider?: string;
		posture?: AgentPosture;
		title?: string;
		workspaceId: string;
	}
): Promise<{ agent: CodeAgentSession }> {
	return unwrap(
		await fetch(`${root()}/v1/agents?device=${encodeURIComponent(deviceId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		})
	);
}

/** One agent's current record (title, provider, state), with the two
 * things the open screen needs beside it: the provider features the agent
 * ITSELF reports — the auto-accept toggle's live value lives here, not in
 * the provider's feature list — and the cwd the feature query requires. */
export async function getAgent(
	deviceId: string,
	agentId: string
): Promise<{
	agent: CodeAgentSession;
	features: CodeProviderFeature[];
	cwd: string;
	/** The paired device row's own `credentialState === "expired"` (spec §5),
	 * read fresh alongside this snapshot. */
	enrollmentExpired: boolean;
}> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** The files one agent has changed, as before/after pairs for the diff viewer. */
function filesUrl(
	deviceId: string,
	workspaceId: string,
	sub: string,
	params: Record<string, string>
) {
	const query = new URLSearchParams({ device: deviceId, ...params });
	return `${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/files${sub}?${query}`;
}

/** One directory of a workspace, read-only (the /code explorer, ADR 0090). */
export async function listWorkspaceFiles(
	deviceId: string,
	workspaceId: string,
	path: string
): Promise<FilesListResult> {
	return unwrap(await fetch(filesUrl(deviceId, workspaceId, "", { path })));
}

/** A range of one file; an image's bytes come from `workspaceFileRawUrl`. */
export async function readWorkspaceFile(
	deviceId: string,
	workspaceId: string,
	path: string,
	offset = 0
): Promise<FilesReadResult> {
	return unwrap(
		await fetch(filesUrl(deviceId, workspaceId, "/content", { path, offset: String(offset) }))
	);
}

/** The workspace's git status, for the tree's badges. */
export async function workspaceFileStatus(
	deviceId: string,
	workspaceId: string
): Promise<FilesStatusResult> {
	return unwrap(await fetch(filesUrl(deviceId, workspaceId, "/status", {})));
}

/** An image served as itself (raster types only, sandboxed). */
export function workspaceFileRawUrl(deviceId: string, workspaceId: string, path: string): string {
	return filesUrl(deviceId, workspaceId, "/raw", { path });
}

export async function getAgentDiff(
	deviceId: string,
	agentId: string
): Promise<{ files: CodeFileChange[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/diff?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/**
 * The subagents one agent spawned, as the daemon's roster reports them. The
 * transcript polls this on turn boundaries — never on an interval — and
 * anchors each subagent at the Task tool call its `toolCallId` names.
 */
export async function listSubagents(
	deviceId: string,
	agentId: string
): Promise<{ subagents: CodeSubagent[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/subagents?device=${encodeURIComponent(deviceId)}`
		)
	);
}

/** One subagent's own transcript, as agent frames for the chat's fold. */
export async function fetchSubagentTimeline(
	deviceId: string,
	agentId: string,
	subagentId: string
): Promise<{ updates: AgentStreamUpdate[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/subagents/${encodeURIComponent(subagentId)}/timeline?device=${encodeURIComponent(deviceId)}`
		)
	);
}

// -- control: follow-ups and approvals (Phase 3) ----------------------------

/** How much licence a new agent starts with. Creation-time only: the live
 * switch is the mode pill on the open agent, which lists the machine's own
 * modes (ADR 0089). */
export type AgentPosture = "plan" | "write";

/** The daemon's own `permission.reply` vocabulary (spec §8), carried through
 * unmediated: "once" answers this call only, "always" grants the rest of
 * the session, "reject" denies it. */
export type PermissionDecision = "once" | "always" | "reject";

/** Send a follow-up to a running session. The reply arrives on the timeline
 * stream. No licence rides along: the agent's mode — paseo's permission
 * vocabulary — is switched live by the composer's mode pill and stays until
 * switched again, which is paseo's own semantics rather than a per-send
 * override. */
export async function sendFollowUp(
	deviceId: string,
	agentId: string,
	text: string,
	/** The client's own id for the user message this creates — the key
	 * attachments (images/files) will key off once the attachment store
	 * lands. Left unset, the server mints one. */
	messageId?: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/messages?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text, ...(messageId ? { messageId } : {}) }),
			}
		)
	);
}

/** Switch the open agent's mode. A provider refusal comes back as the
 * notice text (null when applied without comment). */
export async function setAgentMode(
	deviceId: string,
	agentId: string,
	modeId: string
): Promise<{ ok: boolean; notice: string | null }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/mode?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ modeId }),
			}
		)
	);
}

/** Switch the open agent's model (`null` resets to the provider's default). */
export async function setAgentModel(
	deviceId: string,
	agentId: string,
	modelId: string | null
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/model?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ modelId }),
			}
		)
	);
}

/** Flip one of the agent's provider features — the auto-accept toggle and
 * its kind. The answer is only the POST's receipt: the toggle's label
 * claims the new value when the refreshed agent snapshot agrees, never
 * from this call. */
export async function setAgentFeature(
	deviceId: string,
	agentId: string,
	featureId: string,
	value: boolean
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/feature?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ featureId, value }),
			}
		)
	);
}

/** Stop the agent's live turn — the way out of a runaway run and of a
 * permission prompt nobody wants to answer. The answer is the POST's
 * receipt, nothing more: the turn's end (`turn_canceled`) and the denied
 * resolutions of any outstanding permission requests arrive on the
 * transcript stream, which is the source of truth. */
export async function cancelAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/cancel?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}
		)
	);
}

/** Manual context compaction ("Compact now", M3). The transcript records the
 * result (a `compaction` marker part, per the machine's own event stream);
 * this only carries the request. 404s (`CodeApiError.status === 404`) when
 * the backend has no `compact` capability — the meter hides the button in
 * that case, so a caller reaching this without checking is the exception. */
export async function compactAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/compact?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}
		)
	);
}

/** Set the thinking effort sent with the agent's prompts; null = the model's default. */
export async function setAgentEffort(
	deviceId: string,
	agentId: string,
	effort: string | null
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/effort?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ effort }),
			}
		)
	);
}

/** Roll the agent back to just before one of its user messages (retry and
 * rollback; capability `revert`). The transcript must re-sync afterwards. */
export async function revertAgent(
	deviceId: string,
	agentId: string,
	messageId: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/revert?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageId }),
			}
		)
	);
}

/** Undo the last rollback, before any new prompt. */
export async function unrevertAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/unrevert?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}
		)
	);
}

/** Answer a waiting permission request. Blocking: the agent holds until this lands.
 * `childSessionId` answers a subagent's ask (labelled with it by the stream
 * bridge) — the reply is forwarded to the child's own request. */
export async function respondPermission(
	deviceId: string,
	agentId: string,
	requestId: string,
	decision: PermissionDecision,
	childSessionId?: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/permissions/${encodeURIComponent(requestId)}?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ decision, ...(childSessionId ? { childSessionId } : {}) }),
			}
		)
	);
}

/** The user-question tool design's own approval — the SAME "accept"/
 * "decline" vocabulary AskQuestion.svelte's onanswer prop already emits;
 * answers (one array of chosen labels per question, in order) only on
 * accept. */
export async function respondQuestion(
	deviceId: string,
	agentId: string,
	requestId: string,
	decision: "accept" | "decline",
	answers?: string[][],
	childSessionId?: string
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/questions/${encodeURIComponent(requestId)}?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					decision,
					...(answers ? { answers } : {}),
					...(childSessionId ? { childSessionId } : {}),
				}),
			}
		)
	);
}

// -- archival: leaving the daemon's active lists ------------------------------
//
// Both removals are the daemon's own archive operations, named by the path
// alone (no body). An archived session disappears from every daemon listing
// — which is where the tree reads from — with its transcript archived on the
// daemon, and nothing on the person's disk changes; a deleted workspace goes
// the same way and takes its sessions with it. Callers confirm first and
// redraw the tree from the daemon afterwards.

/** Archive one session. The row leaves the tree when the daemon is re-read. */
export async function archiveAgent(deviceId: string, agentId: string): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/archive?device=${encodeURIComponent(deviceId)}`,
			{ method: "POST", headers: { "content-type": "application/json" } }
		)
	);
}

/** Delete (archive) a workspace: its sessions go with it, local files stay.
 * `removeWorktree` additionally runs `git worktree remove` on the daemon
 * (only meaningful for a workspace that is itself a worktree); `force`
 * overrides git's own refusal when it has uncommitted changes. */
export async function archiveWorkspace(
	deviceId: string,
	workspaceId: string,
	options?: { removeWorktree?: boolean; force?: boolean }
): Promise<{ ok: boolean }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/archive?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(options ?? {}),
			}
		)
	);
}

/** Rename a workspace: the daemon's setWorkspaceTitle, answering the title
 * as the daemon recorded it (`null` clears the custom name). */
export async function renameWorkspace(
	deviceId: string,
	workspaceId: string,
	title: string | null
): Promise<{ title: string | null }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/title?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title }),
			}
		)
	);
}

/**
 * A fork handoff (parity plan §4.2(a)): a new session — on `targetDevice`
 * when given, else the source's own device — seeded with `prompt` and,
 * when `carry`, the source transcript as a markdown attachment (curated up
 * to `uptoMessageId` when given). `deviceId` in the answer is the session's
 * own device: the caller (the "Hand off…" dialog) navigates there, which
 * differs from the source device on a cross-device handoff.
 */
export async function handoffAgent(
	deviceId: string,
	agentId: string,
	input: {
		prompt: string;
		carry: boolean;
		targetDevice?: string;
		workspaceId?: string;
		modeId?: string;
		modelId?: string;
		uptoMessageId?: string;
	}
): Promise<{ agent: CodeAgentSession; deviceId: string }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/handoff?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}
		)
	);
}

/** Rename an agent: the daemon's updateAgent name. */
export async function renameAgent(
	deviceId: string,
	agentId: string,
	name: string
): Promise<{ ok: true }> {
	return unwrap(
		await fetch(
			`${root()}/v1/agents/${encodeURIComponent(agentId)}/name?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name }),
			}
		)
	);
}

// -- the terminal (ADR 0090, PROTOCOL.md §9) ----------------------------------

/** Raised only by `mintTerminalTicket`, when the session's OIDC `auth_time`
 * is stale or missing (ADR 0090 D6): the UI's cue to send the person
 * through the existing login (with a return URL) instead of showing a
 * generic failure. */
export class TerminalReauthRequired extends Error {
	constructor() {
		super("Sign in again to open a terminal.");
		this.name = "TerminalReauthRequired";
	}
}

export async function listWorkspaceTerminals(
	deviceId: string,
	workspaceId: string
): Promise<{ terminals: Terminal[] }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/terminals?device=${encodeURIComponent(deviceId)}`
		)
	);
}

export async function openTerminal(
	deviceId: string,
	workspaceId: string,
	input: { cols: number; rows: number; cwd?: string; title?: string }
): Promise<{ terminal: Terminal }> {
	return unwrap(
		await fetch(
			`${root()}/v1/workspaces/${encodeURIComponent(workspaceId)}/terminals?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			}
		)
	);
}

export async function renameTerminal(
	deviceId: string,
	terminalId: string,
	title: string
): Promise<{ terminal: Terminal }> {
	return unwrap(
		await fetch(
			`${root()}/v1/terminals/${encodeURIComponent(terminalId)}/name?device=${encodeURIComponent(deviceId)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title }),
			}
		)
	);
}

export async function closeTerminal(
	deviceId: string,
	terminalId: string,
	force = false
): Promise<{ ok: true }> {
	const query = new URLSearchParams({ device: deviceId, ...(force ? { force: "true" } : {}) });
	return unwrap(
		await fetch(`${root()}/v1/terminals/${encodeURIComponent(terminalId)}?${query}`, {
			method: "DELETE",
		})
	);
}

/** The one-time-per-machine "a terminal is a full shell" acknowledgement. */
export async function acknowledgeTerminal(deviceId: string): Promise<{ ok: true }> {
	return unwrap(
		await fetch(`${root()}/v1/terminals/acknowledge?device=${encodeURIComponent(deviceId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		})
	);
}

/**
 * Mints a single-use, 30s terminal connect ticket. Throws
 * `TerminalReauthRequired` when the session's `auth_time` is stale — the
 * caller sends the person through `${base}/login?next=<here>` and retries
 * once they're back, rather than showing this as an ordinary failure.
 */
export async function mintTerminalTicket(deviceId: string, terminalId: string): Promise<string> {
	const response = await fetch(
		`${root()}/v1/terminals/${encodeURIComponent(terminalId)}/ticket?device=${encodeURIComponent(deviceId)}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
	);
	// A body's response stream can only be read once — `response.text()`
	// below is the one read for this whole function, branch-independent, so
	// a 401 that isn't the reauth shape still falls through to a normal
	// CodeApiError instead of crashing on a second read.
	const text = await response.text();
	if (response.status === 401) {
		// The reauth body is a normal superjsonResponse (like every other
		// success-shaped payload from this forwarder — it's a 401 status
		// with an ordinary body, not a SvelteKit `error()` throw), so it
		// needs superjson.parse, not a bare JSON.parse.
		let code: string | undefined;
		try {
			code = (superjson.parse(text) as { code?: string }).code;
		} catch {
			/* not the reauth shape — falls through to the generic failure below */
		}
		if (code === "reauth_required") throw new TerminalReauthRequired();
	}
	if (!response.ok) {
		// Every other non-2xx here is a SvelteKit `error()` throw (plain
		// JSON `{message}`), same as `unwrap`'s own error branch.
		let message = text || `The request failed with status ${response.status}.`;
		try {
			message = (JSON.parse(text) as { message?: string }).message ?? message;
		} catch {
			/* not JSON — the raw text is the best available */
		}
		throw new CodeApiError(message, response.status);
	}
	const { ticket } = (text ? superjson.parse(text) : null) as { ticket: string };
	return ticket;
}

/**
 * The WebSocket URL for one terminal ticket, built the same base-aware way
 * the machine link's own endpoint is (ADR 0090 §5): `wss:`/`ws:` swapped in
 * for the page's own scheme, so it survives `APP_BASE=/chat` and a proxied
 * `https:` origin without any separate configuration.
 */
export function terminalSocketUrl(ticket: string, from?: number): string {
	const url = new URL(`${base}/api/v2/code/terminal`, location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("ticket", ticket);
	if (from !== undefined) url.searchParams.set("from", String(from));
	return url.toString();
}
