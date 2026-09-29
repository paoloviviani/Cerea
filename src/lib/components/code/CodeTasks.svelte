<!--
	The session's current task list, as a side-pane view beside Changes,
	Files and Terminal. Display only: the list is the agent's own (its todo
	tool), read from the timeline by the caller and handed in.
-->
<script lang="ts">
	import type { MessagePlanUpdate } from "$lib/types/MessageUpdate";
	import { TASKS_COMPLETED_FOLD_ABOVE, planProgress } from "$lib/utils/codeTasks";
	import PlanSteps from "$lib/components/chat/PlanSteps.svelte";
	import IconChevronRight from "~icons/carbon/chevron-right";

	interface Props {
		plan: MessagePlanUpdate | null;
	}

	let { plan }: Props = $props();

	const progress = $derived(planProgress(plan));
	const open = $derived((plan?.steps ?? []).filter((step) => step.status !== "completed"));
	const completed = $derived((plan?.steps ?? []).filter((step) => step.status === "completed"));

	// Folded by default once the list is long; the person's own click wins.
	let completedOpenChoice = $state<boolean | null>(null);
	const completedOpen = $derived(
		completedOpenChoice ?? progress.total <= TASKS_COMPLETED_FOLD_ABOVE
	);

	let list = $state<HTMLElement>();
	// Whatever is being worked on stays in view as the list moves along.
	$effect(() => {
		void plan;
		list?.querySelector('[data-status="in_progress"]')?.scrollIntoView({ block: "nearest" });
	});
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="code-tasks">
	<div class="border-b border-line px-4 py-3">
		{#if progress.total > 0}
			<span class="font-mono text-xs text-ink-muted" data-testid="tasks-count"
				>{progress.done}/{progress.total}</span
			>
		{/if}
		{#if progress.total > 0}
			<div
				class="mt-2 h-1 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
				role="progressbar"
				aria-label="Tasks completed"
				aria-valuemin={0}
				aria-valuemax={progress.total}
				aria-valuenow={progress.done}
			>
				<div
					class="h-full rounded-full bg-green-600 transition-[width] dark:bg-green-500"
					style:width="{(progress.done / progress.total) * 100}%"
				></div>
			</div>
		{/if}
	</div>

	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto px-4 py-3" bind:this={list}>
		{#if !plan || progress.total === 0}
			<p class="text-sm text-ink-muted" data-testid="tasks-empty">
				No task list yet — the agent makes one with its todo tool.
			</p>
		{:else}
			{#if open.length > 0}
				<PlanSteps steps={open} />
			{/if}
			{#if completed.length > 0}
				<div class={open.length > 0 ? "mt-4" : ""}>
					<button
						type="button"
						class="flex items-center gap-1 text-xs font-medium text-ink-muted hover:text-ink"
						aria-expanded={completedOpen}
						onclick={() => (completedOpenChoice = !completedOpen)}
					>
						<IconChevronRight
							class="size-3 transition-transform {completedOpen ? 'rotate-90' : ''}"
						/>
						Completed ({completed.length})
					</button>
					{#if completedOpen}
						<div class="mt-1.5"><PlanSteps steps={completed} /></div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>
