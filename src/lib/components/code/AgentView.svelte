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
	import { untrack } from "svelte";
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
	import { shouldShowPendingPlaceholder } from "$lib/utils/pendingPlaceholder";
	import { consumeAgentUpdates } from "$lib/utils/consumeAgentUpdates";
	import { codeAgentStream } from "$lib/codeAgentStream";
	import {
		CodeApiError,
		cancelAgent,
		fetchSubagentTimeline,
		getAgent,
		listSubagents,
		listWorkspaces,
		respondPermission,
		respondQuestion,
		sendFollowUp,
		revertAgent,
	} from "$lib/codeApi";
	import type { CodeProviderFeature } from "$lib/codeApi";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { uploadComposerFiles } from "$lib/utils/composerFiles";
	import { keepReportedUsage } from "$lib/utils/agentUsage";
	import { AGENT_ATTACHMENT_MIME_ALLOWLIST } from "$lib/constants/mime";
	import ChatMessageColumn from "$lib/components/chat/ChatMessageColumn.svelte";
	import SidePane from "$lib/components/chat/SidePane.svelte";
	import AgentComposer from "./AgentComposer.svelte";
	import AgentDiff from "./AgentDiff.svelte";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import SubagentCard from "./SubagentCard.svelte";
	import HandoffDialog from "./HandoffDialog.svelte";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";
	import CodeFiles from "./CodeFiles.svelte";
	import CodeTerminals from "./CodeTerminals.svelte";
	import IconFolder from "~icons/carbon/folder";
	import IconTerminal from "~icons/carbon/terminal";
	import AskQuestion from "$lib/components/chat/AskQuestion.svelte";
	import { firstQuestionFor } from "$lib/stores/pendingQuestion";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import { codeEnrollment } from "$lib/stores/codeEnrollment.svelte";
	import IconCode from "~icons/carbon/code";
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
	/** The provider features the agent itself reports — the auto-accept
	 * toggle's live value. Cleared with the snapshot on a failed read: a
	 * toggle with no daemon word behind it does not render as on or off. */
	let features = $state<CodeProviderFeature[]>([]);
	/** The agent's working directory, from the same read: the feature list
	 * the composer asks for is resolved per working directory on the daemon. */
	let agentCwd = $state<string | null>(null);
	let workspace = $state<CodeWorkspace | null>(null);
	let messages = $state<Message[]>([]);
	let pending = $state(false);
	let failure = $state<string | null>(null);
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
	$effect(() => {
		const state = shownState;
		if (lastTurnState === "running" && state !== "running") filesTurnKey += 1;
		lastTurnState = state;
	});
	/** The terminal (ADR 0090 §6.1): the double veto's two halves — the
	 * deployment switch (hidden entirely when off) and the machine's own
	 * policy (shown disabled, with the exact re-enroll fix, when off). */
	let terminalOffered = $derived(
		page.data.codeTerminalEnabled === true &&
			codeDeviceList.devices.find((d) => d.id === deviceId)?.machine?.capabilities.terminal ===
				true
	);
	let terminalVetoed = $derived(
		codeDeviceList.devices.find((d) => d.id === deviceId)?.policy?.terminal !== "allowed"
	);
	let terminalAcknowledged = $state(false);
	$effect(() => {
		terminalAcknowledged = Boolean(
			codeDeviceList.devices.find((d) => d.id === deviceId)?.terminalAckAt
		);
	});
	let effortsSupported = $derived.by(() => {
		const caps = codeDeviceList.devices
			.find((d) => d.id === deviceId)
			?.backends?.find((b) => b.id === agent?.provider)?.capabilities;
		return Boolean(caps?.efforts);
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
	 * strip's pills, the composer's mode/model pills and the feature
	 * toggles label from the daemon's own word, never from what a request
	 * claimed. */
	async function refreshAgent() {
		try {
			const detail = await getAgent(deviceId, agentId);
			agent = detail.agent;
			features = detail.features ?? [];
			agentCwd = detail.cwd;
			// The snapshot's own word, not a guess: if the daemon's last real
			// attempt on this agent already failed on an expired/revoked
			// grant, say so immediately rather than waiting on the device
			// probe's next poll to catch up.
			if (detail.enrollmentExpired) codeEnrollment[deviceId] = "expired";
		} catch {
			// The transcript carries its own states; a strip that only
			// errors when the daemon is off is worse than fallbacks.
			agent = null;
			features = [];
			agentCwd = null;
		}
	}

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
						onReset: () => {
							usage = null;
							lastCompaction = null;
						},
					});
				} catch (err) {
					if (!abort.signal.aborted) {
						failure = err instanceof Error ? err.message : "The agent stream failed.";
					}
				}
			})();
		});
		return () => abort.abort();
	});

	let streamNonce = $state(0);

	// ── Retry and rollback (capability `revert`) ────────────────────
	// Retry on an answer rolls back to the prompt that produced it and sends
	// that prompt again; editing a prompt rolls back to it and sends the new
	// text. Both confirm first, saying whether files come back too. There is
	// no undo here: the re-sent prompt is what ends a revert's undo window
	// (opencode drops the reverted turns on the next prompt).
	let rollback = $state<{ userMessageId: string; text: string; files: string } | null>(null);

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
		await handleSend(text);
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
	function noteChildActivity(childId: string) {
		childActivity[childId] = (childActivity[childId] ?? 0) + 1;
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
		pending = true;
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
		}
	}

	/** The stop control: ask the daemon to end the live turn. This response
	 * is the receipt, not the outcome — the transcript records the ending
	 * itself: `turn_canceled` folds to a terminal state (so the dots stop
	 * and the send button returns), and where a permission card is waiting
	 * the daemon resolves it denied, which settles the card through the
	 * fold's existing resolution path. Stopping is exactly the move for a
	 * prompt nobody wants to answer. */
	async function stopAgent() {
		failure = null;
		try {
			await cancelAgent(deviceId, agentId);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not stop the agent.";
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
	): Promise<{ ok: boolean; error?: string }> {
		try {
			await respondPermission(
				deviceId,
				agentId,
				request.elicitationId,
				action === "accept" ? (scope === "always" ? "always" : "once") : "reject",
				request.childSessionId
			);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Could not answer the request.",
			};
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
	// No lineage label exists on this wire (unlike paseo's), so the link back
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

<!-- The "Fork from here" action ChatMessage opens per completed assistant
     message (an optional prop/snippet, so chat itself stays unchanged) —
     opens this view's own HandoffDialog below. -->
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
			<button
				type="button"
				class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {sidePane.open &&
				sidePane.view === 'diff'
					? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
					: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}"
				onclick={() => sidePane.toggleDiff()}
				title="Files this agent changed, as diffs"
			>
				<IconDiff class="size-3.5" />
				Changes
			</button>
			{#if filesOffered && (workspace?.id ?? workspaceId)}
				<button
					type="button"
					class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-60 {sidePane.open &&
					sidePane.view === 'files'
						? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
						: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}"
					disabled={filesVetoed}
					onclick={() => sidePane.toggleFiles()}
					title={filesVetoed
						? "This machine was enrolled with --no-files: re-enroll without it to browse files here."
						: "Browse this workspace's files (read-only)"}
				>
					<IconFolder class="size-3.5" />
					Files
				</button>
			{/if}
			{#if terminalOffered && (workspace?.id ?? workspaceId)}
				<button
					type="button"
					class="flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-60 {sidePane.open &&
					sidePane.view === 'terminal'
						? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
						: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'}"
					disabled={terminalVetoed}
					onclick={() => sidePane.toggleTerminal()}
					title={terminalVetoed
						? "This machine was enrolled without --allow-terminal. Re-enroll with it to use terminals here."
						: "Open a shell on this workspace"}
				>
					<IconTerminal class="size-3.5" />
					Terminal
				</button>
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
			{showPlaceholder}
			conversationKey="{deviceId}:{agentId}"
			conversationId={agentId}
			fileBaseUrl={attachmentsUrl}
			onanswerElicitation={answerPermission}
			onretry={revertSupported &&
			!loading &&
			shownState !== "running" &&
			shownState !== "waiting-permission"
				? onretry
				: undefined}
			{subagentFor}
			{subagentCard}
			{messageActions}
			bind:this={column}
		>
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
					{features}
					cwd={agentCwd}
					running={loading}
					{enrollmentExpired}
					offline={deviceOffline}
					onsend={handleSend}
					onstop={stopAgent}
					onchanged={() => void refreshAgent()}
					onreenroll={() => (showReenroll = true)}
					{usage}
					{lastCompaction}
					{usageSupported}
					{effortsSupported}
					mimeTypes={filesSupported ? [...AGENT_ATTACHMENT_MIME_ALLOWLIST] : []}
				/>
			{/snippet}
		</ChatMessageColumn>

		{#if sidePane.open && sidePane.view === "diff"}
			<SidePane label="Agent changes">
				<AgentDiff {deviceId} {agentId} />
			</SidePane>
		{:else if sidePane.open && sidePane.view === "files" && filesOffered && (workspace?.id ?? workspaceId)}
			<SidePane label="Workspace files">
				<CodeFiles
					{deviceId}
					workspaceId={(workspace?.id ?? workspaceId) as string}
					turnKey={filesTurnKey}
				/>
			</SidePane>
		{:else if sidePane.open && sidePane.view === "terminal" && terminalOffered && !terminalVetoed && (workspace?.id ?? workspaceId)}
			<SidePane label="Terminal">
				<CodeTerminals
					{deviceId}
					workspaceId={(workspace?.id ?? workspaceId) as string}
					machineName={codeDeviceList.devices.find((d) => d.id === deviceId)?.name ?? "this machine"}
					bind:acknowledged={terminalAcknowledged}
				/>
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
