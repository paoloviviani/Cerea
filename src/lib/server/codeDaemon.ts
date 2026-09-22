import { error } from "@sveltejs/kit";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { getPairedDevice } from "$lib/server/codeDevices";
import type {
	CodeAgentSession,
	CodeFileChange,
	CodeWorkspace,
	CodeTurnState,
} from "$lib/types/CodeAgent";

type FetchAgentTimelinePayload = FetchAgentTimelineResponseMessage["payload"];
/** Whatever `getCheckoutDiff` actually answers with — parsed diff files. */
type CheckoutDiffPayload = Awaited<ReturnType<DaemonClient["getCheckoutDiff"]>>;
/**
 * How the Cerea server reaches a paired person's daemon: through the relay,
 * as an end-to-end-encrypted paseo client, one connection per paired device.
 *
 * The daemon's control surface is its WebSocket session protocol — its own
 * clients (web, mobile, CLI) speak it, and the typed SDK (`@getpaseo/client`)
 * is the supported way in; there is no REST surface to forward HTTP to (ADR
 * 0085). So instead of a URL and a bearer token, a device's pairing row now
 * carries the two things a relay client needs: the daemon's `serverId` (the
 * relay's route key, stored as `daemonId`) and its Curve25519 public key
 * (stored as `daemonPublicKey`, with credential discipline — the pairing
 * offer is the daemon's bearer capability). The relay address itself is the
 * deployment's (`CODE_RELAY_URL`), never taken from the pasted offer, so a
 * crafted offer cannot point Cerea at a different rendezvous.
 *
 * Each paired device gets at most one `DaemonClient`, created on first use
 * and reused across requests: the connection dials outbound to the relay,
 * performs the NaCl handshake, and stays up. A daemon that answers with a
 * different `serverId` than the row recorded is refused outright — that is
 * not our person's machine. The pinned SDK version is the API contract
 * (`PASEO_SDK_VERSION`); the daemon's own reported version must match its
 * minor or the link refuses to serve rather than guessing at shapes.
 */

/** Exact-pin of @getpaseo/client and @getpaseo/protocol in package.json. */
export const PASEO_SDK_VERSION = "0.8.0";

/** The relay Cerea dials. Deployment config, like the old daemon URL. */
function relayBaseUrl(): string {
	const raw = config.CODE_RELAY_URL?.trim();
	if (!raw) {
		error(404, "No coding-agent relay is configured in this deployment.");
	}
	return raw.replace(/\/$/, "");
}

interface DeviceIdentity {
	/** The paired row's id — the pool key. */
	deviceId: string;
	/** The paseo daemon's serverId: the relay routes by it. */
	serverId: string;
	/** The daemon's Curve25519 public key (base64) from its pairing offer. */
	daemonPublicKey: string;
}

/** The daemon minor this server was coded against; a skew is refused, not guessed at. */
function versionMinor(version: string | null | undefined): string | null {
	if (!version) return null;
	const match = /^(\d+\.\d+)\./.exec(version);
	return match?.[1] ?? null;
}

class DeviceDaemonLink {
	private client: DaemonClient | null = null;
	private connecting: Promise<void> | null = null;
	private statusOk = false;

	constructor(private readonly identity: DeviceIdentity) {}

