<!--
	One subagent of the coding agent, in the transcript.

	The panel polls the daemon's subagent roster on turn boundaries and pairs
	each subagent with the Task tool call that spawned it (`toolCallId`); this
	card renders at that anchor in place of the generic tool row — the same
	give-way idiom PlanCard and MemoryCard use. The roster is the authority for
	title, status and subtitle; while a call runs unpaired (the poll has not
	named it yet) the card shows the call's own description as the title and
	reads as running.

	Expanding fetches the subagent's own timeline once through the forwarder,
	folds it with the same consumer the parent transcript uses, and renders it
	through the chat's message components — a nested read-only conversation.
	The fetch is deliberately not polled: the transcript refreshes on the next
	expand after the subagent's row reports a change, and the roster's
	`updatedAt` decides whether a re-expand refetches.
-->
<script lang="ts">
	import { tick } from "svelte";
	import type {
		AgentStreamUpdate,
		CodeSubagentAnchor,
		CodeSubagentStatus,
	} from "$lib/types/CodeAgent";
	import type { Message } from "$lib/types/Message";
	import { consumeAgentUpdates } from "$lib/utils/consumeAgentUpdates";
	import ChatMessage from "$lib/components/chat/ChatMessage.svelte";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import LucideUsers from "~icons/lucide/users";

	interface Props {
		anchor: CodeSubagentAnchor;
	}

	let { anchor }: Props = $props();

	let open = $state(false);
	let working = $state(false);
	let failure = $state<string | null>(null);
	/** The folded transcript, and the roster row it was fetched for. */
	let transcript = $state<Message[] | null>(null);
	let fetchedFor: { id: string; updatedAt: string } | null = null;

	let subagent = $derived(anchor.subagent);
	let title = $derived(anchor.subagent?.title || anchor.fallbackTitle || "Subagent");
	let status = $derived<CodeSubagentStatus>(anchor.subagent?.status ?? "running");
	let subtitle = $derived(anchor.subagent?.subtitle ?? "");
	let expandable = $derived(Boolean(anchor.load));

	const DOT_TONES: Record<CodeSubagentStatus, string> = {
		running: "bg-blue-500 animate-pulse",
		completed: "bg-green-500",
		failed: "bg-red-500",
		canceled: "bg-gray-400",
	};

	/** The fold wants an async iterator; a fetched list replays as one. */
	async function* replay(updates: AgentStreamUpdate[]) {
		for (const update of updates) yield update;
	}

	async function toggle() {
		open = !open;
		if (!open) return;
		const current = anchor.subagent;
		if (!current || !anchor.load) return;
		// A row the roster has since touched refetches; a settled one serves
		// its cache, so reopening a finished subagent is free.
		if (transcript && fetchedFor?.id === current.id && fetchedFor.updatedAt === current.updatedAt) {
			return;
		}
		working = true;
		failure = null;
		try {
			const updates = await anchor.load();
			const folded: Message[] = [];
			await consumeAgentUpdates(replay(updates), folded, {
				isAborted: () => false,
				onAbort: () => {},
				onTurnEvent: () => {},
			});
			transcript = folded;
			fetchedFor = { id: current.id, updatedAt: current.updatedAt };
			await tick();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load the subagent's transcript.";
		} finally {
			working = false;
		}
	}
</script>

<div class="flex max-w-full min-w-0 flex-col items-stretch">
	<button
		type="button"
		class="group/header flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 text-left whitespace-nowrap select-none focus:outline-hidden"
		onclick={toggle}
		aria-expanded={open}
		aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
	>
		<LucideUsers
			class="size-3.5 shrink-0 text-gray-400 transition-colors group-hover/header:text-gray-600 dark:text-gray-500 dark:group-hover/header:text-gray-300"
		/>
		<span
			class="min-w-0 shrink truncate text-sm font-medium transition-colors group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {open
				? 'text-gray-600 dark:text-gray-300'
				: 'text-gray-500 dark:text-gray-400'}"
			{title}
		>
			{title}
		</span>
		<span
			class="size-2 shrink-0 rounded-full {DOT_TONES[status]}"
			title={status}
			aria-label={status}
		>
		</span>
		{#if subtitle}
			<span class="min-w-0 flex-1 truncate text-xs text-gray-400 dark:text-gray-500">
				{subtitle}
			</span>
		{/if}
		{#if expandable}
			<CarbonChevronRight
				class="size-3.5 shrink-0 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {open
					? 'rotate-90 text-gray-600 dark:text-gray-300'
					: 'text-gray-400'}"
			/>
		{/if}
	</button>

	{#if open}
		<div class="mt-1.5 ml-4 min-w-0 border-l border-gray-200 pl-3 dark:border-gray-700">
			{#if working && !transcript}
				<p class="py-1 text-xs text-gray-400 dark:text-gray-500">Loading the transcript…</p>
			{:else if failure}
				<p class="py-1 text-xs text-red-600 dark:text-red-400">{failure}</p>
			{:else if transcript && transcript.length > 0}
				<div
					class="scrollbar-custom flex max-h-80 min-w-0 flex-col gap-3 overflow-y-auto rounded-lg bg-gray-50 p-2 dark:bg-gray-800/40"
				>
					{#each transcript as message, i (message.id)}
						<ChatMessage {message} readOnly isLast={i === transcript.length - 1} />
					{/each}
				</div>
			{:else}
				<p class="py-1 text-xs text-gray-400 dark:text-gray-500">No transcript recorded yet.</p>
			{/if}
		</div>
	{/if}
</div>
