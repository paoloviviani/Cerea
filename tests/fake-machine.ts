/**
 * A fake `pystino-agent`: a small Node WebSocket client that speaks the
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
import type {
	Backend,
	Directory,
	Envelope,
	HelloFrame,
	Mode,
	Model,
	NormalizedEvent,
	Policy,
	ReqFrame,
	Session,
	SyncResult,
	Transcript,
	Workspace,
} from "../src/lib/types/machineProtocol";

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
	};
}

export interface FakeMachineOptions {
	backends?: Backend[];
	policy?: Policy;
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
	private opened: Promise<void>;
	private welcomeResolvers: Array<
		(frame: { deviceId: string; status: "pending" | "paired" }) => void
	> = [];
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
		this.ws.on("message", (raw: Buffer | string) => this.handleMessage(raw));
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
	 * within this machine's current epoch. */
	pushEvent(sessionId: string, event: NormalizedEvent): Envelope {
		const seq = (this.model.seq.get(sessionId) ?? 0) + 1;
		this.model.seq.set(sessionId, seq);
		const envelope: Envelope = { sessionId, epoch: this.model.epoch, seq, event };
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
		try {
			const override = this.overrides.get(req.op);
			const result = override ? await override(req.args) : this.defaultAnswer(req.op, req.args);
			this.ws.send(JSON.stringify({ type: "res", id: req.id, ok: true, result }));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.ws.send(
				JSON.stringify({
					type: "res",
					id: req.id,
					ok: false,
					error: { code: "invalid", message },
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
			case "question.reply":
				return {};
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
			case "backend.models":
				return { models: model.models };
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