	/**
	 * One daemon operation, with the connection and its failure mode
	 * handled here: a relay hiccup or a dropped daemon is this deployment's
	 * 502, never an unhandled 500.
	 */
	private async operate<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
		const client = await this.ensureReady();
		try {
			return await fn(client);
		} catch (err) {
			if (err && typeof err === "object" && "status" in err) throw err;
			logger.error({ err, deviceId: this.identity.deviceId }, "paseo daemon call failed");
			error(502, "The coding-agent daemon could not be reached through the relay.");
		}
	}

	async ensureReady(): Promise<DaemonClient> {
		if (this.client && this.statusOk) return this.client;
		if (!this.connecting) {
			this.connecting = this.connect().finally(() => {
				this.connecting = null;
			});
		}
		await this.connecting;
		if (!this.client || !this.statusOk) error(502, "The coding-agent daemon could not be reached.");
		return this.client;
	}

	private async connect(): Promise<void> {
		this.statusOk = false;
		const base = relayBaseUrl();
		const useTls = base.startsWith("wss://") || base.startsWith("https://");
		const hostPort = base.replace(/^wss?:\/\//, "").replace(/^https?:\/\//, "");
		const url = buildRelayWebSocketUrl({
			endpoint: hostPort,
			useTls,
			serverId: this.identity.serverId,
			role: "client",
			version: "2",
		});
		const client = new DaemonClient({
			url,
			clientId: "cerea-code-panel",
			// The machine client type: Cerea is not a phone or a browser tab.
			clientType: "hub",
			appVersion: PASEO_SDK_VERSION,
			e2ee: { enabled: true, daemonPublicKeyB64: this.identity.daemonPublicKey },
			reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15_000 },
			logger: {
				debug: () => {},
				info: () => {},
				warn: (obj, msg) =>
					logger.warn({ ...obj, deviceId: this.identity.deviceId }, msg ?? "paseo link warning"),
				error: (obj, msg) =>
					logger.error({ ...obj, deviceId: this.identity.deviceId }, msg ?? "paseo link error"),
			},
		});
		try {
			await client.connect();
			const status = await client.getDaemonStatus();
			if (status.serverId !== this.identity.serverId) {
				// The relay routed us somewhere else than the row's daemon:
				// refuse rather than drive a stranger's machine.
				logger.error(
					{ expected: this.identity.serverId, answered: status.serverId },
					"paseo daemon serverId mismatch through the relay"
				);
				client.close();
				error(502, "The paired daemon answered with a different identity.");
			}
			if (versionMinor(status.version) !== versionMinor(PASEO_SDK_VERSION)) {
				logger.error(
					{ daemonVersion: status.version, pinned: PASEO_SDK_VERSION },
					"paseo daemon version mismatch"
				);
				client.close();
				error(502, "The paired daemon speaks an unsupported API version.");
			}
			this.client = client;
			this.statusOk = true;
		} catch (err) {
			client.close();
			if (err && typeof err === "object" && "status" in err) throw err;
			logger.error({ err, deviceId: this.identity.deviceId }, "paseo daemon link failed");
			error(502, "The coding-agent daemon could not be reached through the relay.");
		}
	}

	/** The agent's cwd, needed by the diff surface, from one fetch. */
	async agentCwd(agentId: string): Promise<string> {
		const result = await this.operate((client) => client.fetchAgent(agentId));
		if (!result) error(404, "No such agent on this daemon.");
		return result.agent.cwd;
	}

	async listWorkspaces(): Promise<CodeWorkspace[]> {
		const result = await this.operate((client) => client.fetchWorkspaces());
		return result.entries.map(toWorkspace);
	}

	/** A workspace backed by an existing directory on the daemon's machine.
	 * The only source the panel offers: the person names a checkout they
	 * can see, and the daemon serves agents from it. Worktree/forge
	 * sources stay daemon-side (the `paseo` CLI), not proxied. */
	async createWorkspace(input: { path: string; title?: string }): Promise<CodeWorkspace> {
		const result = await this.operate((client) =>
			client.createWorkspace({
				source: { kind: "directory", path: input.path },
				title: input.title,
			})
		);
		if (!result.workspace) error(502, "The daemon refused the workspace.");
		return toWorkspace(result.workspace);
	}

	async getWorkspace(workspaceId: string): Promise<CodeWorkspace> {
		const all = await this.listWorkspaces();
		const found = all.find((workspace) => workspace.id === workspaceId);
		if (!found) error(404, "No such workspace on this daemon.");
		return found;
	}

	async listAgents(workspaceId?: string): Promise<CodeAgentSession[]> {
		const result = await this.operate((client) => client.fetchAgents());
		const mapped = result.entries.map((entry) => toSession(entry.agent));
		return workspaceId ? mapped.filter((agent) => agent.workspaceId === workspaceId) : mapped;
	}

	async getAgent(agentId: string): Promise<CodeAgentSession> {
		const result = await this.operate((client) => client.fetchAgent(agentId));
		if (!result) error(404, "No such agent on this daemon.");
		return toSession(result.agent);
	}

	async createAgent(input: {
		provider: string;
		cwd: string;
		posture: "plan" | "write";
		title?: string;
		workspaceId?: string;
	}): Promise<CodeAgentSession> {
		const agent = await this.operate((client) =>
			client.createAgent({
				provider: input.provider,
				cwd: input.cwd,
				workspaceId: input.workspaceId,
				modeId: input.posture === "write" ? "build" : "plan",
				title: input.title ?? null,
			})
		);
		return toSession(agent);
	}

	/** The provider ids the daemon actually has. The panel offers exactly
	 * these for a new agent — never a hardcoded list that would drift from
	 * what the daemon can run. */
	async listProviders(): Promise<Array<{ id: string; available: boolean }>> {
		const result = await this.operate((client) => client.listAvailableProviders());
		return result.providers.map((p) => ({ id: p.provider, available: p.available }));
	}

	async deleteAgent(agentId: string): Promise<void> {
		await this.operate((client) => client.deleteAgent(agentId));
	}

	/** Archive a session: it leaves the daemon's active lists, its transcript
	 * archived with it — the panel's tree follows the daemon's listings, so
	 * the row goes when the daemon says so, not before. Nothing on disk
	 * changes; this is not the hard delete `deleteAgent` performs. */
	async archiveAgentSession(agentId: string): Promise<void> {
		await this.operate((client) => client.archiveAgent(agentId));
	}

	/** Archive a workspace: the daemon drops it and its sessions from its
	 * active lists, and its local directories are untouched — the daemon owns
	 * the worktree lifecycle, and the workspace's project may back other
	 * checkouts, so `removeProject` is never the panel's move. The refusal
	 * travels in the payload, not as a thrown error. */
	async archiveWorkspace(workspaceId: string): Promise<void> {
		const result = await this.operate((client) => client.archiveWorkspace(workspaceId));
		if (result.error) {
			error(502, `The daemon refused to archive the workspace: ${result.error}`);
		}
	}

	async sendAgentMessage(agentId: string, text: string, posture: "plan" | "write"): Promise<void> {
		await this.operate(async (client) => {
			// Posture is the daemon's own mode switch: plan proposes, build writes.
			await client.setAgentMode(agentId, posture === "write" ? "build" : "plan");
			await client.sendAgentMessage(agentId, text);
		});
	}

	async respondPermission(
		agentId: string,
		requestId: string,
		decision: "approve" | "deny"
	): Promise<void> {
		await this.operate((client) =>
			client.respondToPermission(agentId, requestId, {
				behavior: decision === "approve" ? "allow" : "deny",
			})
		);
	}

	async fetchTimeline(agentId: string): Promise<FetchAgentTimelinePayload> {
		return this.operate((client) =>
			client.fetchAgentTimeline(agentId, { direction: "tail", limit: 500 })
		);
	}

	async fetchDiff(agentId: string): Promise<CheckoutDiffPayload> {
		const cwd = await this.agentCwd(agentId);
		return this.operate((client) => client.getCheckoutDiff(cwd, { mode: "uncommitted" }));
	}

	close(): void {
		this.statusOk = false;
		this.client?.close();
		this.client = null;
	}
}

