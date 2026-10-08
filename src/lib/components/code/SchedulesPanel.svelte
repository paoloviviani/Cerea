<!--
	Scheduled actions, in the /code pane: the list, the editor and one
	schedule's history, switched by the address — `?view=schedules` the list,
	`&new=1` the editor (`&device=&ws=&agent=` prefill it, which is what a
	session's "Schedule this…" sends), `&schedule=<id>` the history and
	`&schedule=<id>&edit=1` the editor on it. Like the rest of the panel the
	address is the state, so back and reload land where you were.

	The list shows what a person decides by: where it runs ("machine ›
	workspace › new session | session"), when next (in their own time), how
	the last run went, and the actions. Nothing here talks to a machine; the
	server owns the rows and the executor does the work.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import IconTime from "~icons/carbon/time";
	import IconAdd from "~icons/carbon/add";
	import IconEdit from "~icons/carbon/edit";
	import IconTrash from "~icons/carbon/trash-can";
	import IconPlay from "~icons/carbon/play";
	import IconList from "~icons/carbon/list";
	import IconWarning from "~icons/carbon/warning-filled";
	import {
		deleteSchedule,
		listSchedules,
		runScheduleNow,
		updateSchedule,
		type ScheduleRunView,
		type ScheduleView,
	} from "$lib/codeApi";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";
	import ScheduleEditor from "./ScheduleEditor.svelte";
	import ScheduleHistory from "./ScheduleHistory.svelte";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import {
		formatWhen,
		recurrenceText,
		RUN_STATUS_LABEL,
		RUN_STATUS_TONE,
	} from "$lib/utils/scheduleFormat";
	import * as s from "$lib/components/overlay/styles";

	const params = $derived(page.url.searchParams);
	const scheduleId = $derived(params.get("schedule"));
	const editing = $derived(params.get("edit") === "1");
	const creating = $derived(params.get("new") === "1");

	let schedules = $state<ScheduleView[]>([]);
	let limit = $state(20);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let busyId = $state<string | null>(null);
	let notice = $state<{ id: string; run: ScheduleRunView } | null>(null);
	let confirmDelete = $state<ScheduleView | null>(null);

	const address = (extra: Record<string, string> = {}) => {
		const query = new URLSearchParams({ view: "schedules", ...extra });
		return `${base}/code?${query}`;
	};
	const toList = () => void goto(address());

	async function load() {
		try {
			const answer = await listSchedules();
			schedules = answer.schedules;
			limit = answer.limit;
			failure = null;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load your schedules.";
		} finally {
			loading = false;
		}
	}

	// Coming back to the list (after a save, from the history) reads it afresh.
	let wasList = false;
	$effect(() => {
		const onList = !creating && !scheduleId;
		if (onList && !wasList && !loading) void load();
		wasList = onList;
	});

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			if (!scheduleId && !creating) void load();
		}, 15_000);
		return () => clearInterval(timer);
	});

	async function toggle(schedule: ScheduleView) {
		busyId = schedule.id;
		try {
			await updateSchedule(schedule.id, { enabled: !schedule.enabled });
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not change the schedule.";
		} finally {
			busyId = null;
		}
	}

	async function runNow(schedule: ScheduleView) {
		busyId = schedule.id;
		notice = null;
		try {
			const { run } = await runScheduleNow(schedule.id);
			notice = { id: schedule.id, run };
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not run the schedule.";
		} finally {
			busyId = null;
		}
	}

	async function remove(schedule: ScheduleView) {
		await deleteSchedule(schedule.id);
		confirmDelete = null;
		await load();
	}

	const deviceOnline = (schedule: ScheduleView) => {
		const id = schedule.target.deviceId;
		return codeDeviceList.devices.find((d) => d.id === id)?.online === true;
	};

	const prefill = $derived({
		deviceId: params.get("device") ?? undefined,
		workspaceId: params.get("ws") ?? undefined,
		sessionId: params.get("agent") ?? undefined,
	});
	const edited = $derived(schedules.find((x) => x.id === scheduleId));
</script>

