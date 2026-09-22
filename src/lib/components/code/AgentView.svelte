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
	answering through the relay forwarder. Git changes live in the shared side
	pane; the composer carries the agent's mode and model as pills, switched
	live on the daemon rather than per send.

	The address (`?device=&ws=&agent=`) is the selection; the `{#key}` in
	`CodePanel` remounts this whole view on a new address, so the transcript is
	always a fresh replay of the daemon's log for this agent, never a stale
	one. The reply is NOT inserted optimistically: the stream echoes the
	person's message back, and the stream is the transcript's source of truth.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import type { ElicitationAction, ElicitationRequestPayload } from "$lib/types/McpElicitation";
	import { MessageUpdateType, type MessageTurnStateUpdate } from "$lib/types/MessageUpdate";
	import type { CodeAgentSession, CodeTurnState, CodeWorkspace } from "$lib/types/CodeAgent";
	import type { Message } from "$lib/types/Message";
	import { isConversationGenerationActive } from "$lib/utils/generationState";
	import { shouldShowPendingPlaceholder } from "$lib/utils/pendingPlaceholder";
	import { consumeAgentUpdates } from "$lib/utils/consumeAgentUpdates";
	import { codeAgentStream } from "$lib/codeAgentStream";
	import { getAgent, listWorkspaces, respondPermission, sendFollowUp } from "$lib/codeApi";
	import ChatMessageColumn from "$lib/components/chat/ChatMessageColumn.svelte";
	import SidePane from "$lib/components/chat/SidePane.svelte";
	import AgentComposer from "./AgentComposer.svelte";
	import AgentDiff from "./AgentDiff.svelte";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import IconCode from "~icons/carbon/code";
	import IconDiff from "~icons/lucide/diff";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The workspace the address named, so the strip can name it without guessing. */
		workspaceId?: string;
	}

	let { deviceId, agentId, workspaceId }: Props = $props();

	let agent = $state<CodeAgentSession | null>(null);
	let workspace = $state<CodeWorkspace | null>(null);
	let messages = $state<Message[]>([]);
	let pending = $state(false);
	let failure = $state<string | null>(null);

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

	onMount(() => {
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
	 * strip's pills and the composer's mode/model pills label from the
	 * daemon's own word, never from what the request claimed. */
	async function refreshAgent() {
		try {
			agent = (await getAgent(deviceId, agentId)).agent;
		} catch {
			// The transcript carries its own states; a strip that only
			// errors when the daemon is off is worse than fallbacks.
			agent = null;
		}
	}

	// Mounting this iterator IS the history fetch (a fresh subscription replays
	// the daemon's log before tailing), so the transcript assembles itself from
	// one source and needs no snapshot call. The fold is the chat's own turn
	// machinery; live updates land through it without a refresh.
	//
	// The fold runs untracked on purpose: it holds the `messages` array for the
	// whole subscription, and reading it tracked here would re-run this effect
	// on the very frames it folds — tearing the stream down mid-transcript.
	// The device and agent ids stay tracked: a new address restarts the replay.
	$effect(() => {
		messages = [];
		pending = false;
		const abort = new AbortController();
		untrack(() => {
			(async () => {
				try {
					await consumeAgentUpdates(codeAgentStream(deviceId, agentId, abort.signal), messages, {
						isAborted: () => abort.signal.aborted,
						onAbort: () => abort.abort(),
						onTurnEvent: () => (pending = false),
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

	function stateTone(state: CodeTurnState): s.PillTone {
		if (state === "running" || state === "waiting-permission") return "busy";
		if (state === "error") return "bad";
		if (state === "done") return "good";
		return "neutral";
	}

	// The workspace's own name, from the daemon's list; unknown means the
	// strip simply carries the pills.
	let workspaceName = $derived(workspace?.name ?? "");

	async function handleSend(text: string) {
		pending = true;
		failure = null;
		// The send is the request to see the exchange — same contract as chat.
		column?.notifySend();
		try {
			await sendFollowUp(deviceId, agentId, text);
		} catch (err) {
			pending = false;
			failure = err instanceof Error ? err.message : "Could not send the follow-up.";
		}
	}

	/** The agent's approval card answers through the forwarder, not the chat's
	 * elicitation endpoint — the daemon owns the request's lifetime. */
	async function answerPermission(
		request: ElicitationRequestPayload,
		action: ElicitationAction
	): Promise<{ ok: boolean; error?: string }> {
		try {
			await respondPermission(
				deviceId,
				agentId,
				request.elicitationId,
				action === "accept" ? "approve" : "deny"
			);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : "Could not answer the request.",
			};
		}
	}

	let column: ChatMessageColumn | undefined = $state();
</script>

<!-- pointer-events-none on every wrapper above the column, the ChatWindow
     contract: the column paints at z-[-1] (its own contract, see
     ChatMessageColumn), so any pointer-enabled ancestor between it and the
     page intercepts clicks meant for the composer — the prompt box read as
     locked while the rest stayed responsive. The column, the strip, the
     failure banner and the side pane re-enable pointer events themselves. -->
<div class="pointer-events-none flex h-full min-h-0 flex-1 flex-col">
	<div class="pointer-events-auto flex items-center gap-2 px-4 pt-3 pb-2">
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
	</div>

	{#if failure}
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
			onanswerElicitation={answerPermission}
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
				<AgentComposer
					{deviceId}
					{agentId}
					{agent}
					onsend={handleSend}
					onchanged={() => void refreshAgent()}
				/>
			{/snippet}
		</ChatMessageColumn>

		{#if sidePane.open && sidePane.view === "diff"}
			<SidePane label="Agent changes">
				<AgentDiff {deviceId} {agentId} />
			</SidePane>
		{/if}
	</div>
</div>