function toWorkspace(payload: {
	id: string;
	name?: string | null;
	directory?: string | null;
	projectDisplayName?: string | null;
	projectRootPath?: string | null;
}): CodeWorkspace {
	const path = payload.directory ?? payload.projectRootPath ?? "";
	return {
		id: payload.id,
		name:
			payload.name ?? payload.projectDisplayName ?? path.split("/").filter(Boolean).pop() ?? path,
		path,
	};
}

function toSession(payload: {
	id: string;
	provider: string;
	cwd: string;
	workspaceId?: string | null;
	status: string;
	title?: string | null;
	pendingPermissions?: unknown[];
	updatedAt?: string | null;
}): CodeAgentSession {
	const base =
		payload.status === "running"
			? "running"
			: payload.status === "error"
				? "error"
				: payload.status === "closed"
					? "done"
					: "idle";
	const state: CodeTurnState =
		base === "running" && (payload.pendingPermissions?.length ?? 0) > 0
			? "waiting-permission"
			: base;
	return {
		id: payload.id,
		workspaceId: payload.workspaceId ?? "",
		title: payload.title ?? payload.cwd,
		provider: payload.provider,
		state,
		updatedAt: payload.updatedAt ?? new Date().toISOString(),
	};
}

/** One link per paired device, for the whole server process. */
const pool = new Map<string, DeviceDaemonLink>();