{#if creating}
	<ScheduleEditor {prefill} onsaved={toList} oncancel={toList} />
{:else if scheduleId && editing}
	{#if edited}
		{#key edited.id}
			<ScheduleEditor editing={edited} onsaved={toList} oncancel={toList} />
		{/key}
	{:else if loading}
		<p class="p-6 text-sm text-ink-muted">Loading…</p>
	{:else}
		<div class="p-6"><div class={s.ERROR}>No such schedule.</div></div>
	{/if}
{:else if scheduleId}
	<ScheduleHistory {scheduleId} onback={toList} />
{:else}
	<div class="pointer-events-auto scrollbar-custom min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
		<div class={s.EMBEDDED} data-testid="schedules-list">
			<div class="p-4 sm:p-6">
				<div class={s.HEADER}>
					<h2 class={s.TITLE}>Schedules</h2>
					<p class={s.SUBTITLE}>Prompts sent to your coding sessions on a timetable.</p>
				</div>

				<div class="{s.STRIP} {schedules.length ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
					<div class="flex items-center gap-3">
						<div class="{s.STRIP_TILE} {schedules.length ? '' : 'grayscale'} shrink-0">
							<IconTime class="size-5 text-accent" />
						</div>
						<div class="min-w-0">
							<p class={s.STRIP_HEADLINE}>
								{schedules.length}
								{schedules.length === 1 ? "schedule" : "schedules"}
							</p>
							<p class={s.STRIP_DETAIL}>
								{schedules.filter((x) => x.enabled).length} on · up to {limit}
							</p>
						</div>
					</div>
					<a href={address({ new: "1" })} class={s.PRIMARY} data-testid="new-schedule">
						<IconAdd class="size-4" /> New schedule
					</a>
				</div>

				{#if failure}
					<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
				{/if}

				{#if loading}
					<p class="text-sm text-ink-muted">Loading…</p>
				{:else if schedules.length === 0}
					<div class={s.EMPTY}>
						<IconTime class={s.EMPTY_ICON} />
						<p class={s.EMPTY_TITLE}>No schedules yet</p>
						<p class="{s.EMPTY_DETAIL} text-center">
							Make one here, or choose “Schedule this…” in a session's menu to start from it.
						</p>
						<a href={address({ new: "1" })} class={s.PRIMARY}>
							<IconAdd class="size-4" /> New schedule
						</a>
					</div>
				{:else}
					<ul class="space-y-3">
						{#each schedules as schedule (schedule.id)}
							<li
								class={s.card(schedule.enabled)}
								data-testid="schedule-row"
								data-schedule-name={schedule.name}
							>
								<div class={s.CARD_BODY}>
									<div class="flex items-start justify-between gap-3">
										<div class="min-w-0">
											<p class="{s.CARD_TITLE} break-words !whitespace-normal">{schedule.name}</p>
											<p class="text-sm break-words text-ink-muted" data-testid="schedule-target">
												{schedule.targetLabel}
											</p>
										</div>
										<button
											type="button"
											role="switch"
											aria-checked={schedule.enabled}
											aria-label="{schedule.enabled ? 'Turn off' : 'Turn on'} {schedule.name}"
											class="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors {schedule.enabled
												? 'bg-accent-solid'
												: 'bg-line-strong'} disabled:opacity-50"
											disabled={busyId === schedule.id}
											onclick={() => toggle(schedule)}
										>
											<span
												class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform {schedule.enabled
													? 'translate-x-4'
													: ''}"
											></span>
										</button>
									</div>

									<dl class="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
										<div class="min-w-0">
											<dt class="text-ink-faint">Repeats</dt>
											<dd class="break-words text-ink">
												{recurrenceText(schedule.recurrence)}
												<span class="text-ink-muted">· {schedule.timezone}</span>
											</dd>
										</div>
										<div class="min-w-0">
											<dt class="text-ink-faint">Next run</dt>
											<dd class="text-ink" data-testid="next-run">
												{schedule.enabled ? formatWhen(schedule.nextRunAt) : "Off"}
											</dd>
										</div>
										<div class="min-w-0">
											<dt class="text-ink-faint">Last run</dt>
											<dd class="flex flex-wrap items-center gap-1.5 text-ink">
												{#if schedule.lastStatus}
													<span
														class="{s.PILL} {s.PILL_TONES[RUN_STATUS_TONE[schedule.lastStatus]]}"
														data-testid="last-status"
													>
														{RUN_STATUS_LABEL[schedule.lastStatus]}
													</span>
													{#if schedule.lastRunAt}
														<span class="text-ink-muted">{formatWhen(schedule.lastRunAt)}</span>
													{/if}
												{:else}
													<span class="text-ink-muted">Never</span>
												{/if}
											</dd>
										</div>
									</dl>

									{#if schedule.disabledReason && !schedule.enabled}
										<p
											class="mt-2 flex items-start gap-1.5 rounded-lg bg-danger-subtle px-2.5 py-1.5 text-xs text-danger"
											data-testid="disabled-reason"
										>
											<IconWarning class="mt-px size-3.5 shrink-0" />
											<span class="min-w-0 break-words">{schedule.disabledReason}</span>
										</p>
									{:else if !deviceOnline(schedule) && schedule.enabled}
										<p class="mt-2 text-xs text-ink-muted">
											That machine is offline; runs are recorded as missed until it is back.
										</p>
									{/if}

									{#if notice?.id === schedule.id}
										<p class="{s.NOTICE} mt-2 break-words" data-testid="run-notice">
											{RUN_STATUS_LABEL[notice.run.status]}{notice.run.detail
												? `: ${notice.run.detail}`
												: ""}
										</p>
									{/if}

									<div class="mt-3 flex flex-wrap gap-2">
										<button
											type="button"
											class={s.CARD_ACTION}
											disabled={busyId === schedule.id}
											onclick={() => runNow(schedule)}
										>
											<IconPlay class="size-3.5" /> Run now
										</button>
										<a href={address({ schedule: schedule.id })} class={s.CARD_ACTION}>
											<IconList class="size-3.5" /> History
										</a>
										<a href={address({ schedule: schedule.id, edit: "1" })} class={s.CARD_ACTION}>
											<IconEdit class="size-3.5" /> Edit
										</a>
										<button
											type="button"
											class={s.CARD_DESTRUCTIVE}
											onclick={() => (confirmDelete = schedule)}
										>
											<IconTrash class="size-3.5" /> Delete
										</button>
									</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="{s.TIPS} mt-6">
					<p class={s.TIPS_TITLE}>Good to know</p>
					<ul class={s.TIPS_LIST}>
						<li>Runs are at least 15 minutes apart. Times are read in the schedule's timezone.</li>
						<li>
							A run on a machine that is offline is recorded as missed, never queued. Machines pay
							for their own runs with their own credential.
						</li>
						<li>
							If the previous run's session is still working, the next one is skipped. If Cerea was
							down, at most one late run is made up, and only when it is not very late.
						</li>
						<li>Three failed runs in a row switch a schedule off.</li>
					</ul>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if confirmDelete}
	{@const target = confirmDelete}
	<CodeConfirmDialog
		title="Delete schedule"
		target={target.name}
		message="The schedule stops and is removed. Sessions it already started stay on the machine, and its past runs stay on record for 90 days."
		confirmLabel="Delete schedule"
		busyLabel="Deleting…"
		onconfirm={() => remove(target)}
		onclose={() => (confirmDelete = null)}
	/>
{/if}
