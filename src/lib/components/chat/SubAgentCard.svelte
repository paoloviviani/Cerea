<!--
	One sub-agent (`delegate` or the `research` preset), as a card of its own:
	title, model, a live status line while it works, its answer, and the list of
	steps it took. Never folded into the "Called N tools" summary: what a
	sub-agent found is the content of the turn, not a detail of it.

	The state comes from `MessageSubAgentUpdate` (re-sent whole as it works, so
	the stored message holds one per sub-agent); the answer or the failure is the
	delegate call's own Tool result or error, passed in as `tool`. Both are plain
	props, so the card renders the same while streaming, in a finished message,
	after a reload and on the server.
-->
<script lang="ts">
	import type { MessageSubAgentUpdate, MessageToolUpdate } from "$lib/types/MessageUpdate";
	import { isMessageToolErrorUpdate, isMessageToolResultUpdate } from "$lib/utils/messageUpdates";
	import { ToolResultStatus } from "$lib/types/Tool";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonClose from "~icons/carbon/close";
	import CarbonWarning from "~icons/carbon/warning";
	import LucideBot from "~icons/lucide/bot";
	import LucideSearch from "~icons/lucide/search";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	interface Props {
		update: MessageSubAgentUpdate;
		/** The delegate call's own updates (call, result, error). */
		tool?: MessageToolUpdate[];
		/** Whether the turn is still streaming. */
		loading?: boolean;
	}

	let { update, tool = [], loading = false }: Props = $props();

	let isOpen = $state(false);
	let stepsOpen = $state(false);

	const failure = $derived(tool.find(isMessageToolErrorUpdate)?.message);
	const answer = $derived.by(() => {
		for (const entry of tool) {
			if (isMessageToolResultUpdate(entry) && entry.result.status === ToolResultStatus.Success) {
				return entry.result.outputs
					.map((out) => (typeof out["text"] === "string" ? (out["text"] as string) : ""))
					.join("");
			}
		}
		return undefined;
	});

	// A card still "running" in a message nobody is streaming (the turn was cut
	// off, or this is a reload of one) is not working: it reads as stopped.
	const phase = $derived.by((): "working" | "done" | "failed" | "stopped" => {
		if (answer !== undefined || update.status === "done") return "done";
		if (failure !== undefined && update.status !== "stopped") return "failed";
		if (update.status === "failed") return "failed";
		if (update.status === "stopped") return "stopped";
		return loading ? "working" : "stopped";
	});

	const label = $derived(
		{ working: "Working", done: "Done", failed: "Failed", stopped: "Stopped" }[phase]
	);
	// The closed card's one-line taste of the answer: markdown marks off, so it
	// reads as prose. The open card renders the real thing.
	const plain = (text: string): string =>
		text
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
			.replace(/^\s*#{1,6}\s+/gm, "")
			.replace(/(\*\*|__|[*`])/g, "")
			.replace(/\s+/g, " ")
			.trim();
	const preview = $derived(plain(answer ?? failure ?? ""));
	const stepCount = $derived(update.steps.length);
</script>

<div
	class="my-1.5 flex w-full max-w-full min-w-0 min-w-[17rem] flex-col rounded-lg border border-gray-200 bg-white/60 sm:min-w-[28rem] dark:border-gray-700 dark:bg-gray-900/30"
	data-testid="subagent-card"
	data-status={phase}
>
	<button
		type="button"
		class="group/header flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-2 text-left select-none focus:outline-hidden"
		onclick={() => (isOpen = !isOpen)}
		aria-expanded={isOpen}
		aria-label={isOpen ? `Collapse ${update.title}` : `Expand ${update.title}`}
	>
		{#if update.preset === "research"}
			<LucideSearch class="size-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
		{:else}
			<LucideBot class="size-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
		{/if}
		<span
			class="min-w-0 truncate text-sm font-medium text-gray-700 dark:text-gray-200"
			data-testid="subagent-title">{update.title}</span
		>
		<span
			class="hidden shrink-0 rounded-sm bg-gray-100 px-1 py-px font-mono text-xs text-gray-500 sm:inline dark:bg-gray-800 dark:text-gray-400"
			data-testid="subagent-model">{update.model}</span
		>
		<span class="ml-auto flex shrink-0 items-center gap-1 text-xs" data-testid="subagent-status">
			{#if phase === "working"}
				<span class="router-shimmer text-gray-500 dark:text-gray-400">{label}</span>
			{:else if phase === "done"}
				<CarbonCheckmark class="size-3.5 text-green-600 dark:text-green-500" />
				<span class="text-gray-500 dark:text-gray-400">{label}</span>
			{:else if phase === "failed"}
				<CarbonWarning class="size-3.5 text-amber-500 dark:text-amber-400" />
				<span class="text-gray-500 dark:text-gray-400">{label}</span>
			{:else}
				<CarbonClose class="size-3.5 text-gray-400 dark:text-gray-500" />
				<span class="text-gray-500 dark:text-gray-400">{label}</span>
			{/if}
		</span>
		<CarbonChevronRight
			class="size-3.5 shrink-0 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {isOpen
				? 'rotate-90 text-gray-600 dark:text-gray-300'
				: 'text-gray-400'}"
		/>
	</button>

	{#if phase === "working" && update.activity}
		<div class="px-2.5 pb-2">
			<p class="truncate text-xs text-gray-500 dark:text-gray-400" data-testid="subagent-activity">
				{update.activity}
			</p>
		</div>
	{:else if !isOpen && preview}
		<!-- The padding sits on the wrapper: on the clamped line itself it would
		     show the start of a third line under the clamp. -->
		<div class="px-2.5 pb-2">
			<p
				class="line-clamp-2 text-xs break-words {failure !== undefined && answer === undefined
					? 'text-amber-700 dark:text-amber-300'
					: 'text-gray-500 dark:text-gray-400'}"
				data-testid="subagent-preview"
			>
				{preview}
			</p>
		</div>
	{/if}

	{#if isOpen}
		<div class="flex flex-col gap-2 border-t border-gray-200 px-2.5 py-2 dark:border-gray-700">
			<span class="font-mono text-xs text-gray-500 sm:hidden dark:text-gray-400"
				>{update.model}</span
			>
			{#if answer !== undefined && answer.length > 0}
				<div
					class="prose prose-sm max-w-none text-sm dark:prose-invert prose-pre:bg-gray-800 dark:prose-pre:bg-gray-900"
					data-testid="subagent-result"
				>
					<MarkdownRenderer content={answer} />
				</div>
			{:else if failure !== undefined}
				<pre
					class="rounded-lg bg-amber-50 p-2 font-mono text-xs break-words whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
					data-testid="subagent-failure">{failure}</pre>
			{:else if phase === "working"}
				<p class="text-xs text-gray-500 dark:text-gray-400">No answer yet.</p>
			{/if}

			{#if stepCount > 0}
				<div class="flex flex-col gap-1">
					<button
						type="button"
						class="flex w-fit cursor-pointer items-center gap-1 text-xs text-gray-500 select-none hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
						onclick={() => (stepsOpen = !stepsOpen)}
						aria-expanded={stepsOpen}
						data-testid="subagent-steps-toggle"
					>
						<CarbonChevronRight
							class="size-3 transition-transform duration-200 {stepsOpen ? 'rotate-90' : ''}"
						/>
						{stepCount}
						{stepCount === 1 ? "step" : "steps"}
					</button>
					{#if stepsOpen}
						<ol class="flex list-none flex-col gap-0.5" data-testid="subagent-steps">
							{#each update.steps as step, i (i)}
								<li
									class="flex min-w-0 items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300"
									data-outcome={step.outcome}
								>
									<span class="mt-px w-3 shrink-0 text-center" aria-hidden="true">
										{#if step.outcome === "ok"}
											<CarbonCheckmark class="size-3 text-green-600 dark:text-green-500" />
										{:else if step.outcome === "running"}
											<span class="text-gray-400">…</span>
										{:else if step.outcome === "refused"}
											<CarbonClose class="size-3 text-amber-500 dark:text-amber-400" />
										{:else}
											<CarbonWarning class="size-3 text-amber-500 dark:text-amber-400" />
										{/if}
									</span>
									<span class="min-w-0 break-words">{step.label}</span>
									{#if step.outcome === "refused"}
										<span class="shrink-0 text-gray-400 dark:text-gray-500">refused</span>
									{:else if step.outcome === "error"}
										<span class="shrink-0 text-gray-400 dark:text-gray-500">failed</span>
									{/if}
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>
