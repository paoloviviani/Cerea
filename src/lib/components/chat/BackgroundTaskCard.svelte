<!--
	A background subagent's lifecycle marker, shown where its task call ran.

	opencode 1.18.32 (behind OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) lets
	the task tool return immediately while the child keeps working after its
	parent turn ends; the finished child's result is injected back as a
	synthetic `<task>` message. Both halves fold into this one marker —
	running, then completed or failed — never as model text. The marker says
	what opencode reported and nothing more: `followUp` means the call
	resumed that child with `task_id` rather than spawning it, and
	`automatic` means the frame came from opencode's own synthetic injection
	rather than a model-authored tool result.

	Drawn in the transcript's own idiom (the muted inline row `PlanCard`
	uses), not the workspace card language: this is a line in a conversation,
	not a panel.
-->
<script lang="ts">
	import type { MessageBackgroundTaskUpdate } from "$lib/types/MessageUpdate";
	import LucideUsers from "~icons/lucide/users";
	import CarbonChevronRight from "~icons/carbon/chevron-right";

	interface Props {
		update: MessageBackgroundTaskUpdate;
	}

	let { update }: Props = $props();

	let open = $state(false);

	const STATE_LABEL: Record<MessageBackgroundTaskUpdate["state"], string> = {
		running: "Running in the background",
		completed: "Background task finished",
		error: "Background task failed",
	};

	const DOT_TONES: Record<MessageBackgroundTaskUpdate["state"], string> = {
		running: "bg-blue-500 animate-pulse",
		error: "bg-red-500",
		completed: "bg-green-500",
	};

	let label = $derived(STATE_LABEL[update.state]);
	let canExpand = $derived(Boolean(update.text?.trim()));
</script>

<div class="flex max-w-full min-w-0 flex-col items-stretch" data-testid="background-task-marker">
	<div class="flex max-w-full min-w-0 items-center gap-1.5 text-sm">
		<LucideUsers class="size-3.5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true" />
		<span class="shrink-0 font-medium text-gray-600 dark:text-gray-300">{label}</span>
		<span
			class="size-2 shrink-0 rounded-full {DOT_TONES[update.state]}"
			title={update.state}
			aria-label={update.state}
		>
		</span>
		{#if update.summary}
			<span class="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400" title={update.summary}>
				{update.summary}
			</span>
		{/if}
		{#if update.followUp}
			<span
				class="shrink-0 rounded-full bg-gray-100 px-1.5 py-px text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
				title="This call resumed the running child (task_id) rather than spawning a new one."
			>
				follow-up
			</span>
		{/if}
		{#if update.automatic}
			<span
				class="shrink-0 rounded-full bg-gray-100 px-1.5 py-px text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
				title="Reported automatically when the child finished — not written by the model."
			>
				automatic
			</span>
		{/if}
		{#if canExpand}
			<button
				type="button"
				class="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 py-px text-xs text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
				onclick={() => (open = !open)}
				aria-expanded={open}
				aria-label={open ? "Hide the reported result" : "Show the reported result"}
			>
				<CarbonChevronRight
					class="size-3.5 shrink-0 transition-transform duration-200 {open ? 'rotate-90' : ''}"
				/>
				{open ? "Hide result" : "Show result"}
			</button>
		{/if}
	</div>
	{#if open && canExpand}
		<p
			class="mt-1 ml-4 max-h-40 min-w-0 overflow-y-auto border-l border-gray-200 pl-3 text-xs break-words whitespace-pre-wrap text-gray-500 dark:border-gray-700 dark:text-gray-400"
		>
			{update.text}
		</p>
	{/if}
</div>