/**
 * The link for one of the caller's own paired devices. Ownership is checked
 * against the row before anything dials: a device id that is not yours is a
 * 404, not a connection.
 */
export async function linkForDevice(
	locals: App.Locals,
	deviceId: string | null | undefined
): Promise<DeviceDaemonLink> {
	if (!deviceId) error(400, "A paired device is required: pass ?device=.");
	const device = await getPairedDevice(locals, deviceId);
	if (!device.daemonId || !device.daemonPublicKey) {
		error(502, "The paired device has no relay identity recorded.");
	}
	const existing = pool.get(deviceId);
	if (existing) return existing;
	const link = new DeviceDaemonLink({
		deviceId,
		serverId: device.daemonId,
		daemonPublicKey: device.daemonPublicKey,
	});
	pool.set(deviceId, link);
	return link;
}

/** The pool only holds live pairings; revocation drops the connection. */
export function dropLink(deviceId: string): void {
	pool.get(deviceId)?.close();
	pool.delete(deviceId);
}

/** A one-shot encrypted probe used by pairing: connect, verify, hang up. */
export async function probePairingOffer(input: {
	serverId: string;
	daemonPublicKey: string;
}): Promise<{ version: string | null }> {
	const base = relayBaseUrl();
	const useTls = base.startsWith("wss://") || base.startsWith("https://");
	const hostPort = base.replace(/^wss?:\/\//, "").replace(/^https?:\/\//, "");
	const url = buildRelayWebSocketUrl({
		endpoint: hostPort,
		useTls,
		serverId: input.serverId,
		role: "client",
		version: "2",
	});
	const client = new DaemonClient({
		url,
		clientId: "cerea-pairing-probe",
		clientType: "hub",
		appVersion: PASEO_SDK_VERSION,
		e2ee: { enabled: true, daemonPublicKeyB64: input.daemonPublicKey },
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
	});
	try {
		await client.connect();
		const status = await client.getDaemonStatus();
		if (status.serverId !== input.serverId) {
			error(502, "The relay routed the pairing probe to a different daemon.");
		}
		return { version: status.version ?? null };
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error({ err, serverId: input.serverId }, "pairing probe failed");
		error(
			502,
			"The daemon could not be reached through the relay. Is it running with `paseo daemon pair` and relay enabled?"
		);
	} finally {
		client.close();
	}
}

/** Build the CodeFileChange[] the diff viewer renders, from the daemon's parsed diff. */
export function toFileChanges(diff: CheckoutDiffPayload): CodeFileChange[] {
	return (diff.files ?? []).map((file) => {
		let oldText = "";
		let newText = "";
		for (const hunk of file.hunks ?? []) {
			for (const line of hunk.lines ?? []) {
				if (line.type === "context") {
					oldText += `${line.content}\n`;
					newText += `${line.content}\n`;
				} else if (line.type === "remove") {
					oldText += `${line.content}\n`;
				} else if (line.type === "add") {
					newText += `${line.content}\n`;
				}
			}
		}
		return { path: file.path, oldText, newText };
	});
}
