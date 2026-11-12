<!--
	One browsing task (`browse`, ADR 0116), as a card of its own: what it is doing, the steps it
	takes as they happen (the action, the page it ran on, a short outcome), a note when it waits for
	the user, and its report at the end. The approval itself is the approval card that follows this
	one in the stream; this card only says the task is waiting for it.

	The state comes from `MessageBrowseUpdate` (re-sent whole as it works, so the stored message
	holds one per call); the report or the failure is the call's own Tool result or error, passed
	in as `tool`. Both are plain props, so the card renders the same while streaming, in a finished
	message, after a reload and on the server. Open while it works, closed once it is done.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import type { MessageBrowseUpdate, MessageToolUpdate } from "$lib/types/MessageUpdate";
	import { isMessageToolErrorUpdate, isMessageToolResultUpdate } from "$lib/utils/messageUpdates";
	import { ToolResultStatus } from "$lib/types/Tool";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonClose from "~icons/carbon/close";
	import CarbonWarning from "~icons/carbon/warning";
	import LucideGlobe from "~icons/lucide/globe";
	import MarkdownRenderer from "./MarkdownRenderer.svelte";

	interface Props {
		update: MessageBrowseUpdate;
		/** The browse call's own updates (call, result, error). */
		tool?: MessageToolUpdate[];
		/** Whether the turn is still streaming. */
		loading?: boolean;
	}

	let { update, tool = [], loading = false }: Props = $props();

	let userOpen = $state<boolean | null>(null);

	const failure = $derived(tool.find(isMessageToolErrorUpdate)?.message);
	/** The call's result is the JSON the chat model reads: its `result` is the report. */
	const outcome = $derived.by(() => {
		for (const entry of tool) {
			if (isMessageToolResultUpdate(entry) && entry.result.status === ToolResultStatus.Success) {
				const text = entry.result.outputs
					.map((out) => (typeof out["text"] === "string" ? (out["text"] as string) : ""))
					.join("");
				try {
					const parsed = JSON.parse(text) as { result?: unknown };
					return { report: typeof parsed.result === "string" ? parsed.result : text };
				} catch {
					return { report: text };
				}
			}
		}
		return undefined;
	});

	// A card still "running" in a message nobody is streaming (the turn was cut off, or this is a
	// reload of one) is not working: it reads as stopped.
	const phase = $derived.by((): "working" | "waiting" | "done" | "failed" | "stopped" => {
		if (update.status === "waiting") return loading ? "waiting" : "stopped";
		if (update.status === "done" || outcome !== undefined) {
			return update.status === "stopped" ? "stopped" : "done";
		}
		if (update.status === "failed" || failure !== undefined) return "failed";
		if (update.status === "stopped") return "stopped";
		return loading ? "working" : "stopped";
	});

	const label = $derived(
		{
			working: m["chat.browse.phase.working"](),
			waiting: m["chat.browse.phase.waiting"](),
			done: m["chat.browse.phase.done"](),
			failed: m["chat.browse.phase.failed"](),
			stopped: m["chat.browse.phase.stopped"](),
		}[phase]
	);

	const open = $derived(userOpen ?? (phase === "working" || phase === "waiting"));
	const stopNote = $derived.by(() => {
		const reason = update.stoppedReason;
		if (!reason) return undefined;
		const notes: Record<string, string> = {
			max_steps: m["chat.browse.stopped.max_steps"](),
			max_tokens: m["chat.browse.stopped.max_tokens"](),
			max_time: m["chat.browse.stopped.max_time"](),
			aborted: m["chat.browse.stopped.aborted"](),
			runtime_error: m["chat.browse.stopped.runtime_error"](),
			model_error: m["chat.browse.stopped.model_error"](),
			denied: m["chat.browse.stopped.denied"](),
		};
		return notes[reason];
	});

	const plain = (text: string): string =>
		text
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/(\*\*|__|[*`])/g, "")
			.replace(/\s+/g, " ")
			.trim();
	const preview = $derived(plain(outcome?.report ?? failure ?? ""));
	const stepCount = $derived(update.steps.length);
</script>

<div
	class="my-1.5 flex w-full max-w-full min-w-0 min-w-[17rem] flex-col rounded-lg border border-gray-200 bg-white/60 sm:min-w-[28rem] dark:border-gray-700 dark:bg-gray-900/30"
	data-testid="browse-card"
	data-status={phase}
>
	<button
		type="button"
		class="group/header flex w-full min-w-0 cursor-pointer items-center gap-2 px-2.5 py-2 text-left select-none focus:outline-hidden"
		onclick={() => (userOpen = !open)}
		aria-expanded={open}
		aria-label={open
			? m["chat.browse.collapse"]({ goal: update.goal })
			: m["chat.browse.expand"]({ goal: update.goal })}
	>
		<LucideGlobe class="size-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
		<span
			class="min-w-0 truncate text-sm font-medium text-gray-700 dark:text-gray-200"
			data-testid="browse-title"
			title={update.goal}>{m["chat.browse.title"]()}: {update.goal}</span
		>
		<span class="ml-auto flex shrink-0 items-center gap-1 text-xs" data-testid="browse-status">
			{#if phase === "working"}
				<span class="router-shimmer text-gray-500 dark:text-gray-400">{label}</span>
			{:else if phase === "waiting"}
				<CarbonWarning class="size-3.5 text-amber-500 dark:text-amber-400" />
				<span class="text-amber-700 dark:text-amber-300">{label}</span>
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
			class="size-3.5 shrink-0 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {open
				? 'rotate-90 text-gray-600 dark:text-gray-300'
				: 'text-gray-400'}"
		/>
	</button>

	{#if phase === "waiting" && update.waitingOn}
		<div class="px-2.5 pb-2">
			<p
				class="text-xs break-words text-amber-700 dark:text-amber-300"
				data-testid="browse-waiting"
			>
				{m["chat.browse.waiting"]({ sentence: update.waitingOn })}
			</p>
		</div>
	{:else if phase === "working" && update.activity && !open}
		<div class="px-2.5 pb-2">
			<p class="truncate text-xs text-gray-500 dark:text-gray-400" data-testid="browse-activity">
				{update.activity}
			</p>
		</div>
	{:else if !open && preview}
		<div class="px-2.5 pb-2">
			<p
				class="line-clamp-2 text-xs break-words {failure !== undefined && outcome === undefined
					? 'text-amber-700 dark:text-amber-300'
					: 'text-gray-500 dark:text-gray-400'}"
				data-testid="browse-preview"
			>
				{preview}
			</p>
		</div>
	{/if}

	{#if open}
		<div class="flex flex-col gap-2 border-t border-gray-200 px-2.5 py-2 dark:border-gray-700">
			{#if stepCount > 0}
				<div class="flex flex-col gap-1">
					<span class="text-xs text-gray-500 dark:text-gray-400" data-testid="browse-step-count">
						{m["chat.browse.steps"]({ count: stepCount })}
					</span>
					<ol class="flex list-none flex-col gap-0.5" data-testid="browse-steps">
						{#each update.steps as step (step.id)}
							<li
								class="flex min-w-0 items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300"
								data-state={step.state}
							>
								<span class="mt-px w-3 shrink-0 text-center" aria-hidden="true">
									{#if step.state === "ok"}
										<CarbonCheckmark class="size-3 text-green-600 dark:text-green-500" />
									{:else if step.state === "running"}
										<span class="text-gray-400">…</span>
									{:else if step.state === "error"}
										<CarbonWarning class="size-3 text-amber-500 dark:text-amber-400" />
									{:else}
										<CarbonClose class="size-3 text-amber-500 dark:text-amber-400" />
									{/if}
								</span>
								<span class="min-w-0 break-words">
									<span data-testid="browse-step-action">{step.action}</span>
									{#if step.page}
										<span class="text-gray-400 dark:text-gray-500"> · {step.page}</span>
									{/if}
									{#if step.state === "ok" && step.note}
										<span class="text-gray-400 dark:text-gray-500"> · {step.note}</span>
									{:else if step.state === "denied"}
										<span class="text-gray-400 dark:text-gray-500">
											· {m["chat.browse.step.denied"]()}</span
										>
									{:else if step.state === "refused"}
										<span class="text-gray-400 dark:text-gray-500">
											· {m["chat.browse.step.refused"]()}</span
										>
									{:else if step.state === "error"}
										<span class="text-gray-400 dark:text-gray-500">
											· {m["chat.browse.step.failed"]()}</span
										>
									{/if}
								</span>
							</li>
						{/each}
					</ol>
				</div>
			{:else if phase === "working"}
				<p class="text-xs text-gray-500 dark:text-gray-400">{m["chat.browse.no_steps"]()}</p>
			{/if}

			{#if outcome !== undefined && outcome.report.length > 0}
				<div class="flex flex-col gap-1">
					<span class="text-xs text-gray-500 dark:text-gray-400">{m["chat.browse.result"]()}</span>
					<div
						class="prose prose-sm max-w-none text-sm dark:prose-invert prose-pre:bg-gray-800 dark:prose-pre:bg-gray-900"
						data-testid="browse-result"
					>
						<MarkdownRenderer content={outcome.report} />
					</div>
				</div>
			{:else if failure !== undefined}
				<pre
					class="rounded-lg bg-amber-50 p-2 font-mono text-xs break-words whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
					data-testid="browse-failure">{failure}</pre>
			{/if}

			{#if stopNote}
				<p class="text-xs text-amber-700 dark:text-amber-300" data-testid="browse-stop-note">
					{stopNote}
				</p>
			{/if}
			{#if update.finalUrl && phase !== "working" && phase !== "waiting"}
				<p
					class="min-w-0 truncate text-xs text-gray-400 dark:text-gray-500"
					data-testid="browse-final-url"
					title={update.finalUrl}
				>
					{m["chat.browse.ended_on"]({ url: update.finalUrl })}
				</p>
			{/if}
		</div>
	{/if}
</div>
