/**
 * A fake `galopin`: a small Node WebSocket client that speaks the
 * thin machine agent protocol (`reports/2026-09-24-thin-agent-protocol.md`)
 * well enough to drive Cerea's server-side plumbing (`machines.ts`, the
 * forwarder, the SSE bridge) in tests, without a real Go binary or a real
 * OIDC round trip.
 *
 * Usage: connect to an already-upgraded WebSocket endpoint (vitest server
 * specs call `acceptMachineConnection` directly against an in-memory `ws`
 * pair — see `machine-forwarder.spec.ts`; e2e specs dial the real
 * `/api/v2/code/machine` endpoint with a real bearer). `hello()` sends the
 * first frame; `answer()` and `onOp()` handle `req` frames from Cerea;
 * `pushEvent()` emits scripted `event` frames; `model` is the in-memory
 * workspace/session state `answer()`'s default op handlers read and write.
 */
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { OpError } from "../src/lib/types/machineProtocol";
import type {
	Backend,
	Command,
	Directory,
	Envelope,
	HelloFrame,
	Mode,
	Model,
	NormalizedEvent,
	Notice,
	PermissionRule,
	Policy,
	SessionRuleInput,
	ReqFrame,
	SavedApproval,
	Session,
	SyncResult,
	Terminal,
	Transcript,
	Workspace,
	Machine,
} from "../src/lib/types/machineProtocol";
import {
	encodeBinaryFrame,
	decodeBinaryFrame,
	BIN_TERM_OUTPUT,
	BIN_TERM_INPUT,
	BIN_TERM_ACK,
} from "../src/lib/types/machineProtocol";

/** One fake terminal's state: enough to exercise attach/reattach, resize
 * ownership, credits and a forced reset — never a real PTY. */
export interface FakeTerminalState {
	snapshot: Terminal;
	/** Every byte ever produced, from offset 0 — trimmed at `ringStart` by
	 * `evictTerminalRing` to simulate the real 2 MiB ring's eviction. */
	history: Buffer;
	ringStart: number;
	viewers: Map<string, { acked: number; sentUpTo: number }>;
	/** Backlogged bytes per viewer, held back by the credit window
	 * (PROTOCOL.md §9.2: at most 256 KiB of output in flight per viewer). */
	backlog: Map<string, Buffer>;
	sizeClaimed: boolean;
}

const TERMINAL_CREDIT_WINDOW = 256 * 1024;
const TERMINAL_MAX_OUTPUT_FRAME = 32 * 1024;

export interface FakeMachineModel {
	workspaces: Workspace[];
	/** What `workspace.suggest` answers with, regardless of prefix — tests
	 * set this directly rather than the fake walking a real filesystem. */
	directories: Directory[];
	sessions: Session[];
	/** Per-session transcript, for `session.sync`'s snapshot branch. */
	transcripts: Map<string, Transcript>;
	/** Per-session epoch/seq, for tagging pushed events (spec §7). */
	epoch: string;
	seq: Map<string, number>;
	modes: Mode[];
	models: Model[];
	/** The workspace's slash commands `backend.commands` answers with —
	 * tests set this directly; empty by default. */
	commands: Command[];
	terminals: Map<string, FakeTerminalState>;
	/** MOCK — the agent half (feat/permission-agent) is being built
	 * concurrently, so everything here is the panel's reading of the frozen
	 * contract (`session.setRules {sessionId, rules}`, capped application,
	 * `permission.rules` shows the truth), not galopin's behaviour.
	 * The rules the machine has before any session rule or the ceiling tail
	 * (what `permission.rules` lists first, with whatever `source` a test
	 * gives them — or none). */
	permissionRules: PermissionRule[];
	/** MOCK — the ceiling: permission key -> the most it may ever be. */
	permissionCeiling: Record<string, "ask" | "deny">;
	/** MOCK — what a rule above the ceiling does: lowered to it, or refused. */
	overCeiling: "clamp" | "refuse";
	/** MOCK — the rules each session was given through `session.setRules`,
	 * after the ceiling had its say (source "cerea"). */
	sessionRules: Map<string, SessionRuleInput[]>;
	/** MOCK — the "always" approvals `permission.rules` lists, and the ones
	 * `permission.saved.remove` deletes by id. */
	savedApprovals: SavedApproval[];
}

