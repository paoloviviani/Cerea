<!--
	One coding session, rendered exactly like a conversation.

	The bespoke agent stack is gone: the transcript is the chat's message
	column (`ChatMessageColumn`, so the same sticky-bottom machinery, the same
	`ChatMessage` rendering), the composer is the chat's `ChatInput`, and the
	agent's frames fold into `Message[]` through the same buffering discipline
	the conversation page uses — which is what makes live updates arrive
	without a refresh by construction, not by a re-render loop of our own.

	What remains agent-specific, by the operator's design: a slim strip above
	the column carrying the workspace name and the provider/state pills, and
	the daemon's permission requests, which render as the chat's approval card
	answering through the machine link. Git changes live in the shared side
	pane; the composer carries the agent's mode and model as pills, switched
	live on the daemon rather than per send.

	The address (`?device=&ws=&agent=`) is the selection; the `{#key}` in
	`CodePanel` remounts this whole view on a new address, so the transcript is
	always a fresh replay of the daemon's log for this agent, never a stale
	one. The reply is NOT inserted optimistically: the stream echoes the
	person's message back, and the stream is the transcript's source of truth.
-->
<script lang="ts">
	import { setContext, untrack } from "svelte";
	import { ALREADY_ANSWERED_NOTE, replyOutcome } from "$lib/utils/permissionReply";
	import { throttleTrailing } from "$lib/utils/throttleTrailing";
	import { MediaQuery } from "svelte/reactivity";
	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import type {
		ElicitationAction,
		ElicitationRequestPayload,
		ElicitationValue,
	} from "$lib/types/McpElicitation";
	import {
		MessageToolUpdateType,
		MessageUpdateType,
		type MessageTurnStateUpdate,
	} from "$lib/types/MessageUpdate";
	import {
		forkedFromTitle,
		type AgentCompactionUpdate,
		type AgentUsageUpdate,
		type CodeAgentSession,
		type CodeSubagent,
		type CodeSubagentAnchor,
		type CodeTurnState,
		type CodeWorkspace,
	} from "$lib/types/CodeAgent";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import type { Message } from "$lib/types/Message";
	import { isConversationGenerationActive } from "$lib/utils/generationState";
	import { forkableMessageIds } from "$lib/utils/codeFork";
	import { shouldShowPendingPlaceholder } from "$lib/utils/pendingPlaceholder";
	import { consumeAgentUpdates } from "$lib/utils/consumeAgentUpdates";
	import { codeAgentStream } from "$lib/codeAgentStream";
	import {
		CodeApiError,
		cancelAgent,
		listAgents,
		fetchAgentHistory,
		fetchSubagentTimeline,
		getAgent,
		getPermissionRules,
		listProviderModes,
		listProviderModels,
		listSubagents,
		listWorkspaces,
		respondPermission,
		respondQuestion,
		sendFollowUp,
		revertAgent,
	} from "$lib/codeApi";
	import type { CodeProviderMode, CodeProviderModel } from "$lib/codeApi";
	import type { PermissionRulesResult } from "$lib/types/machineProtocol";
	import { ceilingOf, ceilingOfPolicy, isCapped } from "$lib/utils/permissionRules";
	import { ALWAYS_CAPPED, type AlwaysCapped } from "$lib/utils/alwaysCappedContext";
	import { FIRST_TURN_SUBAGENT } from "$lib/utils/firstTurnSubagent";
	import { FirstTurnTracker } from "$lib/utils/firstTurnTracker.svelte";
	import { error as errorToast } from "$lib/stores/errors";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { uploadComposerFiles } from "$lib/utils/composerFiles";
	import { keepReportedUsage } from "$lib/utils/agentUsage";
	import { AGENT_ATTACHMENT_MIME_ALLOWLIST } from "$lib/constants/mime";
	import {
		CODE_SESSION_LINKS,
		referencedSessionIds,
		type CodeSessionLinks,
	} from "$lib/utils/codeSessionLinks";
	import ChatMessageColumn from "$lib/components/chat/ChatMessageColumn.svelte";
	import SidePane from "$lib/components/chat/SidePane.svelte";
	import TogglePill from "$lib/components/TogglePill.svelte";
	import AgentComposer from "./AgentComposer.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import AgentDiff from "./AgentDiff.svelte";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import RetryNotice from "./RetryNotice.svelte";
	import SubagentCard from "./SubagentCard.svelte";
	import HandoffDialog from "./HandoffDialog.svelte";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";
	import CodeFiles from "./CodeFiles.svelte";
	import CodeTerminals from "./CodeTerminals.svelte";
	import CodeTasks from "./CodeTasks.svelte";
	import { latestPlan, planIsActive, planKey, planProgress } from "$lib/utils/codeTasks";
	import IconTaskComplete from "~icons/carbon/task-complete";
	import IconFolder from "~icons/carbon/folder";
	import IconTerminal from "~icons/carbon/terminal";
	import AskQuestion from "$lib/components/chat/AskQuestion.svelte";
	import { firstQuestionFor } from "$lib/stores/pendingQuestion";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import { codeEnrollment } from "$lib/stores/codeEnrollment.svelte";
	import IconCode from "~icons/carbon/code";
	import IconRenew from "~icons/carbon/renew";
	import IconDiff from "~icons/lucide/diff";
	import IconFork from "~icons/carbon/fork";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The workspace the address named, so the strip can name it without guessing. */
		workspaceId?: string;
	}

	let { deviceId, agentId, workspaceId }: Props = $props();

	/** Whether `CodePanel`'s probe (on agent open, on device switch) last
	 * found this device's enrollment expired — the composer refuses to send
	 * on it, and the pointer to fix it is the same re-enroll dialog the pill
	 * opens. */
	let enrollmentExpired = $derived(codeEnrollment[deviceId] === "expired");
	let showReenroll = $state(false);

	let agent = $state<CodeAgentSession | null>(null);
	// The composer's option lists (modes/models/feature catalog), fetched
	// HERE rather than in the composer: the view's own effects re-run when
	// the device row lands (the e2e caught the composer's effects running
	// once under hydration and never again), and the view already owns the
	// snapshot read that tells them what provider to ask.
	let modes = $state<CodeProviderMode[] | null>(null);
	let modesFailure = $state<string | null>(null);
	let models = $state<CodeProviderModel[] | null>(null);
	let modelsFailure = $state<string | null>(null);
	/** Models the machine listed but its enrollment policy keeps off the panel. */
	let modelsHidden = $state(0);
	/** The machine's `permission.rules` answer for this session: the rules in
	 * force, its mode, its exceptions, the ceiling. One read, shared by the
	 * Permissions line, the selector's note and the card's Always button. Null
	 * until it lands and on a machine that predates the op. */
	let permissionRules = $state<PermissionRulesResult | null>(null);
	/** The agent's working directory, from the same read. */
	let agentCwd = $state<string | null>(null);
	let workspace = $state<CodeWorkspace | null>(null);
	/** Below `sm`, where the pane covers the chat and never opens itself. */
	const narrowViewport = new MediaQuery("(max-width: 639px)");
	let messages = $state<Message[]>([]);
	let pending = $state(false);
	let failure = $state<string | null>(null);
	/** The machine's whole transcript is still replaying into `messages`
	 * (a fresh subscription's history, or a rollback's re-replay): the
	 * transcript area shows a loading state instead of the turns, and the
	 * first paint of the real transcript lands at the bottom (see
	 * `ChatMessageColumn`'s historyPending). */
	let historyPending = $state(false);
	/** Paging the older transcript (§6 `session.history`): whether older
	 * pages exist behind what is loaded, from the bridge's `historyMeta`
	 * frame. Null while unknown — an older galopin never sends the frame,
	 * and nothing pages there. */
	let historyHasMore = $state<boolean | null>(null);
	/** The cursor the next older page continues from: the machine's own
	 * oldest-sent message id (historyMeta, then each page's `before`). The
	 * first bubble's id is only the fallback — a bubble the fold opened
	 * without a machine id would otherwise stop the paging silently. */
	let historyBefore: string | null = null;
	/** One older page in flight; errors keep their own row with a retry. */
	let historyFetching = $state(false);
	let historyError = $state<string | null>(null);
	/** Bumped every time the transcript is rebuilt from scratch (a new
	 * address, a rollback, a machine restart): an in-flight page fetch from
	 * the old transcript is discarded instead of prepended into the new. */
	let pagingEpoch = 0;
	/** The latest usage/compaction side-channel frames (M3) — the fold's
	 * onUsage/onCompaction never touch `messages`, so these track separately. */
	let usage = $state<AgentUsageUpdate["usage"] | null>(null);
	let lastCompaction = $state<AgentCompactionUpdate | null>(null);

	/** Whether this agent's backend advertised the `usage` capability in
	 * `hello` — the meter hides entirely otherwise. `codeDeviceList` is the
	 * same shared poll the sidebar tree reads its device rows from. */
	let usageSupported = $derived(
		codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities.usage ?? false
	);

	/** The device's own row from the shared poll (`codeDeviceList`) says it
	 * is unreachable. Read directly from that store rather than the agent
	 * snapshot: an address opened straight from a link or a stale tab never
	 * goes through `CodeNavTree`'s own offline gate (X4), so this view has
	 * to make the same call itself — before it ever asks the daemon for
	 * anything, not after the 502 comes back. */
	let deviceOffline = $derived(
		codeDeviceList.devices.find((d) => d.id === deviceId)?.online === false
	);
	/** Whether the poll has answered at all yet for this device. The poll's
	 * first fetch is still in flight on a fresh mount, so `deviceOffline`
	 * alone reads `false` for an "unknown" device exactly as it would for a
	 * known-online one — every fetch below would race the poll and fire
	 * before it ever had a chance to say "offline". Holding those fetches
	 * until the row is known (one poll tick, imperceptible) is what actually
	 * closes that race; the offline banner stays keyed on `deviceOffline`
	 * alone so it never flashes for a device that turns out to be online. */
	let deviceKnown = $derived(codeDeviceList.devices.some((d) => d.id === deviceId));
	let skipMachineFetches = $derived(!deviceKnown || deviceOffline);

	/** Whether the backend takes files and images with a prompt (`hello`
	 * capabilities); the composer offers no attachment picker otherwise. */
	let filesSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.files || caps?.images);
	});
	/** Retry and rollback: the backend can roll a session back to before one
	 * of its user messages (`hello` capability `revert`), and whether that
	 * also restores files (`revertFiles`; opencode's snapshots are git-based,
	 * so only in a git repository). */
	let revertSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.revert);
	});
	/** The explorer: on for this deployment, implemented by this galopin,
	 * and not vetoed by the machine (then the button says how to allow it). */
	let filesOffered = $derived(
		page.data.codeFilesEnabled === true &&
			codeDeviceList.devices.find((d) => d.id === deviceId)?.machine?.capabilities.files === true
	);
	let filesVetoed = $derived(
		codeDeviceList.devices.find((d) => d.id === deviceId)?.policy?.files === "off"
	);
	/** Bumped when a turn settles, so the explorer re-reads what an agent wrote. */
	let filesTurnKey = $state(0);
	let lastTurnState: string | undefined;
	/** Bumped when the Permissions line may be stale: a turn settled or an ask
	 * was answered ("always" adds a saved approval; a reject can end the
	 * session's other pending asks), so it re-reads the machine's word. */
	let permissionsKey = $state(0);
	$effect(() => {
		const state = shownState;
		if (lastTurnState === "running" && state !== "running") filesTurnKey += 1;
		if (lastTurnState !== undefined && lastTurnState !== state) permissionsKey += 1;
		lastTurnState = state;
	});
	/** Read what the machine says is in force. Keeps the last good answer on a
	 * failed read (a line that was right a moment ago is better than none), and
	 * drops it on a 404: an older machine has no such op, so nothing draws. */
	async function loadPermissionRules() {
		try {
			permissionRules = await getPermissionRules(deviceId, agentId);
		} catch (err) {
			if (err instanceof CodeApiError && err.status === 404) permissionRules = null;
		}
	}
	let haveAgent = $derived(agent !== null);
	$effect(() => {
		void permissionsKey;
		void deviceId;
		void agentId;
		if (skipMachineFetches || !haveAgent) return;
		void untrack(() => loadPermissionRules());
	});
	/** The ceiling the machine reports, or the one its `hello` carries when the
	 * read says none: what the card's Always button and the selector's note
	 * consult. */
	let ceiling = $derived.by(() => {
		const read = permissionRules ? ceilingOf(permissionRules) : {};
		return Object.keys(read).length > 0
			? read
			: ceilingOfPolicy(codeDeviceList.devices.find((d) => d.id === deviceId)?.policy);
	});
	/** The terminal (ADR 0090 §6.1): the double veto's two halves — the
	 * deployment switch (hidden entirely when off) and the machine's own
	 * policy (shown disabled, with the exact re-enroll fix, when off). */
	let terminalOffered = $derived(
		page.data.codeTerminalEnabled === true &&
			codeDeviceList.devices.find((d) => d.id === deviceId)?.machine?.capabilities.terminal === true
	);
	let terminalVetoed = $derived(
		codeDeviceList.devices.find((d) => d.id === deviceId)?.policy?.terminal !== "allowed"
	);
	let effortsSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.efforts);
	});
	/** The `/` menu's capability gates: compact and rollback exist only for a
	 * backend that reports them (the same word ContextMeter's "Compact now"
	 * and the transcript's retry read). */
	let compactSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.compact);
	});
	/** Steering: a prompt sent mid-turn is folded into the running turn
	 * (`hello` capability `steer`), so the composer keeps Send beside Stop. */
	let steerSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.steer);
	});
	let revertRestoresFiles = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.revertFiles) && workspace?.isGitRepo === true;
	});

	/** The session's slot in the attachment store (owner key
	 * `code:<device>:<session>`): where the composer uploads, and where the
	 * transcript's user files are served from. */
	let attachmentsUrl = $derived(
		`${base}/api/v2/code/attachments/${encodeURIComponent(`code:${deviceId}:${agentId}`)}`
	);

	// The mobile top bar names the screen it is on; chats get their title
	// from the conversations store, and an agent is not one — it reports
	// itself here, and clears the slot when the screen goes away.
	$effect(() => {
		codeNav.agentTitle = agent?.title ?? "";
		return () => (codeNav.agentTitle = "");
	});

	// A fresh agent screen owns the side pane: whatever a previous surface
	// left open is not this agent's content.
	$effect(() => {
		sidePane.reset();
		return () => sidePane.reset();
	});

	// Reattach on reload: the side pane itself is ephemeral UI state
	// (sidePane.svelte.ts), wiped by the reset above on every mount like
	// every other view here (Changes, Files) — a full page reload is a
	// fresh mount. The terminal alone remembers it was open, in
	// sessionStorage keyed by this agent, and reopens once the device/
	// policy data terminalOffered depends on has loaded (which the reset
	// above cannot wait for, since it must always run once regardless).
	function terminalOpenKey(): string {
		return `code-terminal-open:${agentId}`;
	}
	let terminalRestoreChecked = false;
	$effect(() => {
		if (!browser || terminalRestoreChecked || !terminalOffered) return;
		terminalRestoreChecked = true;
		if (sessionStorage.getItem(terminalOpenKey()) === "1") {
			sidePane.openTerminal();
		}
	});
	$effect(() => {
		// Gated on the restore effect having run at least once: on mount the
		// pane is briefly closed (the reset effect above) before
		// terminalOffered's async data arrives, and without this gate that
		// transient "closed" state would clear the marker before the
		// restore effect ever got to read it — every reload would look
		// like a fresh close.
		if (!browser || !terminalRestoreChecked) return;
		if (sidePane.open && sidePane.view === "terminal") {
			sessionStorage.setItem(terminalOpenKey(), "1");
		} else {
			sessionStorage.removeItem(terminalOpenKey());
		}
	});

	// Tracked on `deviceOffline`, not a one-shot `onMount`: an address can be
	// opened straight at an already-offline device (a link, a stale tab), and
	// a device that goes offline mid-session and reconnects needs its
	// snapshot and workspace re-read the same way a fresh mount would — the
	// daemon is never even asked while `deviceOffline` is known true, which
	// is what keeps this from generating a 502 (and a server-side log line)
	// on every poll tick of an offline machine.
	$effect(() => {
		if (skipMachineFetches) return;
		refreshAgent();
		(async () => {
			if (!workspaceId) return;
			try {
				workspace =
					(await listWorkspaces(deviceId)).workspaces.find((w) => w.id === workspaceId) ?? null;
			} catch {
				workspace = null;
			}
		})();
	});

	/** One snapshot read, from mount and after every composer switch: the
	 * strip's pills, the composer's mode/model pills and the permission
	 * selector label from the daemon's own word, never from what a request
	 * claimed. */
	async function refreshAgent(lists = true) {
		try {
			const detail = await getAgent(deviceId, agentId);
			agent = detail.agent;
			agentCwd = detail.cwd;
			// The snapshot's own word, not a guess: if the daemon's last real
			// attempt on this agent already failed on an expired/revoked
			// grant, say so immediately rather than waiting on the device
			// probe's next poll to catch up.
			if (detail.enrollmentExpired) codeEnrollment[deviceId] = "expired";
			if (lists) void refreshLists();
		} catch {
			// The transcript carries its own states; a strip that only
			// errors when the daemon is off is worse than fallbacks.
			agent = null;
			agentCwd = null;
		}
	}

	/** The composer's option lists, refetched after every snapshot read:
	 * they hang off the snapshot's provider, so each fresh read re-asks the
	 * daemon. A failure lands in the pill's own menu — sending a follow-up
	 * never needed the lists. */
	async function refreshLists() {
		const provider = agent?.provider;
		if (!provider) {
			modes = null;
			models = null;
			return;
		}
		try {
			const result = await listProviderModes(deviceId, provider);
			modes = result.modes;
			modesFailure = null;
		} catch (err) {
			modes = [];
			modesFailure = err instanceof Error ? err.message : "Could not load the modes.";
		}
		try {
			const result = await listProviderModels(deviceId, provider);
			models = result.models;
			modelsHidden = result.hidden ?? 0;
			modelsFailure = null;
		} catch (err) {
			models = [];
			modelsHidden = 0;
			modelsFailure = err instanceof Error ? err.message : "Could not load the models.";
		}
	}

	// Other sessions this transcript names (a "From agent" bubble, a
	// `session_send` target, a spawn's child): one read of the machine's own
	// list per new id, so a link can carry the workspace and a title can be
	// current. An id the list does not know stays a link without a workspace,
	// which the panel resolves from the agent itself.
	let knownSessions = $state<Record<string, CodeAgentSession>>({});
	let sessionsTried = new Set<string>();
	let referencedSessions = $derived(referencedSessionIds(messages));
	$effect(() => {
		const wanted = referencedSessions.filter(
			(id) => !(id in knownSessions) && !sessionsTried.has(id)
		);
		if (wanted.length === 0 || skipMachineFetches) return;
		for (const id of wanted) sessionsTried.add(id);
		void listAgents(deviceId)
			.then(({ agents }) => {
				knownSessions = { ...knownSessions, ...Object.fromEntries(agents.map((a) => [a.id, a])) };
			})
			.catch(() => {});
	});
	const sessionLinks: CodeSessionLinks = {
		href: (sessionId) =>
			`${base}/code?device=${deviceId}&ws=${knownSessions[sessionId]?.workspaceId ?? ""}&agent=${sessionId}`,
		title: (sessionId) => knownSessions[sessionId]?.title,
	};
	setContext(CODE_SESSION_LINKS, sessionLinks);
	// The cards below hide "Always allow (this session)" for a tool the ceiling
	// holds below allow: the machine would answer once and store nothing.
	setContext<AlwaysCapped>(ALWAYS_CAPPED, (tool) => isCapped(ceiling, tool));
	// A new subagent's first turn asks whatever the setting is: the card says so,
	// reading the asking subagent's own transcript once per ask.
	const firstTurnTracker = new FirstTurnTracker(
		async (childId) => (await fetchSubagentTimeline(deviceId, agentId, childId)).updates
	);
	setContext(FIRST_TURN_SUBAGENT, firstTurnTracker);
	// The chip draws only on an Allow root. Viewed agent first (a parent's own
	// transcript), else the fetched parent (a subagent's own view): while the
	// parent snapshot is still loading the mode is unknown and no chip draws.
	$effect(() => {
		firstTurnTracker.rootMode =
			agent?.parentId == null
				? (agent?.permissionMode ?? null)
				: (parentAgent?.permissionMode ?? null);
	});

	// A subagent's view names where it came from, with a link back: the
	// parent's own row (title, workspace), read once per parent id.
	let parentAgent = $state<CodeAgentSession | null>(null);
	let parentFetchedFor: string | null = null;
	$effect(() => {
		const parentId = agent?.parentId ?? null;
		if (parentId === parentFetchedFor) return;
		parentFetchedFor = parentId;
		parentAgent = null;
		if (!parentId) return;
		void getAgent(deviceId, parentId)
			.then((detail) => {
				if (parentFetchedFor === parentId) parentAgent = detail.agent;
			})
			.catch(() => {});
	});

	// Mounting this iterator IS the history fetch (a fresh subscription replays
	// the daemon's log before tailing), so the transcript assembles itself from
	// one source and needs no snapshot call. The fold is the chat's own turn
	// machinery; live updates land through it without a refresh.
	//
	// The fold runs untracked on purpose: it holds the `messages` array for the
	// whole subscription, and reading it tracked here would re-run this effect
	// on the very frames it folds — tearing the stream down mid-transcript.
	// The device and agent ids stay tracked: a new address restarts the replay.
	// `deviceOffline` is tracked too: no subscription is opened at all while
	// the device is known unreachable, so an offline machine never drives
	// `EventSource`'s own reconnect loop into hammering the stream endpoint
	// (and its `session.sync` failure) on a timer. The last transcript this
	// view had just sits there under the offline banner; going back online
	// re-runs this effect and replays the daemon's log fresh.
	$effect(() => {
		if (skipMachineFetches) return;
		// A rollback changes the history the machine holds: bumping this
		// restarts the subscription, which replays it from scratch.
		void streamNonce;
		messages = [];
		pending = false;
		usage = null;
		lastCompaction = null;
		// The replay this effect opens IS the history fetch: the transcript
		// stays gated on it until the stream's historyDone marker (or its
		// end), so a long session opens on the loading state rather than a
		// half-built transcript rendered from the top.
		historyPending = true;
		// A rebuilt transcript starts with unknown paging: older pages
		// loaded before the reset are gone with the messages, and their
		// in-flight fetches must not land in the new one.
		historyHasMore = null;
		historyBefore = null;
		historyFetching = false;
		historyError = null;
		pagingEpoch += 1;
		const abort = new AbortController();
		untrack(() => {
			(async () => {
				try {
					await consumeAgentUpdates(codeAgentStream(deviceId, agentId, abort.signal), messages, {
						isAborted: () => abort.signal.aborted,
						onAbort: () => abort.abort(),
						onTurnEvent: () => (pending = false),
						onUsage: (u) => (usage = keepReportedUsage(usage, u)),
						onCompaction: (c) => (lastCompaction = c),
						onChildActivity: (childId) => noteChildActivity(childId),
						onHistoryDone: () => (historyPending = false),
						onHistoryMeta: (meta) => {
							historyHasMore = meta.hasMore;
							historyBefore = meta.before ?? null;
						},
						onReset: () => {
							usage = null;
							lastCompaction = null;
							// The transcript was discarded and rebuilds from
							// the new epoch alone: whatever paging knew is
							// gone with it.
							historyHasMore = null;
							historyBefore = null;
							historyFetching = false;
							historyError = null;
							pagingEpoch += 1;
						},
					});
				} catch (err) {
					if (!abort.signal.aborted) {
						failure = err instanceof Error ? err.message : "The agent stream failed.";
					}
				} finally {
					// A stream that ended on its own (the machine went away, the
					// sign-in lapsed) must not leave the pane on a skeleton
					// forever: show whatever folded, under the banner this view
					// already draws. An ABORTED fold is the re-run path instead
					// (rollback, device switch): its end lands as a microtask
					// after the new run already raised the gate, and clearing
					// here would open it while the new history is still folding.
					if (!abort.signal.aborted) historyPending = false;
				}
			})();
		});
		return () => abort.abort();
	});

	let streamNonce = $state(0);

	// ── Paging the older transcript (§6 `session.history`) ──────────
	//
	// The newest page arrived with the stream's snapshot; when the reader
	// scrolls within about one screen of the top and older pages exist, the
	// previous page is fetched, folded on its own, and PREPENDED — the
	// visible message stays where it was (the column's anchored prepend),
	// and the live tail's own fold keeps appending to the same array. One
	// fetch at a time; a fetch that started before a rebuild (rollback, a
	// new epoch) is discarded when it lands.
	const HISTORY_PAGE_LIMIT = 40;

	async function requestPreviousPage() {
		if (historyPending || historyHasMore !== true || historyFetching || messages.length === 0)
			return;
		const before = historyBefore ?? messages[0].machineMessageId;
		if (!before) return;
		const epoch = pagingEpoch;
		historyFetching = true;
		historyError = null;
		try {
			const page = await fetchAgentHistory(deviceId, agentId, before, HISTORY_PAGE_LIMIT);
			if (epoch !== pagingEpoch) return;
			if (page.updates.length > 0) {
				const folded: Message[] = [];
				const abort = new AbortController();
				await consumeAgentUpdates(
					(async function* () {
						yield* page.updates;
					})(),
					folded,
					{
						isAborted: () => false,
						onAbort: () => abort.abort(),
						onTurnEvent: () => {},
					}
				);
				if (epoch !== pagingEpoch) return;
				// A page that re-answered what the transcript already holds
				// (an old cursor, a retried fetch) must not double it: the
				// machine's own ids decide, and they survive every fold.
				const known = new Set(
					messages.flatMap((m) => (m.machineMessageId ? [m.machineMessageId] : []))
				);
				const fresh = folded.filter((m) => !m.machineMessageId || !known.has(m.machineMessageId));
				// In place, never a reassignment: the live tail's fold holds
				// this same array and keeps appending where it was.
				if (fresh.length > 0) column?.prependWithAnchor(() => messages.unshift(...fresh));
			}
			historyHasMore = page.hasMore;
			if (page.before) historyBefore = page.before;
		} catch (err) {
			if (epoch !== pagingEpoch) return;
			historyError = err instanceof Error ? err.message : "Could not load earlier messages.";
		} finally {
			if (epoch === pagingEpoch) historyFetching = false;
		}
	}

	// ── Retry and rollback (capability `revert`) ────────────────────
	// Retry on an answer rolls back to the prompt that produced it and sends
	// that prompt again; editing a prompt rolls back to it and sends the new
	// text. Both confirm first, saying whether files come back too. There is
	// no undo here: the re-sent prompt is what ends a revert's undo window
	// (opencode drops the reverted turns on the next prompt).
	let rollback = $state<{ userMessageId: string; text: string; files: string } | null>(null);

	// ── /undo — the composer's roll-back command ─────────────────────
	// Shares the capability facts and the confirmation idiom the retry
	// action uses (same dialog, same files sentence), but never re-sends:
	// undoing the last prompt is the whole command. The machine id comes
	// from the transcript fold — the one thing only this view knows.
	let undoTarget = $state<{ userMessageId: string; text: string; files: string } | null>(null);

	function openUndoConfirm() {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			if (messages[i].from !== "user") continue;
			const user = messages[i];
			if (!user.machineMessageId) {
				errorToast.set("The last prompt has no id on the machine's transcript yet.");
				return;
			}
			undoTarget = {
				userMessageId: user.machineMessageId,
				text: user.content,
				files: revertRestoresFiles
					? "Files the agent changed from that point on are restored too."
					: "Files on disk are NOT restored: only the conversation is rolled back.",
			};
			return;
		}
		errorToast.set("Nothing to roll back yet.");
	}

	async function confirmUndo() {
		if (!undoTarget) return;
		const { userMessageId } = undoTarget;
		await revertAgent(deviceId, agentId, userMessageId);
		undoTarget = null;
		streamNonce += 1;
	}

	// ── /new — the new-agent dialog on this agent's workspace ────────
	// The same AgentDialog the sidebar tree opens, hosted here because the
	// workspace object it needs is the one this view already loaded. On
	// creation the address moves to the new agent (the {#key} remount does
	// the reset); the sidebar tree picks the new row up on its own poll.
	let newAgentDialogOpen = $state(false);

	function openNewAgentDialog() {
		if (!workspace) {
			errorToast.set("The agent's workspace is not loaded yet.");
			return;
		}
		newAgentDialogOpen = true;
	}

	function onretry(payload: { id: Message["id"]; content?: string }) {
		const index = messages.findIndex((m) => m.id === payload.id);
		if (index < 0) return;
		// An answer retries the prompt before it; a prompt is its own point.
		let userIndex = index;
		while (userIndex >= 0 && messages[userIndex].from !== "user") userIndex -= 1;
		const user = messages[userIndex];
		if (!user?.machineMessageId) return;
		rollback = {
			userMessageId: user.machineMessageId,
			text: payload.content ?? user.content,
			files: revertRestoresFiles
				? "Files the agent changed from that point on are restored too."
				: "Files on disk are NOT restored: only the conversation is rolled back.",
		};
	}

	async function confirmRollback() {
		if (!rollback) return;
		const { userMessageId, text } = rollback;
		await revertAgent(deviceId, agentId, userMessageId);
		rollback = null;
		streamNonce += 1;
		// A refused resend is already on the banner; nothing else to keep here.
		await handleSend(text).catch(() => undefined);
	}

	let loading = $derived(isConversationGenerationActive(messages));
	let lastMessage = $derived(messages.at(-1));
	let showPlaceholder = $derived(
		shouldShowPendingPlaceholder({
			pending,
			resuming: false,
			lastMessage: lastMessage ?? undefined,
		})
	);

	/** The last assistant message's turn state — the pills' live signal. */
	let liveTurn = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = messages[i];
			if (message.from !== "assistant") continue;
			const updates = message.updates ?? [];
			for (let j = updates.length - 1; j >= 0; j -= 1) {
				const update = updates[j];
				if (update.type === MessageUpdateType.TurnState) return update;
			}
			break;
		}
		return undefined as MessageTurnStateUpdate | undefined;
	});

	/** A permission still waiting in the transcript: the turn is held on it. */
	let waitingPermission = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const message = messages[i];
			if (message.from !== "assistant") continue;
			const updates = message.updates ?? [];
			for (let j = updates.length - 1; j >= 0; j -= 1) {
				const update = updates[j];
				if (update.type !== MessageUpdateType.Elicitation) continue;
				if (update.subtype === "request") return true;
				return false;
			}
			break;
		}
		return false;
	});

	let shownState = $derived.by(() => {
		if (waitingPermission) return "waiting-permission" as CodeTurnState;
		const turn = liveTurn?.state;
		if (turn === "running") return "running" as CodeTurnState;
		if (turn === "failed") return "error" as CodeTurnState;
		if (turn === "done") return "done" as CodeTurnState;
		return agent?.state ?? ("idle" as CodeTurnState);
	});

	// A background child still working while its parent is settled: the
	// parent's own pill honestly reads idle/done — this banner is what says
	// work continues. Read off the daemon's `childSummary`, never inferred
	// from the transcript's markers, so it clears exactly when the roster
	// does.
	let backgroundRunningCount = $derived(agent?.childSummary?.running ?? 0);
	let backgroundRunning = $derived(
		backgroundRunningCount > 0 && shownState !== "running" && shownState !== "waiting-permission"
	);
	let backgroundWaitingCount = $derived(agent?.childSummary?.waiting ?? 0);

	// ── Tasks ─────────────────────────────────────────────────────────────
	//
	// The viewed session's own list only (a subagent's shows when that child
	// is opened): the last Plan update in its timeline, which the snapshot
	// and the live stream both produce.
	let diffRefreshKey = $state(0);
	let diffLoading = $state(true);
	let latestTasks = $derived(latestPlan(messages));
	let tasksProgress = $derived(planProgress(latestTasks));
	let sessionBusy = $derived(shownState === "running" || shownState === "waiting-permission");

	// ── Fork from here ────────────────────────────────────────────────────
	//
	// Offered on every assistant message the machine can name
	// (`machineMessageId` is the boundary the handoff route cuts at) that is
	// not part of the turn still running — see `forkableMessageIds` for why
	// the message's own TurnState is the wrong fact to decide with.
	let forkableIds = $derived(forkableMessageIds(messages, sessionBusy));
	/** ChatMessage's per-message gate for the "Fork from here" action. */
	function messageActionsWhen(message: Message): boolean {
		return forkableIds.has(message.id);
	}
	// A list that has just become active opens the pane on its own, once,
	// on a screen with room for it, and only into an empty slot.
	$effect(() => {
		if (!latestTasks || !planIsActive(latestTasks, sessionBusy)) return;
		const key = planKey(agentId, latestTasks);
		untrack(() => sidePane.maybeAutoOpenTasks(key, !narrowViewport.current));
	});

	// ── Subagent tracking ─────────────────────────────────────────────────
	//
	// A turn may spawn subagents (the provider's Task tool). The daemon's
	// parent timeline carries each spawn as an ordinary tool call — a call
	// frame the fold already renders — but the transcript has no subagent
	// frames: `agent.provider_subagents.update` is a separate session
	// message the timeline subscription never delivers. So the roster is
	// POLLED, and only on turn boundaries: entering a running turn and
	// leaving one, derived from the same turn state the pills read. Never
	// on an interval — a subagent's row is settled data, and a timer would
	// be a second heartbeat riding a link that already has one.
	//
	// The roster is the authority for title, status and subtitle; the
	// transcript's Task tool call (matched by the descriptor's `toolCallId`)
	// is where the card anchors. Before the first pairing, a running spawn
	// tool call anchors on its name alone (`task`, opencode's spawn tool),
	// with the call's own description as the standing title; a call that
	// closes without ever being paired gives the row back to the generic
	// tool card — see ChatMessage. Subagents reported without a tool call
	// have no anchor and are not rendered: the transcript has nowhere honest
	// to put them.
	let subagentRoster = $state<CodeSubagent[]>([]);
	/** `childActivity` side-channel ticks per subagent id, from the parent
	 * stream — each expanded card re-syncs its child's timeline on its
	 * own ticks, throttled (see `SubagentCard`). */
	let childActivity = $state<Record<string, number>>({});

	let subagentsByCallId = $derived.by(() => {
		const byCallId = new Map<string, CodeSubagent>();
		for (const subagent of subagentRoster) {
			if (subagent.toolCallId) byCallId.set(subagent.toolCallId, subagent);
		}
		return byCallId;
	});

	/** The transcript's spawn tool calls, by id, with the description the
	 * call itself carried — the pre-pairing title. */
	let taskCalls = $derived.by(() => {
		const calls = new Map<string, string>();
		for (const message of messages) {
			if (message.from !== "assistant") continue;
			for (const update of message.updates ?? []) {
				if (update.type !== MessageUpdateType.Tool) continue;
				if (update.subtype !== MessageToolUpdateType.Call) continue;
				if (update.call.name.toLowerCase() !== "task") continue;
				const description = update.call.parameters?.["description"];
				calls.set(update.uuid, typeof description === "string" ? description : "");
			}
		}
		return calls;
	});

	let rosterPollSeq = 0;
	async function pollSubagents() {
		const seq = ++rosterPollSeq;
		try {
			const { subagents } = await listSubagents(deviceId, agentId);
			if (seq === rosterPollSeq) subagentRoster = subagents;
		} catch {
			// A failed poll keeps the previous roster — the transcript carries
			// its own states, and the next boundary re-asks.
		}
	}

	// The phase the pills already show, as a two-state boundary signal.
	// A permission hold is still inside the running turn, so it stays
	// "running" here rather than faking a boundary at each hold.
	let rosterPhase: "none" | "running" | "settled" = "none";
	$effect(() => {
		if (skipMachineFetches) return;
		const phase =
			shownState === "running" || shownState === "waiting-permission"
				? ("running" as const)
				: ("settled" as const);
		if (phase === rosterPhase) return;
		rosterPhase = phase;
		void pollSubagents();
	});

	/** A `childActivity` frame arrived for one subagent: count it, so that
	 * subagent's expanded card re-syncs its timeline (the card throttles). */
	const backgroundPoll = throttleTrailing(() => {
		void pollSubagents();
		void refreshAgent(false);
	}, 2000);
	$effect(() => () => backgroundPoll.cancel());
	function noteChildActivity(childId: string) {
		childActivity[childId] = (childActivity[childId] ?? 0) + 1;
		// While the parent is settled but a background child still works, its
		// envelopes are the only liveness signal this view gets: re-ask the
		// roster (and the snapshot carrying `childSummary`) on them,
		// throttled — with a trailing call, so the envelope that says the child
		// finished is never the one dropped — and the background banner and the
		// subagent cards settle when the child does.
		if (rosterPhase !== "settled" || skipMachineFetches) return;
		backgroundPoll.call();
	}

	/** The claim ChatMessage asks per tool call: does a subagent own this
	 * row? The polled roster rules; a task-named call anchors pre-pairing. */
	function subagentFor(callId: string): CodeSubagentAnchor | undefined {
		const subagent = subagentsByCallId.get(callId) ?? null;
		const description = taskCalls.get(callId);
		if (!subagent && description === undefined) return undefined;
		return {
			subagent,
			fallbackTitle: description ?? subagent?.description ?? "",
			load: subagent
				? () =>
						fetchSubagentTimeline(deviceId, agentId, subagent.id).then((result) => result.updates)
				: null,
		};
	}

	function stateTone(state: CodeTurnState): s.PillTone {
		if (state === "running" || state === "waiting-permission") return "busy";
		if (state === "error") return "bad";
		if (state === "done") return "good";
		return "neutral";
	}

	// The workspace's own name, from the daemon's list; unknown means the
	// strip simply carries the pills.
	let workspaceName = $derived(workspace?.name ?? "");

	async function handleSend(text: string, files: File[] = []) {
		// The composer already refuses to submit on a known-expired
		// enrollment; this is the backstop for a send that raced ahead of
		// the probe's answer (Enter fired before `enrollmentExpired` landed).
		if (enrollmentExpired) {
			failure = "This machine's enrollment expired or was revoked — re-enroll to send.";
			return;
		}
		// A steer joins a turn that already shows its own indicator.
		pending = !loading;
		failure = null;
		// The send is the request to see the exchange — same contract as chat.
		column?.notifySend();
		try {
			// Files go up first, under the id the prompt then carries: the server
			// finds them by it, hands them to the machine, and the transcript
			// renders them from the store after the machine echoes the id back.
			const messageId = crypto.randomUUID();
			if (files.length) await uploadComposerFiles(attachmentsUrl, messageId, files);
			await sendFollowUp(deviceId, agentId, text, messageId);
		} catch (err) {
			pending = false;
			// A 401 here is the forwarder's own word that the daemon's
			// enrollment died mid-session — the pill and the composer both
			// need to know, not just this one banner.
			if (err instanceof CodeApiError && err.status === 401) {
				codeEnrollment[deviceId] = "expired";
			}
			failure = err instanceof Error ? err.message : "Could not send the follow-up.";
			// Tell the composer it did not land, so it keeps the draft.
			throw err;
		}
	}

	/** The stop control: ask the daemon to end the live turn. This response
	 * is the receipt, not the outcome — the transcript records the ending
	 * itself: `turn_canceled` folds to a terminal state (so the dots stop
	 * and the send button returns), and where a permission card is waiting
	 * the daemon resolves it denied, which settles the card through the
	 * fold's existing resolution path. Stopping is exactly the move for a
	 * prompt nobody wants to answer. */
	async function stopAgent(): Promise<boolean> {
		failure = null;
		try {
			await cancelAgent(deviceId, agentId);
			return true;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not stop the agent.";
			return false;
		}
	}

	/** The agent's approval card answers through the forwarder, not the chat's
	 * elicitation endpoint — the daemon owns the request's lifetime. `scope`
	 * is only ever `"always"` (the card's "Always allow" button); "once" is
	 * the default accept, and any non-accept action is a reject regardless
	 * of scope. A subagent's card (labelled with its session by the bridge)
	 * answers through the same call with the child's session, so the reply
	 * reaches the child's own waiting request. */
	async function answerPermission(
		request: ElicitationRequestPayload,
		action: ElicitationAction,
		scope?: "always"
	): Promise<{ ok: boolean; error?: string; note?: string }> {
		try {
			const reply = await respondPermission(
				deviceId,
				agentId,
				request.elicitationId,
				action === "accept" ? (scope === "always" ? "always" : "once") : "reject",
				request.childSessionId
			);
			permissionsKey += 1;
			if (reply?.alreadyResolved) return { ok: true, note: ALREADY_ANSWERED_NOTE };
			return { ok: true };
		} catch (err) {
			return replyOutcome(err, "Could not answer the request.");
		}
	}

	/** The agent-initiated question tool (user-question design): the SAME
	 * global store and card chat's own `ask_user_question` uses, keyed on
	 * this agent's id instead of a conversation id — `questionRequestedToUpdate`
	 * on the server side is what actually registers one, via the ordinary
	 * elicitation fold `consumeAgentUpdates` already runs. */
	let questionStore = $derived(firstQuestionFor(agentId));
	let askQuestion = $derived($questionStore);

	/** `content` keys are `q0`, `q1`, … in question order (see
	 * `questionRequestedToUpdate`); each value is the option label(s) picked
	 * for that question, and `respondQuestion` wants them back the same way
	 * `questionResolvedToUpdate` will read them off the resolved event. */
	async function answerQuestion(
		action: ElicitationAction,
		content?: Record<string, ElicitationValue>
	): Promise<{ ok: boolean; error?: string }> {
		if (!askQuestion) return { ok: false, error: "No question is open." };
		const requestId = askQuestion.request.elicitationId;
		try {
			const answers = content
				? Object.keys(content)
						.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
						.map((key) => {
							const value = content[key];
							return (Array.isArray(value) ? value : [value]).map(String);
						})
				: undefined;
			await respondQuestion(
				deviceId,
				agentId,
				requestId,
				action === "accept" ? "accept" : "decline",
				answers,
				askQuestion.request.childSessionId
			);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Could not answer the question.",
			};
		}
	}

	let column: ChatMessageColumn | undefined = $state();

	// ── Fork handoff (parity plan §4.2(a)) ───────────────────────────────
	//
	// No lineage label exists on this wire, so the link back
	// is read straight off the child's own title — set once at creation by
	// the forwarder's handoff route, never touched again — rather than a
	// fetched reference. A title collision (someone renames a session to
	// start the same way) is the one false positive this accepts; the spec
	// calls that an acceptable "keep it simple" tradeoff.
	let handedOffFromTitle = $derived(forkedFromTitle(agent?.title));

	/** The message "Fork from here" was clicked on — open state for the dialog. */
	let handoffFor = $state<Message | null>(null);
