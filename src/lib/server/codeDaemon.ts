import { error } from "@sveltejs/kit";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { FetchAgentTimelineResponseMessage } from "@getpaseo/protocol/messages";
import type { AgentFeature, AgentFeatureToggle } from "@getpaseo/protocol/agent-types";
import type {
	ProviderSubagentListPayload,
	ProviderSubagentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { getPairedDevice } from "$lib/server/codeDevices";
import type {
	CodeAgentSession,
	CodeFileChange,
	CodeProviderMode,
	CodeProviderModel,
	CodeWorkspace,
	CodeTurnState,
} from "$lib/types/CodeAgent";
import type { CodeProviderFeature } from "$lib/codeApi";

type FetchAgentTimelinePayload = FetchAgentTimelineResponseMessage["payload"];
/** The parent agent's subagent roster, as the daemon's provider reports it. */
type ProviderSubagentList = ProviderSubagentListPayload["subagents"];
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

/**
 * Whether a daemon call failed because the machine's own enrollment (its
 * stored IdP tokens, minted by `enroll enroll` on that machine) can no
 * longer refresh — `invalid_grant` is the OAuth spec's own code for a dead
 * grant, so it is the one substring this deployment can trust regardless of
 * which provider phrased the surrounding sentence. This is a re-enrollment,
 * not a retry: the fix lives on the machine, and a relay hiccup or a merely
 * unreachable daemon must never be mistaken for it (see `operate` below).
 */
function isExpiredEnrollment(message: string): boolean {
	return /invalid_grant|enrollment (?:has )?expired|enrollment (?:was )?revoked/i.test(message);
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
			const message = err instanceof Error ? err.message : String(err);
			if (isExpiredEnrollment(message)) {
				// 401, not 502: a relay hiccup deserves a retry, but a dead
				// grant does not get better on its own — the caller needs to
				// tell the person to re-enroll the machine, not to wait.
				logger.warn(
					{ deviceId: this.identity.deviceId },
					"paseo daemon reported an expired or revoked enrollment"
				);
				error(
					401,
					"The paired machine's enrollment expired or was revoked — re-run the enroll flow on that machine."
				);
			}
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

	/** One agent's snapshot with everything the open screen labels from:
	 * the mapped session, the provider features the agent itself reports
	 * (the auto-accept toggle's live value — the provider's feature list
	 * only says what exists), and the cwd the feature query requires. One
	 * fetch, one read, one truth. */
	async getAgentDetail(agentId: string): Promise<{
		session: CodeAgentSession;
		features: CodeProviderFeature[];
		cwd: string;
	}> {
		const result = await this.operate((client) => client.fetchAgent(agentId));
		if (!result?.agent) error(404, "No such agent on this daemon.");
		return {
			session: toSession(result.agent),
			features: toFeatureToggles(result.agent.features),
			cwd: result.agent.cwd,
		};
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

	/** Rename a workspace: `setWorkspaceTitle` is the daemon's own rename —
	 * the title overrides the derived name in its listings, and `null`
	 * clears it back. The answer carries the title as the daemon recorded
	 * it, so the tree redraws from the daemon's word, not the request's. */
	async renameWorkspace(workspaceId: string, title: string | null): Promise<string | null> {
		const result = await this.operate((client) => client.setWorkspaceTitle(workspaceId, title));
		return result.title;
	}

	/** Rename an agent: `updateAgent`'s name is the daemon's own rename —
	 * the tree redraws from the daemon's listings afterwards, never from
	 * the string that was typed. */
	async renameAgent(agentId: string, name: string): Promise<void> {
		await this.operate((client) => client.updateAgent(agentId, { name }));
	}

	/** The modes the provider offers — paseo's permission vocabulary as the
	 * daemon itself defines it (plan, build, …). Listed live: a hardcoded
	 * set here would drift from what the daemon enforces. A refusal in the
	 * payload (provider not ready) surfaces as this deployment's 502 with
	 * the daemon's own words, so the pill can say why the list is empty. */
	async listProviderModes(provider: string): Promise<CodeProviderMode[]> {
		const result = await this.operate((client) => client.listProviderModes(provider));
		if (result.error) {
			error(502, `The daemon could not list modes: ${result.error}`);
		}
		return (result.modes ?? []).map((mode) => ({
			id: mode.id,
			label: mode.label,
			...(mode.description ? { description: mode.description } : {}),
		}));
	}

	/** The models the provider offers, live from the daemon. `isSelectable`
	 * is honoured — a model the provider refuses to select must not be
	 * offered — and a refusal in the payload is a 502 like the modes'. */
	async listProviderModels(provider: string): Promise<CodeProviderModel[]> {
		const result = await this.operate((client) => client.listProviderModels(provider));
		if (result.error) {
			error(502, `The daemon could not list models: ${result.error}`);
		}
		return (result.models ?? [])
			.filter((model) => model.isSelectable !== false)
			.map((model) => ({
				id: model.id,
				label: model.label,
				...(model.description ? { description: model.description } : {}),
				...(model.isDefault ? { isDefault: true } : {}),
			}));
	}

	/** The provider's features, as the daemon drafts them for a config like
	 * the agent's (`cwd` required — the daemon resolves features per
	 * working directory; the agent's mode and model ride along when
	 * known). This list says what toggles EXIST and what they are called;
	 * a live value comes from the agent's own snapshot, whose features
	 * carry the config the agent is actually running. A refusal in the
	 * payload is a 502 like the modes' and models'. */
	async listProviderFeatures(draft: {
		provider: string;
		cwd: string;
		modeId?: string;
		model?: string;
	}): Promise<CodeProviderFeature[]> {
		const result = await this.operate((client) => client.listProviderFeatures(draft));
		if (result.error) {
			error(502, `The daemon could not list features: ${result.error}`);
		}
		return toFeatureToggles(result.features);
	}

	/** Switch the agent's mode (plan, build, …). A provider refusal travels
	 * back as a notice rather than a thrown error — the panel shows it and
	 * the next snapshot read still reports the truth. */
	async setAgentMode(agentId: string, modeId: string): Promise<string | null> {
		const notice = await this.operate((client) => client.setAgentMode(agentId, modeId));
		if (notice?.type === "error") error(502, notice.message);
		return notice?.message ?? null;
	}

	/** Switch the agent's model (`null` resets to the provider's default). */
	async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
		await this.operate((client) => client.setAgentModel(agentId, modelId));
	}

	async sendAgentMessage(agentId: string, text: string): Promise<void> {
		await this.operate((client) => client.sendAgentMessage(agentId, text));
	}

	/** Stop the agent's live turn. The daemon interrupts the provider and,
	 * when permission requests are outstanding, resolves each of them
	 * denied before it answers — so the transcript's approval card settles
	 * through its own resolution frame instead of hanging, and the turn's
	 * end arrives on the stream as `turn_canceled`. An agent between turns
	 * answers not_running and changes nothing. */
	async cancelAgent(agentId: string): Promise<void> {
		await this.operate((client) => client.cancelAgent(agentId));
	}

	/** Flip one of the agent's provider features (the auto-accept toggle).
	 * The daemon answers accepted/error; a rejection throws here, so the
	 * pill keeps the value the snapshot reported rather than claiming the
	 * request landed. */
	async setAgentFeature(agentId: string, featureId: string, value: boolean): Promise<void> {
		await this.operate((client) => client.setAgentFeature(agentId, featureId, value));
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

	/**
	 * The subagents one parent agent spawned, as the daemon's provider tracks
	 * them. The panel polls this on turn boundaries only — the roster is the
	 * authority for each subagent's title, status and subtitle, and the
	 * transcript's Task tool call (matched by the descriptor's `toolCallId`)
	 * is where the panel anchors it. Subagents the provider spawned without a
	 * tool call (`toolCallId: null`) have no place in the transcript to anchor
	 * at and are not invented one.
	 */
	async listSubagents(agentId: string): Promise<ProviderSubagentList> {
		return this.operate((client) => client.listProviderSubagents(agentId)).then(
			(result) => result.subagents
		);
	}

	/**
	 * One subagent's own timeline — the transcript its card expands to. The
	 * rows are ordinary timeline entries, so the forwarder maps them through
	 * the same `timelineEntryToUpdate` the parent's routes use, and a subagent
	 * transcript reads exactly like the parent's.
	 */
	async fetchSubagentTimeline(
		agentId: string,
		subagentId: string
	): Promise<ProviderSubagentTimelinePayload> {
		return this.operate((client) =>
			client.fetchProviderSubagentTimeline(agentId, subagentId, {
				direction: "tail",
				limit: 500,
			})
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
	// The custom title `setWorkspaceTitle` writes; it overrides the derived
	// name in the daemon's listings, so it leads here too — a rename would
	// otherwise be invisible in the tree.
	title?: string | null;
	directory?: string | null;
	projectDisplayName?: string | null;
	projectRootPath?: string | null;
}): CodeWorkspace {
	const path = payload.directory ?? payload.projectRootPath ?? "";
	return {
		id: payload.id,
		name:
			payload.title ??
			payload.name ??
			payload.projectDisplayName ??
			path.split("/").filter(Boolean).pop() ??
			path,
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
	// The live session config, as the snapshot carries it: `currentModeId`
	// is the daemon's mode switch (plan, build, …), `model` the model id.
	// Both nullable — an agent that has not reported them yet shows none.
	currentModeId?: string | null;
	model?: string | null;
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
		modeId: payload.currentModeId ?? null,
		modelId: payload.model ?? null,
	};
}

/** The provider features the panel drives, as toggles only. A select
 * feature (one value chosen from a list) has no panel shape yet — dropping
 * it here keeps every caller from re-filtering, the way the timeline's
 * unmappable items are dropped at their own boundary. */
function toFeatureToggles(features: AgentFeature[] | null | undefined): CodeProviderFeature[] {
	return (features ?? [])
		.filter((feature): feature is AgentFeatureToggle => feature.type === "toggle")
		.map((feature) => ({
			id: feature.id,
			label: feature.label,
			...(feature.description ? { description: feature.description } : {}),
			value: feature.value,
		}));
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