export function emptyModel(): FakeMachineModel {
	return {
		workspaces: [],
		directories: [],
		sessions: [],
		transcripts: new Map(),
		epoch: randomUUID(),
		seq: new Map(),
		modes: [
			{ id: "plan", label: "Plan" },
			{ id: "build", label: "Build" },
		],
		models: [{ id: "opencode/coder", label: "Coder", providerId: "opencode", isDefault: true }],
		commands: [],
		terminals: new Map(),
		permissionRules: [],
		permissionCeiling: {},
		overCeiling: "clamp",
		sessionRules: new Map(),
		savedApprovals: [],
	};
}

export interface FakeMachineOptions {
	backends?: Backend[];
	policy?: Policy;
	/** hello.machine (§9): e.g. { capabilities: { files: true } }. */
	machine?: Machine;
	credentialState?: "ok" | "expiring" | "expired";
	agentVersion?: string;
	hostname?: string;
}

const DEFAULT_BACKEND: Backend = {
	id: "opencode",
	version: "1.18.31",
	capabilities: {
		diff: true,
		children: true,
		usage: true,
		compact: true,
		images: true,
		files: true,
		worktrees: false,
		autoAccept: true,
		questions: true,
	},
};

const DEFAULT_POLICY: Policy = {
	autoAccept: "denied",
	workspaceRoots: [],
	allowFreeModels: false,
};

/** One connected fake machine. Holds the raw `ws` socket, the in-memory
 * model ops answer from, and a table of custom per-op overrides a test may
 * install before or after connecting. */
export class FakeMachine {
	readonly model: FakeMachineModel;
	readonly ws: WebSocket;
	private overrides = new Map<string, (args: unknown) => unknown>();
	/** Every op Cerea sent, in order — lets a spec assert which ops a panel
	 * action did NOT cause (e.g. that no op ever writes a permission rule). */
	readonly opLog: Array<{ op: string; args: unknown }> = [];
	/** Deliver an attach's backlog before its reply, as a real machine's
	 * reply and first output frame can land in the same read: Cerea must
	 * still send the browser `reset` before that backlog. */
	flushBacklogBeforeAttachReply = false;
	private opened: Promise<void>;
	private welcomeResolvers: Array<
		(frame: { deviceId: string; status: "pending" | "paired" }) => void
	> = [];
	/** channel id → terminalId, set at `terminal.attach` — mirrors galopin's
	 * own `channelTerminal` map (dispatch.go), which is how it knows where
	 * an inbound `term.input`/`term.ack` on a given channel goes. */
	private channelTerminal = new Map<string, string>();
	deviceId: string | null = null;
	status: "pending" | "paired" | null = null;

	constructor(
		url: string,
		headers: Record<string, string>,
		private readonly options: FakeMachineOptions = {},
		model: FakeMachineModel = emptyModel()
	) {
		this.model = model;
		this.ws = new WebSocket(url, { headers });
		this.opened = new Promise((resolve, reject) => {
			this.ws.on("open", () => resolve());
			this.ws.on("error", reject);
		});
		this.ws.on("message", (raw: Buffer | string, isBinary: boolean) => {
			if (isBinary && Buffer.isBuffer(raw)) {
				this.handleBinaryMessage(raw);
				return;
			}
			this.handleMessage(raw);
		});
	}

	async ready(): Promise<void> {
		await this.opened;
	}

	/** Send `hello` and wait for `welcome`. */
	async hello(): Promise<{ deviceId: string; status: "pending" | "paired" }> {
		await this.opened;
		const frame: HelloFrame = {
			type: "hello",
			protocol: 1,
			agent: {
				version: this.options.agentVersion ?? "0.1.0",
				os: "linux",
				arch: "amd64",
				hostname: this.options.hostname ?? "fake-machine",
			},
			backends: this.options.backends ?? [DEFAULT_BACKEND],
			...(this.options.machine ? { machine: this.options.machine } : {}),
			policy: this.options.policy ?? DEFAULT_POLICY,
			credential: { state: this.options.credentialState ?? "ok" },
		};
		const welcome = new Promise<{ deviceId: string; status: "pending" | "paired" }>((resolve) => {
			this.welcomeResolvers.push(resolve);
		});
		this.ws.send(JSON.stringify(frame));
		const result = await welcome;
		this.deviceId = result.deviceId;
		this.status = result.status;
		return result;
	}