</script>

<!-- The subagent card is the panel's own renderer for the slots ChatMessage
     opens where a Task tool call is claimed: the card carries the roster
     row, the fallback title, and the transcript fetch, and ChatMessage stays
     free of any panel import. -->
{#snippet subagentCard(anchor: CodeSubagentAnchor)}
	<SubagentCard {anchor} activity={childActivity[anchor.subagent?.id ?? ""] ?? 0} />
{/snippet}

<!-- The "Fork from here" action ChatMessage opens per forkable assistant
     message (an optional prop/snippet pair, so chat itself stays
     unchanged) — opens this view's own HandoffDialog below. -->
{#snippet messageActions(message: Message)}
	<button
		class="btn rounded-xs p-1 text-xs text-gray-400 hover:text-gray-500 focus:ring-0 dark:text-gray-400 dark:hover:text-gray-300"
		title="Fork from here"
		aria-label="Fork from here"
		type="button"
		onclick={() => (handoffFor = message)}
	>
		<IconFork />
	</button>
{/snippet}

<!-- pointer-events-none on every wrapper above the column, the ChatWindow
     contract: the column paints at z-[-1] (its own contract, see
     ChatMessageColumn), so any pointer-enabled ancestor between it and the
     page intercepts clicks meant for the composer — the prompt box read as
     locked while the rest stayed responsive. The column, the strip, the
     failure banner and the side pane re-enable pointer events themselves. -->
<div class="pointer-events-none flex h-full min-h-0 flex-1 flex-col">
	<div class="pointer-events-auto flex flex-col gap-0.5 px-4 pt-3 pb-2">
		{#if agent?.parentId}
			<a
				class="flex min-w-0 items-center gap-1 text-xs text-ink-muted hover:text-ink"
				href="{base}/code?device={deviceId}&ws={parentAgent?.workspaceId ??
					workspaceId ??
					''}&agent={agent.parentId}"
				data-testid="subagent-of"
			>
				<span
					class="shrink-0 rounded-sm bg-gray-100 px-1 text-[10px] font-medium uppercase dark:bg-gray-700"
					>sub</span
				>
				<span class="truncate">Subagent of {parentAgent?.title ?? "its parent session"}</span>
			</a>
		{/if}
		{#if agent?.spawnedBy && !agent.parentId}
			<a
				class="flex min-w-0 items-center gap-1 text-xs text-ink-muted hover:text-ink"
				href={sessionLinks.href(agent.spawnedBy.sessionId)}
				data-testid="spawned-by"
			>
				<span class="truncate"
					>spawned by {sessionLinks.title(agent.spawnedBy.sessionId) ?? agent.spawnedBy.title}</span
				>
			</a>
		{/if}
		<div class="flex items-center gap-2">
			<IconCode class="size-4 shrink-0 text-ink-muted" />
			{#if workspaceName}
				<span class="min-w-0 truncate text-sm font-medium text-ink" title={workspace?.path}>
					{workspaceName}
				</span>
			{/if}
			<span class="min-w-0 flex-1"></span>
			{#if agent}
				<span class="{s.PILL} {s.PILL_TONES.neutral}">{agent.provider}</span>
				<span class="{s.PILL} {s.PILL_TONES[stateTone(shownState)]}">{shownState}</span>
			{/if}
			<TogglePill
				compact
				pressed={sidePane.open && sidePane.view === "tasks"}
				label={tasksProgress.total > 0
					? `Tasks ${tasksProgress.done}/${tasksProgress.total}`
					: "Tasks"}
				badge={tasksProgress.total > 0 ? `${tasksProgress.done}/${tasksProgress.total}` : undefined}
				title="The agent's task list"
				onclick={() => sidePane.toggleTasks()}
			>
				{#snippet icon()}<IconTaskComplete class="size-3.5" />{/snippet}
			</TogglePill>
			<TogglePill
				compact
				pressed={sidePane.open && sidePane.view === "diff"}
				label="Changes"
				title="Files this agent changed, as diffs"
				onclick={() => sidePane.toggleDiff()}
			>
				{#snippet icon()}<IconDiff class="size-3.5" />{/snippet}
			</TogglePill>
			{#if filesOffered && (workspace?.id ?? workspaceId)}
				<TogglePill
					compact
					pressed={sidePane.open && sidePane.view === "files"}
					label="Files"
					disabled={filesVetoed}
					title={filesVetoed
						? "This machine was enrolled with --no-files: re-enroll without it to browse files here."
						: "Browse this workspace's files (read-only)"}
					onclick={() => sidePane.toggleFiles()}
				>
					{#snippet icon()}<IconFolder class="size-3.5" />{/snippet}
				</TogglePill>
			{/if}
			{#if terminalOffered && (workspace?.id ?? workspaceId)}
				<TogglePill
					compact
					pressed={sidePane.open && sidePane.view === "terminal"}
					label="Terminal"
					disabled={terminalVetoed}
					title={terminalVetoed
						? "This machine was enrolled with terminals off. Re-enroll it (terminals are on by default) to use them here."
						: "Open a shell on this workspace"}
					onclick={() => sidePane.toggleTerminal()}
				>
					{#snippet icon()}<IconTerminal class="size-3.5" />{/snippet}
				</TogglePill>
			{/if}
		</div>
		{#if handedOffFromTitle}
			<!-- A title-based link, not a fetched one (spec's "keep it simple") —
			     see the `handedOffFromTitle` derivation above. -->
			<span class="flex items-center gap-1 truncate pl-6 text-xs text-ink-muted">
				<IconFork class="size-3 shrink-0" />
				Forked from {handedOffFromTitle}
			</span>
		{/if}
		{#if backgroundRunning}
			<!-- The parent is settled (its pill reads idle/done) while a
			     background subagent still works: say so here, with the
			     daemon's own counts, rather than letting the idle pill imply
			     nothing is happening. -->
			<span
				class="flex items-center gap-1.5 truncate pl-6 text-xs text-ink-muted"
				data-testid="background-running"
			>
				<span class="size-2 shrink-0 animate-pulse rounded-full bg-blue-500" aria-label="running"
				></span>
				<span class="truncate">
					{backgroundRunningCount === 1
						? "A subagent is"
						: `${backgroundRunningCount} subagents are`} still running in the background.
					{#if backgroundWaitingCount > 0}
						{backgroundWaitingCount === 1 ? "One is" : `${backgroundWaitingCount} are`} waiting on your
						approval below.
					{/if}
				</span>
			</span>
		{/if}
		{#if shownState === "running" && liveTurn?.retry}
			<!-- The model's provider is refusing (a rate limit, an outage) and
			     the backend is retrying with backoff: say so instead of
			     letting a silent running turn read as a hang. -->
			<RetryNotice retry={liveTurn.retry} />
		{/if}
		<!-- The Permissions line lived here; it is a sidebar item now
		     (CodeNavTree's "Permissions", opening the detail in a dialog),
		     so the transcript keeps this height. -->
	</div>

	{#if deviceOffline}
		<!-- The clean state this replaces: with no gate here, the strip's
		     pills just vanished (an agent snapshot the daemon never got asked
		     for), the transcript sat on "Ready when you are" as if nothing had
		     ever run, and only a send attempt surfaced anything was wrong. -->
		<div
			class="pointer-events-auto mx-4 mb-2 flex items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
		>
			This machine is offline. It will pick back up here once it reconnects.
		</div>
	{:else if failure}
		<div class="pointer-events-auto {s.ERROR} mx-4 mb-2">{failure}</div>
	{/if}

	<!-- pointer-events-none: the message column paints at z-[-1] (its own
	     contract, see ChatMessageColumn), which places it behind this row's
	     own hit box — a plain flex row intercepted every click meant for the
	     composer, and the prompt box read as locked while the rest stayed
	     responsive. The column re-enables pointer events itself; the side
	     pane renders above and is not affected. -->
	<div class="pointer-events-none flex min-h-0 flex-1">
		<ChatMessageColumn
			{messages}
			{loading}
			{pending}
			{historyPending}
			{showPlaceholder}
			conversationKey="{deviceId}:{agentId}"
			conversationId={agentId}
			fileBaseUrl={attachmentsUrl}
			onanswerElicitation={answerPermission}
			onScrollNearTop={requestPreviousPage}
			onretry={revertSupported &&
			!loading &&
			shownState !== "running" &&
			shownState !== "waiting-permission"
				? onretry
				: undefined}
			{subagentFor}
			{subagentCard}
			{messageActions}
			{messageActionsWhen}
			bind:this={column}
		>
			{#snippet head()}
				<!-- The older-transcript rows: nothing until the machine said
				     (historyMeta) whether older pages exist behind the newest
				     one. A short session's start reads as quietly as an old
				     galopin's whole snapshot — no marker at all there. -->
				{#if !historyPending && historyHasMore !== null}
					<div class="flex flex-col items-center py-1 text-center" aria-live="polite">
						{#if historyFetching}
							<p class="animate-pulse text-xs text-ink-muted">Loading earlier messages…</p>
						{:else if historyError}
							<p class="text-xs text-ink-muted">
								Couldn't load earlier messages.
								<button
									type="button"
									class="underline underline-offset-2"
									onclick={requestPreviousPage}
								>
									Retry
								</button>
							</p>
						{:else if historyHasMore === false}
							<p class="text-xs text-ink-faint">Start of the session</p>
						{/if}
					</div>
				{/if}
			{/snippet}
			{#snippet historyLoading()}
				<!-- The transcript's first snapshot is still folding (see
				     `historyPending`): same shape as the introduction below,
				     so the pane never reads blank or as an empty session. -->
				<div
					class="flex h-full flex-col items-center justify-center gap-2 pb-24 text-center"
					data-testid="transcript-loading"
				>
					<IconRenew class="size-7 animate-spin text-ink-faint" aria-hidden="true" />
					<p class="text-sm font-medium text-ink">Loading conversation…</p>
					<!-- Two turns' worth of skeleton rows, the shape of what is
					     about to land: a prompt, then its reply. -->
					<div class="mt-4 flex w-full max-w-lg flex-col gap-4" aria-hidden="true">
						<div
							class="ml-auto h-2.5 w-1/3 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800"
						></div>
						<div class="flex flex-col gap-2">
							<div
								class="h-2.5 w-5/6 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800"
							></div>
							<div
								class="h-2.5 w-2/3 animate-pulse rounded-full bg-gray-100 dark:bg-gray-800"
							></div>
						</div>
					</div>
				</div>
			{/snippet}
			{#snippet introduction()}
				<div class="flex h-full flex-col items-center justify-center gap-2 pb-24 text-center">
					<IconCode class="size-10 text-ink-faint" />
					<p class="text-sm font-medium text-ink">Ready when you are</p>
					<p class="max-w-xs text-xs text-ink-muted">
						Describe the task below. The mode pill sets how much the agent may do on its own, and it
						asks before anything destructive.
					</p>
				</div>
			{/snippet}
			{#snippet composer()}
				{#if askQuestion}
					<AskQuestion
						conversationId={askQuestion.conversationId}
						request={askQuestion.request}
						onanswer={answerQuestion}
					/>
				{/if}
				<AgentComposer
					{deviceId}
					{agentId}
					{agent}
					{ceiling}
					permissionExceptions={permissionRules?.savedApprovals.length ?? 0}
					policy={codeDeviceList.devices.find((d) => d.id === deviceId)?.policy}
					device={codeDeviceList.devices.find((d) => d.id === deviceId)}
					{modes}
					{modesFailure}
					{models}
					{modelsFailure}
					{modelsHidden}
					running={loading}
					{enrollmentExpired}
					offline={deviceOffline}
					onsend={handleSend}
					onstop={stopAgent}
					onchanged={() => void refreshAgent()}
					onpermissionchanged={() => {
						void refreshAgent(false);
						permissionsKey += 1;
					}}
					onreenroll={() => (showReenroll = true)}
					{usage}
					{lastCompaction}
					{usageSupported}
					{effortsSupported}
					{compactSupported}
					{revertSupported}
					{steerSupported}
					onundo={openUndoConfirm}
					onnew={openNewAgentDialog}
					mimeTypes={filesSupported ? [...AGENT_ATTACHMENT_MIME_ALLOWLIST] : []}
				/>
			{/snippet}
		</ChatMessageColumn>

		{#if sidePane.open && sidePane.view === "tasks"}
			<SidePane label="Tasks" title="Tasks">
				<CodeTasks plan={latestTasks} />
			</SidePane>
		{:else if sidePane.open && sidePane.view === "diff"}
			<SidePane label="Agent changes" title="Changes">
				{#snippet actions()}
					<button
						type="button"
						class="btn rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
						onclick={() => (diffRefreshKey += 1)}
						disabled={diffLoading}
						aria-label="Refresh changes"
						title="Refresh from the daemon"
					>
						<IconRenew class="size-4 {diffLoading ? 'animate-spin' : ''}" />
					</button>
				{/snippet}
				<AgentDiff {deviceId} {agentId} refreshKey={diffRefreshKey} bind:loading={diffLoading} />
			</SidePane>
		{:else if sidePane.open && sidePane.view === "files" && filesOffered && (workspace?.id ?? workspaceId)}
			<SidePane label="Workspace files" title="Files">
				<CodeFiles
					{deviceId}
					workspaceId={(workspace?.id ?? workspaceId) as string}
					turnKey={filesTurnKey}
				/>
			</SidePane>
		{:else if sidePane.open && sidePane.view === "terminal" && terminalOffered && !terminalVetoed && (workspace?.id ?? workspaceId)}
			<SidePane label="Terminal" title="Terminal">
				<CodeTerminals {deviceId} workspaceId={(workspace?.id ?? workspaceId) as string} />
			</SidePane>
		{/if}
	</div>
</div>

{#if showReenroll}
	<!-- The same pairing dialog the sidebar's device pill opens (see
	     CodeNavTree). A re-enroll mints a fresh machine id (spec §3), so it
	     is a new pending row to confirm, not an update to this one — the
	     expired row here still needs revoking separately once the new
	     machine is up. -->
	<PairDeviceDialog
		onclose={() => (showReenroll = false)}
		onpaired={() => (showReenroll = false)}
	/>
{/if}

{#if rollback}
	<CodeConfirmDialog
		title="Retry from here?"
		target={rollback.text.length > 80 ? `${rollback.text.slice(0, 80)}…` : rollback.text}
		message="The conversation is rolled back to before this prompt, which is then sent again. {rollback.files}"
		confirmLabel="Roll back and send"
		busyLabel="Rolling back…"
		onconfirm={confirmRollback}
		onclose={() => (rollback = null)}
	/>
{/if}

{#if undoTarget}
	<!-- /undo's confirmation: the transcript's own revert dialog, without the
	     re-send — the command undoes the last prompt and stops there. -->
	<CodeConfirmDialog
		title="Roll back?"
		target={undoTarget.text.length > 80 ? `${undoTarget.text.slice(0, 80)}…` : undoTarget.text}
		message="The conversation is rolled back to before this prompt. {undoTarget.files}"
		confirmLabel="Roll back"
		busyLabel="Rolling back…"
		onconfirm={confirmUndo}
		onclose={() => (undoTarget = null)}
	/>
{/if}

{#if newAgentDialogOpen && workspace}
	<!-- /new's dialog: the same create flow the tree opens, scoped to this
	     agent's workspace. The callback copies the workspace out first — it
	     runs after the dialog's own state settles, when the {#if} guard no
	     longer narrows it. -->
	<AgentDialog
		{deviceId}
		{workspace}
		onclose={() => (newAgentDialogOpen = false)}
		oncreated={(created) => {
			const createdInto = workspace;
			newAgentDialogOpen = false;
			if (createdInto) {
				void goto(`${base}/code?device=${deviceId}&ws=${createdInto.id}&agent=${created.id}`, {
					keepFocus: true,
				});
			}
		}}
	/>
{/if}

{#if handoffFor && agent}
	{@const fallbackWorkspace = {
		id: agent.workspaceId,
		name: workspaceName || agent.workspaceId,
		path: agentCwd ?? "",
		// Unknown until the workspace list loads; the handoff dialog never offers
		// git-only actions, so false is the safe reading.
		isGitRepo: false,
	}}
	<HandoffDialog
		{deviceId}
		{agentId}
		agentTitle={agent.title}
		workspace={workspace ?? fallbackWorkspace}
		provider={agent.provider}
		modeId={agent.modeId}
		modelId={agent.modelId}
		uptoMessageId={handoffFor.machineMessageId}
		onclose={() => (handoffFor = null)}
		onhandoff={(result) => {
			const dest = `${base}/code?device=${result.deviceId}&ws=${result.agent.workspaceId}&agent=${result.agent.id}`;
			void goto(dest, { keepFocus: true });
		}}
	/>
{/if}
