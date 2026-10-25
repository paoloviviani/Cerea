<!--
	One schedule's history: a row per occurrence the scheduler considered, fired
	or not — the same rows that are the audit record. Newest first, each with
	its status, why, and a link to the session a run reached.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import IconTime from "~icons/carbon/time";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import { listScheduleRuns, type ScheduleRunView, type ScheduleView } from "$lib/codeApi";
	import {
		formatWhenLong,
		recurrenceText,
		RUN_STATUS_LABEL,
		RUN_STATUS_TONE,
	} from "$lib/utils/scheduleFormat";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		scheduleId: string;
		onback: () => void;
	}

	let { scheduleId, onback }: Props = $props();

	let schedule = $state<ScheduleView | null>(null);
	let runs = $state<ScheduleRunView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	async function load() {
		try {
			const answer = await listScheduleRuns(scheduleId);
			schedule = answer.schedule;
			runs = answer.runs;
			failure = null;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load the history.";
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => void load(), 10_000);
		return () => clearInterval(timer);
	});

	function sessionHref(run: ScheduleRunView): string | null {
		const ids = run.result?.ids;
		if (run.result?.type !== "agent-session" || !ids?.deviceId || !ids.sessionId) return null;
		return `${base}/code?device=${ids.deviceId}&ws=${ids.workspaceId}&agent=${ids.sessionId}`;
	}
</script>

<div class="pointer-events-auto scrollbar-custom min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
	<div class={s.EMBEDDED} data-testid="schedule-history">
		<div class="p-4 sm:p-6">
			<button
				type="button"
				class="mb-4 flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink"
				onclick={onback}
			>
				<IconArrowLeft class="size-3.5" /> All schedules
			</button>
			<div class={s.HEADER}>
				<h2 class="{s.TITLE} break-words">{schedule?.name ?? "History"}</h2>
				{#if schedule}
					<p class="{s.SUBTITLE} break-words">
						{schedule.targetLabel} · {recurrenceText(schedule.recurrence)} ({schedule.timezone})
					</p>
				{/if}
			</div>

			{#if failure}
				<div class={s.ERROR} role="alert">{failure}</div>
			{:else if loading}
				<p class="text-sm text-ink-muted">Loading…</p>
			{:else if runs.length === 0}
				<div class={s.EMPTY}>
					<IconTime class={s.EMPTY_ICON} />
					<p class={s.EMPTY_TITLE}>No runs yet</p>
					<p class={s.EMPTY_DETAIL}>
						Every occurrence is listed here, including the ones that did not fire and why.
					</p>
				</div>
			{:else}
				<h3 class={s.SECTION_TITLE}>{runs.length} {runs.length === 1 ? "run" : "runs"}</h3>
				<ul class="space-y-2" data-testid="run-list">
					{#each runs as run (run.id)}
						{@const href = sessionHref(run)}
						<li class="{s.card(false)} {s.CARD_BODY}" data-testid="run-row">
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
								<span class="{s.PILL} {s.PILL_TONES[RUN_STATUS_TONE[run.status]]}">
									{RUN_STATUS_LABEL[run.status]}
								</span>
								<span class="text-sm text-ink">{formatWhenLong(run.firedAt)}</span>
								{#if run.trigger === "manual"}
									<span class="text-xs text-ink-muted">Run now</span>
								{/if}
							</div>
							{#if run.detail}
								<p class="mt-1.5 text-xs break-words text-ink-muted">{run.detail}</p>
							{/if}
							{#if href}
								<a
									{href}
									class="mt-1.5 inline-block max-w-full truncate text-xs text-accent hover:underline"
								>
									Open session{run.result?.label ? `: ${run.result.label}` : ""}
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</div>
