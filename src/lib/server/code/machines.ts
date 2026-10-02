/**
 * The machine registry: one live WebSocket per paired machine, in process,
 * plus the typed request/response layer (`MachineLink`) and the event
 * fan-out the SSE bridge subscribes to.
 *
 * Nothing here is a capability at rest — the registry is a plain in-memory
 * `Map`, lost on restart, and the only thing a Mongo dump of `codeDevices`
 * yields is names and ids (review C4). A `MachineLink` for an offline
 * machine still constructs and still answers every call: instantly, with an
 * `unavailable` rejection, never a hang (R1) — the registry is checked
 * first, and nothing here ever attempts a connection outward.
 */

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import {
	resolveMachineUser,
	revalidateMachineAuth,
	type MachinePrincipal,
} from "$lib/server/code/machineAuth";
import {
	parseMachineFrame,
	opDeadlineMs,
	OpError,
	decodeBinaryFrame,
	encodeBinaryFrame,
	BIN_TERM_OUTPUT,
	BIN_TERM_INPUT,
	BIN_TERM_ACK,
	type Backend,
	type Directory,
	type Command,
	type Envelope,
	type FileDiff,
	type Mode,
	type Model,
	type OpName,
	type Policy,
	type Session,
	type SyncResult,
	type Workspace,
	type FileEntry,
	type FilesListResult,
	type FilesReadResult,
	type FilesStatusResult,
	type Terminal,
	type TerminalAttachResult,
	type Notice,
} from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_DEAD_AFTER_MS = 60_000;
const RENEWAL_GRACE_MS = 60_000;
/** ADR 0093 §4.7: every live link is re-checked against the gateway at this
 * cadence, independent of the machine's own renewal — catching an account
 * disabled or merged between token renewals, not only an expired token. */
const GATEWAY_REVALIDATION_INTERVAL_MS = 60_000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ConnectionState {
	deviceId: string;
	ws: WebSocket;
	principal: MachinePrincipal;
	/** The current bearer, kept for the periodic gateway revalidation tick
	 * (§4.7) — `MachinePrincipal` carries only what the JWT itself decoded to,
	 * never the raw token. Updated on every successful "auth" renewal. */
	token: string;
	backends: Backend[];
	policy: Policy;
	pending: Map<string, PendingRequest>;
	listeners: Map<string, Set<(envelope: Envelope) => void>>;
	/** Watchers of a whole session tree: a listener on a root session id
	 * also receives its descendants' envelopes (subagent approvals and
	 * questions surfacing mid-turn in the parent's view). */
	rootListeners: Map<string, Set<(envelope: Envelope) => void>>;
	/** Binary `term.output` routing (§9.2): one entry per viewer channel,
	 * registered by the browser relay when it attaches and removed on
	 * detach. A channel with no entry (an evicted relay, a stray frame)
	 * drops the frame silently — never a per-frame log (R6). */
	terminalChannels: Map<string, (offset: number, payload: Buffer) => void>;
	/** `notice` frames scoped to one terminal (§9.5): terminal.exit, .title,
	 * .state. Lossy and unsequenced by design — a listener that might have
	 * missed one re-queries `terminal.list`. */
	terminalNoticeListeners: Map<string, Set<(notice: Notice) => void>>;
	authDeadline: ReturnType<typeof setTimeout> | null;
	pingInterval: ReturnType<typeof setInterval> | null;
	lastPongAt: number;
}

/** deviceId (the codeDevices row's hex _id) → its one live connection. */
const registry = new Map<string, ConnectionState>();

export function isMachineOnline(deviceId: string): boolean {
	return registry.has(deviceId);
}

/** Listeners of one device's online/offline transitions — what lets the
 * browser terminal relay show "reconnecting" the instant the machine link
 * drops and re-attach the instant it comes back, rather than polling. */
const connectionListeners = new Map<string, Set<(online: boolean) => void>>();

