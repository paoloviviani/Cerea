<!--
	The message column: the chat's scroll machinery and turn rendering,
	shared by every surface that reads like a conversation.

	Extracted from ChatWindow so the coding-agent screen (`/code`) can mount
	the very same column — same sticky-bottom controller, same anchored-turn
	reservation, same `ChatMessage` rendering — instead of a bespoke
	re-implementation that drifts (and re-derives liveness wrong). Everything
	conversation-specific stays with the caller as snippets: the composer
	overlay's content, the empty-conversation introduction, absolutely
	positioned chrome, and anything rendered after the turns.

	The column owns: turn grouping, `createChatScroll` and its structural
	sync, the composer-clearance measurement, the jump buttons, and the
	pending placeholder.
-->
<script lang="ts">
	import type { Message } from "$lib/types/Message";
	import { untrack } from "svelte";
	import type { Snippet } from "svelte";

	import ChatMessage from "./ChatMessage.svelte";
	import ScrollToBottomBtn from "../ScrollToBottomBtn.svelte";
	import ScrollToPreviousBtn from "../ScrollToPreviousBtn.svelte";
	import { createChatScroll } from "$lib/utils/scroll/chatScroll.svelte";
	import { isAssistantGenerationTerminal } from "$lib/utils/generationState";
	import { NAV_EDGE_SWIPE_ZONE_PX } from "$lib/constants/gestures";
	import type { ElicitationAction, ElicitationRequestPayload } from "$lib/types/McpElicitation";
	import type { CodeSubagentAnchor } from "$lib/types/CodeAgent";

	interface Props {
		messages: Message[];
		messagesAlternatives?: Message["id"][][];
		loading?: boolean;
		/** A send is in flight and nothing on screen will receive its stream yet. */
		pending?: boolean;
		isAuthor?: boolean;
		readOnly?: boolean;
		/** The caller's pending-placeholder decision (`shouldShowPendingPlaceholder`). */
		showPlaceholder?: boolean;
		/** Identity the scroll controller re-initializes on — a conversation id,
		 * or any stable key for a non-conversation surface. */
		conversationKey?: string;
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
		onshowAlternateMsg?: (payload: { id: Message["id"] }) => void;
		/** Pluggable approval-card answer path, threaded to ChatMessage (see it). */
		onanswerElicitation?: (
			request: ElicitationRequestPayload,
			action: ElicitationAction,
			scope?: "always"
		) => Promise<{ ok: boolean; error?: string }>;
		/**
		 * The coding-agent panel's subagent claim and its card, threaded to
		 * ChatMessage (see them there): the claim supersedes a Task tool call's
		 * generic row with the panel's own subagent card. Absent on chat
		 * routes, where no transcript carries subagents.
		 */
		subagentFor?: (callId: string) => CodeSubagentAnchor | undefined;
		subagentCard?: Snippet<[CodeSubagentAnchor]>;
		/** Where the person's attachments are served from, threaded to ChatMessage (see it). */
		fileBaseUrl?: string;
		/** Extra per-message actions in the assistant footer, threaded to ChatMessage (see it). */
		messageActions?: Snippet<[Message]>;
		/** The visibility rule for those actions, threaded to ChatMessage (see it). */
		messageActionsWhen?: (message: Message) => boolean;
		/** Elicitation/question channel id, threaded to ChatMessage (see it). */
		conversationId?: string;
		/** Absolutely positioned chrome inside the column (header buttons, toasts). */
		overlay?: Snippet;
		/** Rendered at the top of the container, above whatever the messages branch shows. */
		head?: Snippet;
		/** The empty-conversation state, when there is nothing to render yet. */
		introduction?: Snippet;
		/** Rendered after the turns, inside the message column (e.g. a read-only notice). */
		tail?: Snippet;
		/** The composer overlay's content; the column owns the overlay wrapper. */
		composer: Snippet;
	}

	let {
		messages,
		messagesAlternatives = [],
		loading = false,
		pending = false,
		isAuthor = true,
		readOnly = false,
		showPlaceholder = false,
		conversationKey = undefined,
		onretry,
		onshowAlternateMsg,
		onanswerElicitation,
		subagentFor,
		subagentCard,
		fileBaseUrl,
		messageActions,
		messageActionsWhen,
		conversationId,
		overlay,
		head,
		introduction,
		tail,
		composer,
	}: Props = $props();

	const chatScroll = createChatScroll();
	let messagesEl: HTMLElement | undefined = $state();
	let pendingEl: HTMLElement | undefined = $state();
	let composerHeight = $state<number | undefined>(undefined);
	// Owned here: the edit affordance is per-message UI and no caller reads it.
	let editMsdgId: Message["id"] | null = $state(null);

	/** For callers that must land the view with their own send (the send is
	 * the request to see the exchange). */
	export function notifySend() {
		chatScroll.notifySend();
	}

	export function notifyBranchSwitch() {
		chatScroll.notifyBranchSwitch();
	}

	// Turn grouping: a user message starts a turn, following assistant messages
	// join it (plus a headless leading turn for edge shapes). Each turn renders
	// as one group so the anchored turn's reservation is a single CSS
	// min-height. Reads only
	// ids/from, so token flushes never regroup.
	let turns = $derived.by(() => {
		const groups: { key: string; messages: Message[] }[] = [];
		for (const message of messages) {
			const last = groups.at(-1);
			if (message.from === "user" || !last) {
				groups.push({ key: message.id, messages: [message] });
			} else {
				last.messages.push(message);
			}
		}
		return groups;
	});

	// Structural sync: conversation identity, the trailing turn, and which turn
	// (if any) a reply is currently streaming into — the whole condition for a
	// turn to anchor. Reads ids/from/loading only (terminal-ness untracked), so
	// token flushes never re-run it. The terminal check keeps the pre-mount gap
	// after a submit — when the trailing message is still the previous, settled
	// reply — from anchoring that turn.
	$effect(() => {
		const lastMessage = messages.at(-1);
		const lastTurnKey = turns.at(-1)?.key ?? null;
		const streaming =
			loading &&
			lastMessage?.from === "assistant" &&
			untrack(() => !isAssistantGenerationTerminal(lastMessage));
		chatScroll.sync({
			conversationKey,
			turnCount: turns.length,
			lastTurnKey,
			streamingTurnKey: streaming ? lastTurnKey : null,
			// Untracked like the terminal check: read once at the streaming flip,
			// never per token. A park resuming (wait elapsed, question answered)
			// re-enters streaming on a message that already carries work — a
			// continuation, not a new reply, so the carry-to-anchor must not
			// re-run. A fresh reply's message is still empty at the flip.
			resumedStream: Boolean(
				streaming &&
				lastMessage &&
				untrack(() => lastMessage.content.length > 0 || (lastMessage.updates?.length ?? 0) > 0)
			),
		});
	});

	// The growing content element mounts after the container when a
	// conversation gains its first messages (or the pending placeholder
	// renders before any message exists) — re-point the size observer.
	$effect(() => {
		void messagesEl;
		void pendingEl;
		chatScroll.notifyContentChanged();
	});

	$effect(() => {
		chatScroll.setComposerHeight(composerHeight);
	});