	/** Wait for the browser-confirm `status` push (spec §4). */
	waitForPaired(timeoutMs = 5000): Promise<void> {
		if (this.status === "paired") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting to be paired")),
				timeoutMs
			);
			const onMessage = (raw: Buffer | string) => {
				const parsed = JSON.parse(raw.toString()) as { type?: string; status?: string };
				if (parsed.type === "status" && parsed.status === "paired") {
					this.status = "paired";
					clearTimeout(timer);
					this.ws.off("message", onMessage);
					resolve();
				}
			};
			this.ws.on("message", onMessage);
		});
	}

	/** Install a custom answer for one op, overriding the default model-backed
	 * handler — for tests that need a specific error or a scripted delay. */
	onOp<T>(op: string, handler: (args: T) => unknown): void {
		this.overrides.set(op, handler as (args: unknown) => unknown);
	}

	/** Push a normalized event for one session, auto-incrementing its seq
	 * within this machine's current epoch. `rootSessionId` tags the
	 * envelope's tree root (itself when omitted) — the field a real
	 * galopin always sends. */
	pushEvent(sessionId: string, event: NormalizedEvent, rootSessionId?: string): Envelope {
		const seq = (this.model.seq.get(sessionId) ?? 0) + 1;
		this.model.seq.set(sessionId, seq);
		const envelope: Envelope = {
			sessionId,
			epoch: this.model.epoch,
			seq,
			rootSessionId: rootSessionId ?? sessionId,
			event,
		};
		this.ws.send(JSON.stringify({ type: "event", ...envelope }));
		return envelope;
	}

	/** Push a `credential` frame. */
	pushCredential(state: "ok" | "expiring" | "expired", detail?: string): void {
		this.ws.send(JSON.stringify({ type: "credential", state, ...(detail ? { detail } : {}) }));
	}

	/** Simulate a restart: a fresh epoch, seq counters reset. Subsequent
	 * `pushEvent` calls use the new epoch. */
	restartEpoch(): void {
		this.model.epoch = randomUUID();
		this.model.seq.clear();
	}

	close(code?: number, reason?: string): void {
		this.ws.close(code, reason);
	}

	/** Push a `notice` frame (§7.1/§9.5): machine-level, lossy, unsequenced. */
	pushNotice(scope: { workspaceId?: string; terminalId?: string }, event: Notice): void {
		this.ws.send(JSON.stringify({ type: "notice", scope, event }));
	}

	/**
	 * Simulates the shell process exiting on its own (`exit` typed inside
	 * it, or a killed job) — not a `terminal.close` op, which is Cerea
	 * asking to end it. A real PTY can exit independent of any request;
	 * this fake has no real PTY to do that, so a hermetic "the exit state"
	 * case drives it through here instead.
	 */
	exitTerminal(terminalId: string, exitCode: number): void {
		const t = requireTerminal(this.model, terminalId);
		t.snapshot = { ...t.snapshot, state: "exited", exitCode };
		for (const channel of t.viewers.keys()) this.channelTerminal.delete(channel);
		t.viewers.clear();
		t.backlog.clear();
		this.pushNotice({ terminalId }, { kind: "terminal.exit", exitCode });
	}

	/**
	 * Appends `data` to a terminal's history and pushes it to every attached
	 * viewer that has credit, exactly like a script's output or an echoed
	 * keystroke would arrive from a real PTY. Frames are capped at 32 KiB
	 * and held back (backlogged) past a viewer's 256 KiB credit window
	 * (PROTOCOL.md §9.2) until it acks.
	 */
	pushTerminalOutput(terminalId: string, data: Buffer): void {
		const t = requireTerminal(this.model, terminalId);
		t.history = Buffer.concat([t.history, data]);
		t.snapshot = { ...t.snapshot, offset: t.snapshot.offset + data.length };
		for (const channel of t.viewers.keys()) {
			const backlog = t.backlog.get(channel) ?? Buffer.alloc(0);
			t.backlog.set(channel, Buffer.concat([backlog, data]));
			this.flushViewer(terminalId, channel);
		}
	}

	/** Drains as much of a viewer's backlog as its credit window allows,
	 * one ≤32 KiB frame per call site's trigger (an ack, or fresh output). */
	private flushViewer(terminalId: string, channel: string): void {
		const t = this.model.terminals.get(terminalId);
		if (!t) return;
		const viewer = t.viewers.get(channel);
		if (!viewer) return;
		// Drains the whole backlog in as many ≤32 KiB frames as the credit
		// window allows right now, not just one — a single push (or a single
		// ack that frees up a lot of room at once) must not need a second,
		// unrelated trigger to keep draining.
		for (;;) {
			const backlog = t.backlog.get(channel);
			if (!backlog || backlog.length === 0) return;
			const available = TERMINAL_CREDIT_WINDOW - (viewer.sentUpTo - viewer.acked);
			if (available <= 0) return;
			const chunk = backlog.subarray(
				0,
				Math.min(backlog.length, available, TERMINAL_MAX_OUTPUT_FRAME)
			);
			if (chunk.length === 0) return;
			const offset = viewer.sentUpTo;
			viewer.sentUpTo += chunk.length;
			t.backlog.set(channel, backlog.subarray(chunk.length));
			this.ws.send(
				encodeBinaryFrame({ kind: BIN_TERM_OUTPUT, channel, offset, payload: Buffer.from(chunk) })
			);
		}
	}

	/** Simulates ring eviction: content before `newStart` is gone, so a
	 * viewer that later attaches asking for an offset below it gets `reset`
	 * — the "forced reset path" hermetic case. */
	evictTerminalRing(terminalId: string, newStart: number): void {
		const t = requireTerminal(this.model, terminalId);
		t.ringStart = Math.max(t.ringStart, newStart);
	}

	private handleBinaryMessage(raw: Buffer): void {
		const frame = decodeBinaryFrame(raw);
		if (!frame) return;
		const terminalId = this.channelTerminal.get(frame.channel);
		if (!terminalId) return;
		const t = this.model.terminals.get(terminalId);
		if (!t) return;
		if (frame.kind === BIN_TERM_INPUT) {
			// The default fake behaviour is an echo, like a real shell with
			// local echo off would not do, but is what lets a hermetic spec
			// assert "type X, see X" without scripting output for every case.
			this.pushTerminalOutput(terminalId, Buffer.from(frame.payload));
			return;
		}
		if (frame.kind === BIN_TERM_ACK) {
			const viewer = t.viewers.get(frame.channel);
			if (viewer && frame.offset > viewer.acked) viewer.acked = frame.offset;
			this.flushViewer(terminalId, frame.channel);
		}
	}

	private handleMessage(raw: Buffer | string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) return;
		const frame = parsed as unknown as { type: string };
		if (frame.type === "welcome") {
			const welcome = parsed as unknown as { deviceId: string; status: "pending" | "paired" };
			const resolver = this.welcomeResolvers.shift();
			resolver?.(welcome);
			return;
		}
		if (frame.type === "req") {
			void this.handleReq(parsed as ReqFrame);
			return;
		}
		if (frame.type === "auth" || frame.type === "status") {
			return; // nothing to do for a fake machine
		}
	}

	private async handleReq(req: ReqFrame): Promise<void> {
		this.opLog.push({ op: req.op, args: req.args });
		try {
			const override = this.overrides.get(req.op);
			const result = override ? await override(req.args) : this.defaultAnswer(req.op, req.args);
			this.ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, result }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A thrown OpError carries its own code — the gate refusals the
			// command specs need to map (unsupported/conflict/forbidden);
			// anything else is the generic invalid.
			const code = err instanceof OpError ? err.code : "invalid";
			this.ws.send(
				JSON.stringify({
					type: "res",
					id: req.id,
					ok: false,
					error: { code, message },
				})
			);
		}
	}

	/** The built-in, in-memory-model-backed answer for every op in spec §6 —
	 * enough for a forwarder/bridge test that just needs plausible, mutable
	 * state, without every test writing its own handler. */
	private defaultAnswer(op: string, args: unknown): unknown {
		const model = this.model;
		switch (op) {
			case "workspace.list":
				return { workspaces: model.workspaces };
			case "workspace.suggest": {
				const { prefix } = args as { prefix: string };
				return { directories: model.directories.filter((d) => d.path.startsWith(prefix)) };
			}
			case "workspace.create": {
				const a = args as {
					path?: string;
					title?: string;
					worktree?: { from: string; branch: string; base?: string };
				};
				if (a.worktree) {
					const from = requireWorkspace(model, a.worktree.from);
					const workspace: Workspace = {
						id: randomUUID(),
						name: a.title ?? a.worktree.branch,
						path: `${from.path}.worktrees/${a.worktree.branch}`,
						createdAt: new Date().toISOString(),
						isGitRepo: true,
						worktreeOf: from.id,
						branch: a.worktree.branch,
					};
					model.workspaces.push(workspace);
					return { workspace };
				}
				const path = a.path as string;
				const workspace: Workspace = {
					id: randomUUID(),
					name: a.title ?? path.split("/").filter(Boolean).pop() ?? path,
					path,
					createdAt: new Date().toISOString(),
					isGitRepo: false,
				};
				model.workspaces.push(workspace);
				return { workspace };
			}
			case "workspace.rename": {
				const { workspaceId, title } = args as { workspaceId: string; title: string };
				const workspace = requireWorkspace(model, workspaceId);
				workspace.name = title;
				return { workspace };
			}
			case "workspace.archive": {
				const { workspaceId } = args as { workspaceId: string };
				model.workspaces = model.workspaces.filter((w) => w.id !== workspaceId);
				model.sessions = model.sessions.filter((s) => s.workspaceId !== workspaceId);
				return {};
			}
			case "session.list": {
				const { workspaceId } = (args as { workspaceId?: string }) ?? {};
				const sessions = workspaceId
					? model.sessions.filter((s) => s.workspaceId === workspaceId)
					: model.sessions;
				return { sessions };
			}
			case "session.get": {
				const { sessionId } = args as { sessionId: string };
				return { session: requireSession(model, sessionId) };
			}
			case "session.create": {
				const { workspaceId, backend, title, modeId, modelId } = args as {
					workspaceId: string;
					backend?: string;
					title?: string;
					modeId?: string;
					modelId?: string;
				};
				const now = new Date().toISOString();
				const session: Session = {
					id: randomUUID(),
					workspaceId,
					backend: backend ?? "opencode",
					title: title ?? "New session",
					status: "idle",
					pendingPermissions: 0,
					modeId: modeId ?? null,
					modelId: modelId ?? null,
					autoAccept: false,
					parentId: null,
					createdAt: now,
					updatedAt: now,
					usage: null,
				};
				model.sessions.push(session);
				model.transcripts.set(session.id, {
					messages: [],
					permissions: [],
					status: "idle",
					usage: null,
					todos: [],
				});
				return { session };
			}
			case "session.prompt":
				return {};
			case "session.cancel":
				return {};
			case "session.rename": {
				const { sessionId, title } = args as { sessionId: string; title: string };
				const session = requireSession(model, sessionId);
				session.title = title;
				return { session };
			}
			case "session.archive":
			case "session.delete": {
				const { sessionId } = args as { sessionId: string };
				model.sessions = model.sessions.filter((s) => s.id !== sessionId);
				return {};
			}
			case "session.setMode": {
				const { sessionId, modeId } = args as { sessionId: string; modeId: string };
				const session = requireSession(model, sessionId);
				session.modeId = modeId;
				return { session };
			}
			case "session.setModel": {
				const { sessionId, modelId } = args as { sessionId: string; modelId: string };
				const session = requireSession(model, sessionId);
				session.modelId = modelId;
				return { session };
			}
			case "session.setAutoAccept": {
				const { sessionId, enabled } = args as { sessionId: string; enabled: boolean };
				const session = requireSession(model, sessionId);
				session.autoAccept = enabled;
				return { session };
			}
			case "permission.reply":
				return {};
			// MOCK of the contract with the agent half, unverified against real
			// galopin: a read that tells the truth about what is in force, a
			// session-rule writer that applies a ceiling, and a tighten-only
			// delete by id.
			case "permission.rules": {
				const { sessionId } = args as { sessionId: string };
				const cerea = (model.sessionRules.get(sessionId) ?? []).map((rule) => ({
					...rule,
					source: "cerea",
				}));
				const tail = Object.entries(model.permissionCeiling).map(([permission, action]) => ({
					permission,
					pattern: "*",
					action,
					source: "ceiling",
				}));
				return {
					rules: [...model.permissionRules, ...cerea, ...tail],
					savedApprovals: model.savedApprovals,
					ceiling: model.permissionCeiling,
				};
			}
			case "session.setRules": {
				const { sessionId, rules } = args as { sessionId: string; rules: SessionRuleInput[] };
				requireSession(model, sessionId);
				const rank = { deny: 0, ask: 1, allow: 2 } as const;
				const applied: SessionRuleInput[] = [];
				for (const rule of rules) {
					const max = model.permissionCeiling[rule.permission] ?? model.permissionCeiling["*"];
					if (max && rank[rule.action] > rank[max]) {
						if (model.overCeiling === "refuse") {
							throw new OpError(
								"forbidden",
								`${rule.permission} may not exceed ${max} on this machine.`
							);
						}
						applied.push({ ...rule, action: max });
					} else {
						applied.push({ ...rule });
					}
				}
				model.sessionRules.set(sessionId, applied);
				return {};
			}
			case "permission.saved.remove": {
				const { id } = args as { id: string; sessionId: string };
				const found = model.savedApprovals.find((approval) => approval.id === id);
				if (!found) throw new OpError("not_found", "No such saved approval.");
				if (found.removable === false) {
					throw new OpError("forbidden", "This approval cannot be withdrawn from here.");
				}
				model.savedApprovals = model.savedApprovals.filter((approval) => approval.id !== id);
				return {};
			}
			case "question.reply":
				return {};
			case "permissions.pending":
				return { permissions: [], questions: [] };
			case "session.sync": {
				const { sessionId } = args as { sessionId: string; epoch?: string; afterSeq?: number };
				const result: SyncResult = {
					epoch: model.epoch,
					seq: model.seq.get(sessionId) ?? 0,
					snapshot: model.transcripts.get(sessionId) ?? {
						messages: [],
						permissions: [],
						status: "idle",
						usage: null,
						todos: [],
					},
				};
				return result;
			}
			case "session.diff":
				return { files: [] };
			case "session.children":
				return {
					sessions: model.sessions.filter(
						(s) => s.parentId === (args as { sessionId: string }).sessionId
					),
				};
			case "backend.modes":
				return { modes: model.modes };
			case "backend.commands":
				return { commands: model.commands ?? [] };
			case "session.command":
				return {};
			case "backend.models":
				return { models: model.models };
			case "terminal.list": {
				const { workspaceId } = (args as { workspaceId?: string }) ?? {};
				const terminals = [...model.terminals.values()]
					.map((t) => t.snapshot)
					.filter((t) => !workspaceId || t.workspaceId === workspaceId);
				return { terminals };
			}
			case "terminal.open": {
				const a = args as {
					workspaceId: string;
					cwd?: string;
					cols: number;
					rows: number;
					title?: string;
				};
				const id = randomUUID();
				const snapshot: Terminal = {
					id,
					workspaceId: a.workspaceId,
					title: a.title ?? "Terminal",
					cwd: a.cwd ?? ".",
					shell: "/bin/sh",
					cols: a.cols,
					rows: a.rows,
					pid: 1000 + model.terminals.size,
					createdAt: new Date().toISOString(),
					state: "running",
					offset: 0,
					viewers: 0,
				};
				model.terminals.set(id, {
					snapshot,
					history: Buffer.alloc(0),
					ringStart: 0,
					viewers: new Map(),
					backlog: new Map(),
					sizeClaimed: false,
				});
				this.pushNotice({ terminalId: id }, { kind: "terminal.state", terminal: snapshot });
				return { terminal: snapshot };
			}
			case "terminal.attach": {
				const a = args as { terminalId: string; channel: string; from?: number };
				const t = requireTerminal(model, a.terminalId);
				const requested = a.from ?? 0;
				const reset = a.from === undefined || requested < t.ringStart;
				const effectiveFrom = Math.max(requested, t.ringStart);
				t.viewers.set(a.channel, { acked: effectiveFrom, sentUpTo: effectiveFrom });
				// `history` is never physically trimmed (index 0 is always
				// absolute offset 0); `ringStart` only marks the eviction point
				// for the reset decision above, mirroring the real ring's
				// "content before ringStart is gone" without discarding bytes
				// a hermetic test may still want to inspect.
				t.backlog.set(a.channel, t.history.subarray(effectiveFrom));
				this.channelTerminal.set(a.channel, a.terminalId);
				t.snapshot = { ...t.snapshot, viewers: t.snapshot.viewers + 1 };
				if (this.flushBacklogBeforeAttachReply) this.flushViewer(a.terminalId, a.channel);
				else queueMicrotask(() => this.flushViewer(a.terminalId, a.channel));
				return {
					terminal: t.snapshot,
					from: effectiveFrom,
					reset,
					...(reset ? { prelude: "" } : {}),
				};
			}
			case "terminal.detach": {
				const a = args as { terminalId: string; channel: string };
				const t = requireTerminal(model, a.terminalId);
				t.viewers.delete(a.channel);
				t.backlog.delete(a.channel);
				this.channelTerminal.delete(a.channel);
				t.snapshot = { ...t.snapshot, viewers: Math.max(0, t.snapshot.viewers - 1) };
				return {};
			}
			case "terminal.resize": {
				const a = args as { terminalId: string; cols: number; rows: number; claim?: boolean };
				const t = requireTerminal(model, a.terminalId);
				const claim = a.claim ?? true;
				if (t.sizeClaimed && !claim) return { applied: false };
				if (claim) t.sizeClaimed = true;
				t.snapshot = { ...t.snapshot, cols: a.cols, rows: a.rows };
				return { applied: true };
			}
			case "terminal.rename": {
				const a = args as { terminalId: string; title: string };
				const t = requireTerminal(model, a.terminalId);
				t.snapshot = { ...t.snapshot, title: a.title };
				this.pushNotice(
					{ terminalId: a.terminalId },
					{ kind: "terminal.state", terminal: t.snapshot }
				);
				return { terminal: t.snapshot };
			}
			case "terminal.close": {
				const a = args as { terminalId: string; force?: boolean };
				const t = requireTerminal(model, a.terminalId);
				if (t.snapshot.state === "exited") {
					// Mirrors galopin's Manager.Remove (dispatch.go's
					// opTerminalClose): Close/Remove on an already-exited
					// terminal means gone for good, not "signal a dead process
					// again and keep it around for display".
					model.terminals.delete(a.terminalId);
					return {};
				}
				t.snapshot = { ...t.snapshot, state: "exited", exitCode: 0 };
				for (const channel of t.viewers.keys()) this.channelTerminal.delete(channel);
				t.viewers.clear();
				t.backlog.clear();
				this.pushNotice({ terminalId: a.terminalId }, { kind: "terminal.exit", exitCode: 0 });
				return {};
			}
			default:
				throw new Error(`fake machine: no default answer for op "${op}"`);
		}
	}
}

function requireWorkspace(model: FakeMachineModel, workspaceId: string): Workspace {
	const workspace = model.workspaces.find((w) => w.id === workspaceId);
	if (!workspace) throw new Error(`fake machine: no such workspace ${workspaceId}`);
	return workspace;
}

function requireSession(model: FakeMachineModel, sessionId: string): Session {
	const session = model.sessions.find((s) => s.id === sessionId);
	if (!session) throw new Error(`fake machine: no such session ${sessionId}`);
	return session;
}

function requireTerminal(model: FakeMachineModel, terminalId: string): FakeTerminalState {
	const terminal = model.terminals.get(terminalId);
	if (!terminal) throw new Error(`fake machine: no such terminal ${terminalId}`);
	return terminal;
}