export function subscribeDeviceConnection(
	deviceId: string,
	listener: (online: boolean) => void
): () => void {
	let set = connectionListeners.get(deviceId);
	if (!set) {
		set = new Set();
		connectionListeners.set(deviceId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

function notifyConnectionChange(deviceId: string, online: boolean): void {
	const listeners = connectionListeners.get(deviceId);
	if (!listeners) return;
	for (const listener of listeners) listener(online);
}

export function deviceBackends(deviceId: string): Backend[] | null {
	return registry.get(deviceId)?.backends ?? null;
}

export function devicePolicy(deviceId: string): Policy | null {
	return registry.get(deviceId)?.policy ?? null;
}

function closeConnection(state: ConnectionState, code: number, reason: string): void {
	if (state.authDeadline) clearTimeout(state.authDeadline);
	if (state.pingInterval) clearInterval(state.pingInterval);
	for (const pending of state.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(new OpError("unavailable", "The machine link closed."));
	}
	state.pending.clear();
	try {
		state.ws.close(code, reason);
	} catch {
		// already closing
	}
	// Only drop the registry entry if this connection is still the current
	// one for its device — a stale `close` from a connection already
	// replaced by a newer one (4409) must not evict the newer one, and must
	// not tell the terminal relay the machine went offline when it did not.
	if (registry.get(state.deviceId) === state) {
		registry.delete(state.deviceId);
		notifyConnectionChange(state.deviceId, false);
	}
}

export function dropMachineConnection(deviceId: string, code: number, reason: string): void {
	const state = registry.get(deviceId);
	if (state) closeConnection(state, code, reason);
}

/** Revoke one device (§4.7: a fresh `galopin enroll` is required even once
 * the account is re-enabled) and close its live link — the outcome for
 * both a real refusal and a stale enrolment, so `revalidateLiveMachineConnections`
 * states each once rather than repeating the write and the close. */
async function revokeAndClose(state: ConnectionState, reason: string): Promise<void> {
	logger.info({ deviceId: state.deviceId, reason }, "machine link: revoking on revalidation");
	await collections.codeDevices
		.updateOne(
			{ _id: new ObjectId(state.deviceId) },
			{
				$set: {
					status: "revoked",
					revokedAt: new Date(),
					revokedReason: "account_disabled",
					updatedAt: new Date(),
				},
			}
		)
		.catch((err) =>
			logger.warn({ err, deviceId: state.deviceId }, "machine link: failed to revoke device row")
		);
	closeConnection(state, 4403, "this account is no longer active");
}

/** One tick of the revalidation loop (ADR 0093 §4.7): every live connection,
 * re-checked against the gateway.
 *
 * - **Valid**, and stale (`sessions_valid_after` newer than the device's own
 *   `createdAt`): revoke the device (so a fresh `galopin enroll` is required
 *   even once the account is re-enabled) and close the link.
 * - **Refused** (`refused: true`): same — revoke and close. The account is
 *   authoritatively no good any more.
 * - **Unreachable past the bounded fail-open** (`ok: false, refused: false`
 *   — `resolveMachineUser`'s own 5-minute grace since the last good answer
 *   for that subject has already elapsed): close the link, but **do not**
 *   revoke the device — an outage is not the gateway saying no, and the
 *   machine reconnects on its own once it answers again.
 * - **Valid and fresh**, or unreachable but still within the grace (fails
 *   open, transparently, inside `resolveMachineUser`): leave the connection
 *   exactly as it was.
 *
 * Exported for the test to drive one tick without waiting on the real
 * interval.
 */
export async function revalidateLiveMachineConnections(): Promise<void> {
	for (const state of [...registry.values()]) {
		let resolution;
		try {
			resolution = await resolveMachineUser(state.principal.sub, state.principal.exp, state.token);
		} catch (err) {
			logger.warn({ err, deviceId: state.deviceId }, "machine link: revalidation check failed");
			continue;
		}

		if (resolution.ok) {
			const device = await collections.codeDevices
				.findOne({ _id: new ObjectId(state.deviceId) })
				.catch(() => null);
			const sessionsValidAfter = resolution.sessionsValidAfter
				? new Date(resolution.sessionsValidAfter)
				: null;
			const staleEnrolment = Boolean(
				device && sessionsValidAfter && sessionsValidAfter.getTime() > device.createdAt.getTime()
			);
			if (!staleEnrolment) continue;
			await revokeAndClose(state, "sessions_valid_after");
		} else if (resolution.refused) {
			await revokeAndClose(state, resolution.message);
		} else {
			// Unreachable, past the bounded fail-open: close, but the device
			// stays enrolled — the machine reconnects on its own once the
			// gateway answers again.
			logger.info(
				{ deviceId: state.deviceId },
				"machine link: closing (not revoking) after the gateway stayed unreachable"
			);
			closeConnection(state, 1013, "the gateway is unreachable; reconnect shortly");
		}
	}
}

let revalidationInterval: ReturnType<typeof setInterval> | null = null;

/** Start the periodic tick above. Idempotent (a second call is a no-op) and
 * called once from `initServer()`, like the other background loops there —
 * not at module load, so it never starts before config/DB are ready and
 * never runs in a test that merely imports this module. */
export function startMachineRevalidationLoop(): void {
	if (revalidationInterval) return;
	revalidationInterval = setInterval(() => {
		revalidateLiveMachineConnections().catch((err) =>
			logger.warn({ err }, "machine link: revalidation tick failed")
		);
	}, GATEWAY_REVALIDATION_INTERVAL_MS);
}

/** Sent once the browser confirms a pending machine (spec §4). A no-op if
 * the machine is not currently connected — it will see its row's `paired`
 * status the next time it connects instead. */
export function notifyDevicePaired(deviceId: string): void {
	const state = registry.get(deviceId);
	if (!state) return;
	try {
		state.ws.send(JSON.stringify({ type: "status", status: "paired" }));
	} catch (err) {
		logger.warn({ err, deviceId }, "machine link: failed to push paired status");
	}
}

function scheduleAuthDeadline(state: ConnectionState): void {
	if (state.authDeadline) clearTimeout(state.authDeadline);
	const deadlineMs = state.principal.exp * 1000 + RENEWAL_GRACE_MS - Date.now();
	state.authDeadline = setTimeout(
		() => {
			logger.warn({ deviceId: state.deviceId }, "machine link: auth renewal deadline passed");
			closeConnection(state, 4401, "token expired and was not renewed");
		},
		Math.max(0, deadlineMs)
	);
}

function sendRequest<TResult>(state: ConnectionState, op: OpName, args: unknown): Promise<TResult> {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const timer = setTimeout(() => {
			state.pending.delete(id);
			reject(new OpError("unavailable", `Timed out waiting for ${op} to answer.`));
		}, opDeadlineMs(op));
		state.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
		try {
			state.ws.send(JSON.stringify({ type: "req", id, op, args }));
		} catch (err) {
			clearTimeout(timer);
			state.pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/**
 * Typed methods, one per op in spec §6. A `MachineLink` is cheap to
 * construct for any deviceId — every method looks the live connection up in
 * the registry at call time, so a link built for an offline machine answers
 * every call with an instant `unavailable` `OpError` rather than a hang.
 */
export class MachineLink {
	constructor(private readonly deviceId: string) {}

	private call<TResult>(op: OpName, args: unknown): Promise<TResult> {
		const state = registry.get(this.deviceId);
		if (!state) {
			return Promise.reject(new OpError("unavailable", "This machine is not connected."));
		}
		return sendRequest<TResult>(state, op, args);
	}

	workspaceList(): Promise<{ workspaces: Workspace[] }> {
		return this.call("workspace.list", {});
	}
	workspaceSuggest(args: { prefix: string }): Promise<{ directories: Directory[] }> {
		return this.call("workspace.suggest", args);
	}
	workspaceCreate(args: {
		path?: string;
		title?: string;
		worktree?: { from: string; branch: string; base?: string };
	}): Promise<{ workspace: Workspace }> {
		return this.call("workspace.create", args);
	}
	workspaceRename(args: { workspaceId: string; title: string }): Promise<{ workspace: Workspace }> {
		return this.call("workspace.rename", args);
	}
	workspaceArchive(args: {
		workspaceId: string;
		removeWorktree?: boolean;
		force?: boolean;
	}): Promise<Record<string, never>> {
		return this.call("workspace.archive", args);
	}
	sessionList(args: { workspaceId?: string } = {}): Promise<{ sessions: Session[] }> {
		return this.call("session.list", args);
	}
	sessionGet(args: { sessionId: string }): Promise<{ session: Session }> {
		return this.call("session.get", args);
	}
	sessionCreate(args: {
		workspaceId: string;
		backend?: string;
		title?: string;
		modeId?: string;
		modelId?: string;
	}): Promise<{ session: Session }> {
		return this.call("session.create", args);
	}
	sessionPrompt(args: {
		sessionId: string;
		text: string;
		clientMessageId?: string;
		attachments?: Array<{ type: "file"; mime: string; filename: string; url: string }>;
	}): Promise<Record<string, never>> {
		return this.call("session.prompt", args);
	}
	sessionCancel(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.cancel", args);
	}
	sessionRename(args: { sessionId: string; title: string }): Promise<{ session: Session }> {
		return this.call("session.rename", args);
	}
	sessionArchive(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.archive", args);
	}
	sessionDelete(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.delete", args);
	}
	sessionSetMode(args: { sessionId: string; modeId: string }): Promise<{ session: Session }> {
		return this.call("session.setMode", args);
	}
	sessionSetModel(args: { sessionId: string; modelId: string }): Promise<{ session: Session }> {
		return this.call("session.setModel", args);
	}
	sessionSetAutoAccept(args: {
		sessionId: string;
		enabled: boolean;
	}): Promise<{ session: Session }> {
		return this.call("session.setAutoAccept", args);
	}
	permissionReply(args: {
		sessionId: string;
		requestId: string;
		decision: "once" | "always" | "reject";
		message?: string;
	}): Promise<Record<string, never>> {
		return this.call("permission.reply", args);
	}
	/**
	 * The effective opencode rules for one session's agent, the ceiling, and
	 * the "always" approvals opencode is holding — a READ.
	 */
	permissionRules(args: { sessionId: string }): Promise<unknown> {
		return this.call("permission.rules", args);
	}
	/**
	 * Compose THIS session's rules. The machine applies them capped by its
	 * ceiling — an over-ceiling rule is refused or lowered — so the answer is
	 * not a statement of what is in force: re-read `permissionRules` for that.
	 * Only `{permission, pattern, action}` triples travel; the caller builds
	 * them, so nothing else (never the deprecated `tools` map) can ride along.
	 */
	sessionSetRules(args: {
		sessionId: string;
		rules: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>;
	}): Promise<unknown> {
		return this.call("session.setRules", args);
	}
	/**
	 * Forget one saved "always" approval so that kind of call asks again.
	 * Tighten-only by construction: it can only remove an allowance, and
	 * galopin audits it.
	 */
	permissionSavedRemove(args: { id: string; sessionId: string }): Promise<Record<string, never>> {
		return this.call("permission.saved.remove", args);
	}
	questionReply(args: {
		sessionId: string;
		requestId: string;
		decision: "answer" | "reject";
		answers?: string[][];
	}): Promise<Record<string, never>> {
		return this.call("question.reply", args);
	}
	/**
	 * Every pending permission and question on this machine, with the
	 * session context the Needs-you inbox renders and deep-links from —
	 * the inbox's one round trip per machine (PROTOCOL.md `permissions.pending`).
	 * A read of live machine state, never a queue: answering uses the
	 * existing reply ops, whose events clear the ask everywhere.
	 */
	permissionsPending(): Promise<{
		permissions: import("$lib/types/machineProtocol").PendingPermission[];
		questions: import("$lib/types/machineProtocol").PendingQuestion[];
	}> {
		return this.call("permissions.pending", {});
	}
	sessionSync(args: { sessionId: string; epoch?: string; afterSeq?: number }): Promise<SyncResult> {
		return this.call("session.sync", args);
	}
	sessionDiff(args: { sessionId: string }): Promise<{ files: FileDiff[] }> {
		return this.call("session.diff", args);
	}
	sessionChildren(args: { sessionId: string }): Promise<{ sessions: Session[] }> {
		return this.call("session.children", args);
	}
	/** The explorer's read-only file ops (§9.3); machine ops, no backend. */
	filesList(args: {
		workspaceId: string;
		path: string;
		ignored?: boolean;
	}): Promise<FilesListResult> {
		return this.call("files.list", args);
	}
	filesStat(args: { workspaceId: string; path: string }): Promise<{ entry: FileEntry }> {
		return this.call("files.stat", args);
	}
	filesRead(args: {
		workspaceId: string;
		path: string;
		offset?: number;
		length?: number;
		as?: "text" | "base64";
	}): Promise<FilesReadResult> {
		return this.call("files.read", args);
	}
	filesStatus(args: { workspaceId: string }): Promise<FilesStatusResult> {
		return this.call("files.status", args);
	}
	/** The terminal's machine ops (§9.3); like files.*, forbidden outright
	 * when the machine's own policy denies terminals (checked machine-side
	 * before any of these run — the forwarder checks first too, §6.1). */
	terminalList(args: { workspaceId?: string } = {}): Promise<{ terminals: Terminal[] }> {
		return this.call("terminal.list", args);
	}
	terminalOpen(args: {
		workspaceId: string;
		cwd?: string;
		cols: number;
		rows: number;
		title?: string;
	}): Promise<{ terminal: Terminal }> {
		return this.call("terminal.open", args);
	}
	terminalAttach(args: {
		terminalId: string;
		channel: string;
		from?: number;
	}): Promise<TerminalAttachResult> {
		return this.call("terminal.attach", args);
	}
	terminalDetach(args: { terminalId: string; channel: string }): Promise<Record<string, never>> {
		return this.call("terminal.detach", args);
	}
	terminalResize(args: {
		terminalId: string;
		cols: number;
		rows: number;
		claim?: boolean;
	}): Promise<{ applied: boolean }> {
		return this.call("terminal.resize", args);
	}
	terminalRename(args: { terminalId: string; title: string }): Promise<{ terminal: Terminal }> {
		return this.call("terminal.rename", args);
	}
	terminalClose(args: { terminalId: string; force?: boolean }): Promise<Record<string, never>> {
		return this.call("terminal.close", args);
	}
	/** The thinking effort sent with this session's prompts (capability `efforts`). */
	sessionSetEffort(args: {
		sessionId: string;
		effort: string | null;
	}): Promise<{ session: Session }> {
		return this.call("session.setEffort", args);
	}
	/** Roll back to just before a user message (capability `revert`). */
	sessionRevert(args: { sessionId: string; messageId: string }): Promise<Record<string, never>> {
		return this.call("session.revert", args);
	}
	/** Undo the last rollback, before any new prompt. */
	sessionUnrevert(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.unrevert", args);
	}
	sessionCompact(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.compact", args);
	}
	/** One image a tool part listed (§6 session.attachment): base64 `data`,
	 * the machine's claimed `mime` (never trusted — the route checks the bytes). */
	sessionAttachment(args: {
		sessionId: string;
		sha256: string;
	}): Promise<{ mime: string; data: string }> {
		return this.call("session.attachment", args);
	}
	backendModes(args: { backend?: string; workspaceId?: string } = {}): Promise<{ modes: Mode[] }> {
		return this.call("backend.modes", args);
	}
	backendModels(
		args: { backend?: string; workspaceId?: string } = {}
	): Promise<{ models: Model[]; hidden?: number }> {
		return this.call("backend.models", args);
	}
	/** The workspace's slash commands (PROTOCOL.md §6 backend.commands):
	 * origins, shell facts and template hashes — never a template. */
	backendCommands(args: {
		backend?: string;
		workspaceId?: string;
		sessionId?: string;
	}): Promise<{ commands: Command[] }> {
		return this.call("backend.commands", args);
	}
	/** Run one slash command in a session (PROTOCOL.md §6
	 * session.command): accepted at once, the turn streams as events. The
	 * machine's gates answer not_found / conflict / forbidden / invalid. */
	sessionCommand(args: {
		sessionId: string;
		name: string;
		arguments: string;
		clientMessageId?: string;
		attachments?: Array<{ type: "file"; mime: string; filename: string; url: string }>;
		templateHash?: string;
	}): Promise<Record<string, never>> {
		return this.call("session.command", args);
	}
}

/** Fan out one session's normalized events to whoever is watching (the SSE
 * bridge, one listener per open browser tab). Returns an unsubscribe. */
export function subscribeSessionEvents(
	deviceId: string,
	sessionId: string,
	listener: (envelope: Envelope) => void
): () => void {
	const state = registry.get(deviceId);
	if (!state) return () => {};
	let set = state.listeners.get(sessionId);
	if (!set) {
		set = new Set();
		state.listeners.set(sessionId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

/** Fan out a whole session tree's normalized events: the listener on a
 * root session id receives the root's own envelopes plus every
 * descendant's (matched on `rootSessionId`, falling back to `sessionId`
 * for machines that predate the field). The SSE bridge subscribes this
 * way, so a subagent's approval or question reaches the parent's view
 * mid-turn instead of hanging until the next roster poll. Returns an
 * unsubscribe. */
export function subscribeSessionTree(
	deviceId: string,
	rootSessionId: string,
	listener: (envelope: Envelope) => void
): () => void {
	const state = registry.get(deviceId);
	if (!state) return () => {};
	let set = state.rootListeners.get(rootSessionId);
	if (!set) {
		set = new Set();
		state.rootListeners.set(rootSessionId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

/**
 * Registers where `term.output` binary frames on `channel` go (§9.2): the
 * browser terminal relay calls this right after a successful
 * `terminal.attach`, using the same channel id it passed as `args.channel`.
 * Returns an unregister, called on detach/close. A no-op (never throws) if
 * the machine is offline by the time this runs — the relay's own
 * `terminalAttach` call would already have failed first.
 */
export function registerTerminalChannel(
	deviceId: string,
	channel: string,
	onOutput: (offset: number, payload: Buffer) => void
): () => void {
	const state = registry.get(deviceId);
	if (!state) return () => {};
	state.terminalChannels.set(channel, onOutput);
	return () => {
		if (registry.get(deviceId) === state) state.terminalChannels.delete(channel);
	};
}

/** Watchers of one terminal's lossy notices (§9.5): exit, title, state. */
export function subscribeTerminalNotices(
	deviceId: string,
	terminalId: string,
	listener: (notice: Notice) => void
): () => void {
	const state = registry.get(deviceId);
	if (!state) return () => {};
	let set = state.terminalNoticeListeners.get(terminalId);
	if (!set) {
		set = new Set();
		state.terminalNoticeListeners.set(terminalId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

/** Relays browser keystrokes to the machine on `channel` (§9.2, C→M
 * term.input). `offset` is always 0 on input frames per the wire format.
 * Returns false if the machine is offline or the send failed — the caller
 * (the browser relay) treats that as "machine offline" rather than a hard
 * error, since a machine-link drop is meant to be survivable. */
export function sendTerminalInput(deviceId: string, channel: string, payload: Buffer): boolean {
	const state = registry.get(deviceId);
	if (!state) return false;
	try {
		state.ws.send(encodeBinaryFrame({ kind: BIN_TERM_INPUT, channel, offset: 0, payload }));
		return true;
	} catch {
		return false;
	}
}

/** Relays a browser ack to the machine on `channel` (§9.2, C→M term.ack):
 * "the viewer has consumed output up to (excluding) this offset" — this is
 * the credit that keeps the machine reading the PTY (§9.2 flow control). */
export function sendTerminalAck(deviceId: string, channel: string, offset: number): boolean {
	const state = registry.get(deviceId);
	if (!state) return false;
	try {
		state.ws.send(
			encodeBinaryFrame({ kind: BIN_TERM_ACK, channel, offset, payload: Buffer.alloc(0) })
		);
		return true;
	} catch {
		return false;
	}
}

function touchDeviceRow(deviceId: string, patch: Partial<CodeDevice>): void {
	void collections.codeDevices
		.updateOne({ _id: new ObjectId(deviceId) }, { $set: { ...patch, updatedAt: new Date() } })
		.catch((err) => logger.warn({ err, deviceId }, "machine link: device row update failed"));
}

/**
 * The connection's whole lifecycle, from the first frame after upgrade to
 * its close. Called once per accepted WebSocket, after `machineAuth` has
 * already validated the bearer (pre-upgrade, spec §3).
 */
export function acceptMachineConnection(
	ws: WebSocket,
	_req: IncomingMessage,
	principal: MachinePrincipal,
	token: string
): void {
	let helloReceived = false;
	const helloTimer = setTimeout(() => {
		if (!helloReceived) {
			try {
				ws.close(4000, "expected a hello frame");
			} catch {
				/* already gone */
			}
		}
	}, HELLO_TIMEOUT_MS);

	let state: ConnectionState | null = null;

	ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
		// Binary frames carry terminal stream bytes only (§9.2), sent only on
		// a channel Cerea itself opened with terminal.attach — an old machine
		// or a peer that never attaches never sends one. Routed by channel id
		// straight to whichever browser relay registered it; a stray or
		// evicted channel drops the frame silently (never a per-frame log, R6).
		if (isBinary) {
			if (!state || !Buffer.isBuffer(raw)) return;
			const frame = decodeBinaryFrame(raw);
			if (!frame || frame.kind !== BIN_TERM_OUTPUT) return; // only M→C kind is meaningful here
			const onOutput = state.terminalChannels.get(frame.channel);
			onOutput?.(frame.offset, frame.payload);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString());
		} catch {
			return; // malformed JSON: ignored, not fatal (forward-compat rule)
		}
		const frame = parseMachineFrame(parsed);
		if (!frame) {
			// Dropping unknown frames is the forward-compat rule, but a first frame
			// that claims to be a hello and fails validation is a contract break
			// that would otherwise surface only as a 4000 close after the timer.
			if (!helloReceived && (parsed as { type?: unknown } | null)?.type === "hello") {
				logger.warn({ machineId: principal.machineId }, "machine link: hello failed validation");
				ws.close(4000, "the hello frame did not match the protocol");
			}
			return;
		}

		if (!helloReceived) {
			if (frame.type !== "hello") {
				ws.close(4000, "expected hello as the first frame");
				return;
			}
			helloReceived = true;
			clearTimeout(helloTimer);
			void onHello(ws, principal, frame, token).then(
				(created) => {
					state = created;
				},
				(err) => {
					logger.error({ err, machineId: principal.machineId }, "machine link: hello failed");
					ws.close(1011, "could not register this machine");
				}
			);
			return;
		}

		if (!state) return; // hello still being processed; frames before that are dropped
		switch (frame.type) {
			case "res": {
				const pending = state.pending.get(frame.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				state.pending.delete(frame.id);
				if (frame.ok) pending.resolve(frame.result);
				else pending.reject(new OpError(frame.error.code, frame.error.message));
				return;
			}
			case "event": {
				// A machine that predates `rootSessionId` tags nothing: the
				// envelope then roots at its own session, i.e. only direct
				// watchers fire — the same behaviour as before the field.
				const root = frame.rootSessionId ?? frame.sessionId;
				const listeners = state.listeners.get(frame.sessionId);
				// Tree watchers of the root, and of the session itself: a
				// subagent's own view subscribes as a tree too, and its
				// envelopes are rooted at the parent, not at the subagent.
				const treeListeners = new Set([
					...(state.rootListeners.get(root) ?? []),
					...(root !== frame.sessionId ? (state.rootListeners.get(frame.sessionId) ?? []) : []),
				]);
				if ((!listeners || listeners.size === 0) && treeListeners.size === 0) return;
				const envelope: Envelope = {
					sessionId: frame.sessionId,
					epoch: frame.epoch,
					seq: frame.seq,
					rootSessionId: root,
					event: frame.event,
				};
				if (listeners) for (const listener of listeners) listener(envelope);
				for (const listener of treeListeners) listener(envelope);
				return;
			}
			case "credential": {
				touchDeviceRow(state.deviceId, { credentialState: frame.state });
				return;
			}
			case "notice": {
				// Machine-level and lossy (§9.5): no epoch or seq, no replay.
				// Only terminal-scoped notices have a listener today (files.*
				// live-watch notices are F3, not yet wired to anything).
				const terminalId = frame.scope.terminalId;
				if (!terminalId) return;
				const listeners = state.terminalNoticeListeners.get(terminalId);
				if (!listeners) return;
				for (const listener of listeners) listener(frame.event);
				return;
			}
			case "auth": {
				void revalidateMachineAuth(frame.token, state.principal.sub)
					.then((validated) => {
						if (!state) return;
						state.principal = { ...state.principal, exp: validated.exp, iss: validated.iss };
						state.token = frame.token;
						scheduleAuthDeadline(state);
					})
					.catch((err) => {
						logger.warn({ err, deviceId: state?.deviceId }, "machine link: auth renewal rejected");
						if (state) closeConnection(state, 4401, "renewal token invalid");
					});
				return;
			}
			default:
				return;
		}
	});

	ws.on("pong", () => {
		if (state) state.lastPongAt = Date.now();
	});

	ws.on("close", () => {
		clearTimeout(helloTimer);
		if (state && registry.get(state.deviceId) === state) {
			if (state.authDeadline) clearTimeout(state.authDeadline);
			if (state.pingInterval) clearInterval(state.pingInterval);
			for (const pending of state.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new OpError("unavailable", "The machine link closed."));
			}
			registry.delete(state.deviceId);
			notifyConnectionChange(state.deviceId, false);
		}
	});

	ws.on("error", (err) => {
		logger.warn({ err }, "machine link: socket error");
	});
}

async function onHello(
	ws: WebSocket,
	principal: MachinePrincipal,
	hello: import("$lib/types/machineProtocol").HelloFrame,
	token: string
): Promise<ConnectionState | null> {
	const now = new Date();
	const existing = await collections.codeDevices.findOne({
		userId: principal.userId,
		machineId: principal.machineId,
	});

	if (existing?.status === "revoked") {
		try {
			ws.close(4403, "this machine was revoked");
		} catch {
			/* already gone */
		}
		return null;
	}

	let deviceId: string;
	let status: CodeDevice["status"];
	if (existing) {
		deviceId = existing._id.toHexString();
		status = existing.status;
		await collections.codeDevices.updateOne(
			{ _id: existing._id },
			{
				$set: {
					name: principal.machineName,
					sub: principal.sub,
					iss: principal.iss,
					enrolledIssuer: principal.iss,
					backends: hello.backends,
					...(hello.machine ? { machine: hello.machine } : {}),
					policy: hello.policy,
					credentialState: hello.credential.state,
					lastSeenAt: now,
					updatedAt: now,
				},
			}
		);
	} else {
		const inserted = await collections.codeDevices.insertOne({
			_id: new ObjectId(),
			userId: principal.userId,
			machineId: principal.machineId,
			name: principal.machineName,
			status: "pending",
			sub: principal.sub,
			iss: principal.iss,
			enrolledIssuer: principal.iss,
			backends: hello.backends,
			...(hello.machine ? { machine: hello.machine } : {}),
			policy: hello.policy,
			credentialState: hello.credential.state,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		});
		deviceId = inserted.insertedId.toHexString();
		status = "pending";
	}

	// A newer connection for the same machine replaces an older one (§3).
	// Its event listeners move to the new connection first (the same Map
	// instances, so every `subscribeSessionEvents`/`subscribeSessionTree`
	// closure the SSE bridge holds keeps working with no re-subscribe) —
	// otherwise an open bridge silently goes quiet across a machine
	// reconnect, since the fresh connection would start with empty
	// listener maps of its own.
	const previous = registry.get(deviceId);
	const listeners = previous?.listeners ?? new Map();
	const rootListeners = previous?.rootListeners ?? new Map();
	if (previous) closeConnection(previous, 4409, "a newer connection replaced this one");

	const state: ConnectionState = {
		deviceId,
		ws,
		principal,
		token,
		backends: hello.backends,
		policy: hello.policy,
		pending: new Map(),
		listeners,
		rootListeners,
		terminalChannels: new Map(),
		terminalNoticeListeners: new Map(),
		authDeadline: null,
		pingInterval: null,
		lastPongAt: Date.now(),
	};
	registry.set(deviceId, state);
	notifyConnectionChange(deviceId, true);
	scheduleAuthDeadline(state);
	state.pingInterval = setInterval(() => {
		if (Date.now() - state.lastPongAt > PONG_DEAD_AFTER_MS) {
			logger.warn({ deviceId }, "machine link: no pong within the dead-peer window, terminating");
			ws.terminate();
			return;
		}
		try {
			ws.ping();
		} catch {
			/* socket already going away */
		}
	}, PING_INTERVAL_MS);

	try {
		ws.send(JSON.stringify({ type: "welcome", deviceId, status }));
	} catch (err) {
		logger.warn({ err, deviceId }, "machine link: failed to send welcome");
	}
	return state;
}