</script>

<!-- pointer-events-none: the chat column sits at z-[-1]; this wrapper's
     hit-area would otherwise swallow every click meant for it. Children
     re-enable pointer events themselves. -->
<div
	class="pointer-events-auto relative z-[-1] min-h-0 min-w-0 flex-1"
	style="--scrollbar-gutter: {chatScroll.gutterHalfPx}px"
>
	{@render overlay?.()}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- tabindex: the document never scrolls in this app, so without it
	     keyboard-only users cannot scroll the conversation at all. Keyboard
	     focus draws a soft inset ring instead of the browser's default
	     outline around the whole pane; mouse focus draws nothing. -->
	<div
		class="scrollbar-custom h-full [scrollbar-gutter:stable_both-edges] overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-500/60 dark:focus-visible:outline-blue-400/60"
		tabindex="0"
		aria-label="Conversation messages"
		use:chatScroll.attach={{
			content: () => messagesEl ?? pendingEl,
			ignoreTouchZonePx: NAV_EDGE_SWIPE_ZONE_PX,
		}}
	>
		<!-- @container: descendants (e.g. the per-message router-metadata row) adapt
		     to the actual column width, which shrinks when the artifact panel is open -->
		<div
			class="@container mx-auto flex h-full max-w-3xl flex-col gap-6 px-3 pt-6 sm:gap-8 sm:px-5 xl:max-w-4xl xl:pt-10"
		>
			{@render head?.()}
			{#if messages.length > 0}
				<!-- padding-bottom is the composer clearance (content never hides
				     behind the composer overlay); the SSR-rendered value equals the
				     historical clearance. The anchored turn's min-height is the
				     reservation its reply streams into — space the turn owns from
				     the start, so filling it moves nothing. -->
				<div
					bind:this={messagesEl}
					class="flex h-max flex-col gap-8"
					style:padding-bottom="{chatScroll.bottomClearancePx}px"
				>
					<!-- Turn groups are identified by position, not key: the post-stream
					     reconciliation re-keys every message, and re-created group
					     elements would give Safari an in-between layout to clamp the
					     view against (it clamps synchronously mid-DOM-swap). Messages
					     inside stay keyed by id; the group's reservation binds to the
					     anchored INDEX for the same reason. -->
					{#each turns as turn, turnIdx}
						<div
							class="flex flex-col gap-8"
							style:min-height={turnIdx === chatScroll.anchoredTurnIndex
								? `${chatScroll.anchorMinHeightPx}px`
								: null}
						>
							{#each turn.messages as message, msgIdx (message.id)}
								<ChatMessage
									{loading}
									{message}
									alternatives={messagesAlternatives.find((a) => a.includes(message.id)) ?? []}
									{isAuthor}
									{readOnly}
									isLast={turnIdx === turns.length - 1 && msgIdx === turn.messages.length - 1}
									bind:editMsdgId
									{onanswerElicitation}
									{subagentFor}
									{subagentCard}
									{fileBaseUrl}
									{messageActions}
									{messageActionsWhen}
									{conversationId}
									onretry={onretry
										? (payload) => {
												// Edit-with-content mounts a fresh turn like a send; a
												// plain regenerate needs nothing — the reservation
												// absorbs the old reply's collapse either way.
												if (payload.content !== undefined) chatScroll.notifySend();
												onretry?.(payload);
											}
										: undefined}
									onshowAlternateMsg={(payload) => {
										chatScroll.notifyBranchSwitch();
										onshowAlternateMsg?.(payload);
									}}
								/>
							{/each}
							{#if turnIdx === turns.length - 1 && showPlaceholder}
								<ChatMessage
									loading={true}
									message={{
										id: "pending-placeholder",
										content: "",
										from: "assistant",
										children: [],
									}}
									{isAuthor}
									{readOnly}
								/>
							{/if}
						</div>
					{/each}
					{@render tail?.()}
				</div>
			{:else if pending}
				<!-- Outside messagesEl, so it gets its own wrapper for the scroll
				     controller's size observer (an h-full column never resizes). -->
				<div bind:this={pendingEl} class="flex h-max flex-col">
					<ChatMessage
						loading={true}
						message={{
							id: "0-0-0-0-0",
							content: "",
							from: "assistant",
							children: [],
						}}
						{isAuthor}
						{readOnly}
					/>
				</div>
			{:else}
				{@render introduction?.()}
			{/if}
		</div>

		<ScrollToPreviousBtn
			class="fixed right-4 bottom-48 lg:right-10"
			visible={chatScroll.showJumpToPrevious}
			onclick={() => chatScroll.scrollToPreviousMessage()}
		/>

		<ScrollToBottomBtn
			class="fixed right-4 bottom-36 lg:right-10"
			visible={chatScroll.showJumpToBottom}
			onclick={() => chatScroll.scrollToBottom()}
		/>
	</div>

	<!-- --scrollbar-gutter (measured by chatScroll) keeps the composer text
	     aligned with the message column, whose content box is narrowed by
	     the scroller's scrollbar-gutter on classic-scrollbar platforms. -->
	<div
		bind:clientHeight={composerHeight}
		class="pointer-events-none absolute inset-x-0 bottom-0 z-0 mx-auto flex w-full
		max-w-3xl flex-col items-center justify-center bg-linear-to-t from-white
		via-white to-white/0 px-[calc(0.875rem+var(--scrollbar-gutter,0px))] pt-2 *:pointer-events-auto
		max-sm:py-0 sm:px-[calc(1.25rem+var(--scrollbar-gutter,0px))]
		md:pb-4 xl:max-w-4xl dark:border-gray-800 dark:from-gray-900 dark:via-gray-900 dark:to-gray-900/0"
	>
		{@render composer()}
	</div>
</div>
