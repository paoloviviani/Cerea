<!--
	The step rows of a plan: a status glyph and the step text, styled by
	status. Shared by the chat's plan card (one per turn) and the /code Tasks
	pane (the session's current list), so the two never drift apart.
-->
<script lang="ts">
	import type { PlanStep, PlanStepStatus } from "$lib/types/Plan";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonInProgress from "~icons/carbon/in-progress";
	import CarbonRadioButton from "~icons/carbon/radio-button";
	import CarbonSubtract from "~icons/carbon/subtract";

	interface Props {
		steps: PlanStep[];
	}

	let { steps }: Props = $props();

	const stepTextClasses: Record<PlanStepStatus, string> = {
		pending: "text-gray-600 dark:text-gray-300",
		in_progress: "font-medium text-gray-700 dark:text-gray-200",
		completed: "text-gray-400 dark:text-gray-500",
		skipped: "text-gray-400 line-through dark:text-gray-500",
	};
</script>

<ol class="flex w-full list-none flex-col gap-1">
	{#each steps as step, i (i)}
		<li
			data-status={step.status}
			class="flex min-w-0 items-start gap-1.5 text-sm {stepTextClasses[step.status]}"
		>
			<span class="mt-1 shrink-0" aria-hidden="true">
				{#if step.status === "completed"}
					<CarbonCheckmark class="size-3.5 text-green-600 dark:text-green-500" />
				{:else if step.status === "in_progress"}
					<CarbonInProgress class="size-3.5 text-orange-600 dark:text-orange-400" />
				{:else if step.status === "skipped"}
					<CarbonSubtract class="size-3.5 text-gray-300 dark:text-gray-600" />
				{:else}
					<CarbonRadioButton class="size-3.5 text-gray-300 dark:text-gray-600" />
				{/if}
			</span>
			<span class="min-w-0 break-words">{step.step}</span>
			{#if step.priority === "high"}
				<span
					class="mt-0.5 shrink-0 rounded-sm bg-red-100 px-1 text-[10px] font-medium text-red-700 uppercase dark:bg-red-900/40 dark:text-red-300"
					data-testid="priority-high">high</span
				>
			{/if}
		</li>
	{/each}
</ol>
