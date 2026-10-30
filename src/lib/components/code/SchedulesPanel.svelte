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
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import ScheduleCreatedBy from "./ScheduleCreatedBy.svelte";
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
	import { formatWhen, RUN_STATUS_TONE } from "$lib/utils/scheduleFormat";
	import { recurrenceLabel, runStatusLabel } from "./scheduleLabels";
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

	// The same pane lives in the /code panel (`?view=schedules`) and, for everyone, at /schedules.
	interface Props {
		standalone?: boolean;
	}
	let { standalone = false }: Props = $props();
	// Each area lists and makes its own kind: /schedules the chat ones, /code the agent ones.
	const kind = $derived<"agent" | "chat">(standalone ? "chat" : "agent");
	const shown = $derived(schedules.filter((x) => x.kind === kind));

	const address = (extra: Record<string, string> = {}) => {
		if (standalone) {
			const query = new URLSearchParams(extra).toString();
			return `${base}/schedules${query ? `?${query}` : ""}`;
		}
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
			failure = err instanceof Error ? err.message : m["code.schedules.could_not_load"]();
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
			failure = err instanceof Error ? err.message : m["code.schedules.could_not_change"]();
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
			failure = err instanceof Error ? err.message : m["code.schedules.could_not_run"]();
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
		// Only an agent schedule has a machine to be offline.
		if (schedule.kind !== "agent") return true;
		const id = schedule.target.deviceId;
		return codeDeviceList.devices.find((d) => d.id === id)?.online === true;
	};

	const prefill = $derived({
		deviceId: params.get("device") ?? undefined,
		workspaceId: params.get("ws") ?? undefined,
		sessionId: params.get("agent") ?? undefined,
		conversationId: params.get("conversation") ?? undefined,
	});
	const edited = $derived(shown.find((x) => x.id === scheduleId));
</script>

{#if creating}
	<ScheduleEditor {prefill} {kind} onsaved={toList} oncancel={toList} />
{:else if scheduleId && editing}
	{#if edited}
		{#key edited.id}
			<ScheduleEditor editing={edited} {kind} onsaved={toList} oncancel={toList} />
		{/key}
	{:else if loading}
		<p class="p-6 text-sm text-ink-muted">{m["code.schedules.loading"]()}</p>
	{:else}
		<div class="p-6"><div class={s.ERROR}>{m["code.schedules.no_such"]()}</div></div>
	{/if}
{:else if scheduleId}
	<ScheduleHistory {scheduleId} onback={toList} />
{:else}
	<div class="pointer-events-auto scrollbar-custom min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
		<div class={s.EMBEDDED} data-testid="schedules-list">
			<div class="p-4 sm:p-6">
				<div class={s.HEADER}>
					<h2 class={s.TITLE}>{m["code.schedules.title"]()}</h2>
					<p class={s.SUBTITLE}>
						{kind === "chat" ? m["code.schedules.subtitle_chat"]() : m["code.schedules.subtitle"]()}
					</p>
				</div>

				<div class="{s.STRIP} {shown.length ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
					<div class="flex items-center gap-3">
						<div class="{s.STRIP_TILE} {shown.length ? '' : 'grayscale'} shrink-0">
							<IconTime class="size-5 text-accent" />
						</div>
						<div class="min-w-0">
							<p class={s.STRIP_HEADLINE}>
								{m["code.schedules.count"]({ count: shown.length })}
							</p>
							<p class={s.STRIP_DETAIL}>
								{m["code.schedules.on_up_to"]({
									on: shown.filter((x) => x.enabled).length,
									limit,
								})}
							</p>
						</div>
					</div>
					<a href={address({ new: "1" })} class={s.PRIMARY} data-testid="new-schedule">
						<IconAdd class="size-4" />
						{m["code.schedules.new"]()}
					</a>
				</div>

				{#if failure}
					<div class="{s.ERROR} mb-4" role="alert">{failure}</div>
				{/if}

				{#if loading}
					<p class="text-sm text-ink-muted">{m["code.schedules.loading"]()}</p>
				{:else if shown.length === 0}
					<div class={s.EMPTY}>
						<IconTime class={s.EMPTY_ICON} />
						<p class={s.EMPTY_TITLE}>{m["code.schedules.empty_title"]()}</p>
						<p class="{s.EMPTY_DETAIL} text-center">
							{kind === "chat"
								? m["code.schedules.empty_detail_chat"]()
								: m["code.schedules.empty_detail"]()}
						</p>
						<a href={address({ new: "1" })} class={s.PRIMARY}>
							<IconAdd class="size-4" />
							{m["code.schedules.new"]()}
						</a>
					</div>
				{:else}
					<ul class="space-y-3">
						{#each shown as schedule (schedule.id)}
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
											<ScheduleCreatedBy createdBy={schedule.createdBy} class="mt-0.5" />
										</div>
										<button
											type="button"
											role="switch"
											aria-checked={schedule.enabled}
											aria-label={schedule.enabled
												? m["code.schedules.turn_off"]({ name: schedule.name })
												: m["code.schedules.turn_on"]({ name: schedule.name })}
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
											<dt class="text-ink-faint">{m["code.schedules.repeats"]()}</dt>
											<dd class="break-words text-ink">
												{recurrenceLabel(schedule.recurrence)}
												<span class="text-ink-muted">· {schedule.timezone}</span>
											</dd>
										</div>
										<div class="min-w-0">
											<dt class="text-ink-faint">{m["code.schedules.next_run"]()}</dt>
											<dd class="text-ink" data-testid="next-run">
												{schedule.enabled
													? formatWhen(schedule.nextRunAt)
													: m["code.schedules.off"]()}
											</dd>
										</div>
										<div class="min-w-0">
											<dt class="text-ink-faint">{m["code.schedules.last_run"]()}</dt>
											<dd class="flex flex-wrap items-center gap-1.5 text-ink">
												{#if schedule.lastStatus}
													<span
														class="{s.PILL} {s.PILL_TONES[RUN_STATUS_TONE[schedule.lastStatus]]}"
														data-testid="last-status"
													>
														{runStatusLabel(schedule.lastStatus)}
													</span>
													{#if schedule.lastRunAt}
														<span class="text-ink-muted">{formatWhen(schedule.lastRunAt)}</span>
													{/if}
												{:else}
													<span class="text-ink-muted">{m["code.schedules.never"]()}</span>
												{/if}
											</dd>
										</div>
										{#if schedule.maxOccurrences !== undefined}
											<div class="min-w-0">
												<dt class="text-ink-faint">{m["code.schedules.runs"]()}</dt>
												<dd class="text-ink" data-testid="run-progress">
													{m["code.schedules.run_progress"]({
														fired: schedule.firedCount,
														max: schedule.maxOccurrences,
													})}
												</dd>
											</div>
										{/if}
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
											{m["code.schedules.offline_note"]()}
										</p>
									{/if}

									{#if notice?.id === schedule.id}
										<p class="{s.NOTICE} mt-2 break-words" data-testid="run-notice">
											{notice.run.detail
												? m["code.schedules.run_notice"]({
														status: runStatusLabel(notice.run.status),
														detail: notice.run.detail,
													})
												: runStatusLabel(notice.run.status)}
										</p>
									{/if}

									<div class="mt-3 flex flex-wrap gap-2">
										<button
											type="button"
											class={s.CARD_ACTION}
											disabled={busyId === schedule.id}
											onclick={() => runNow(schedule)}
										>
											<IconPlay class="size-3.5" />
											{m["code.schedules.run_now"]()}
										</button>
										<a href={address({ schedule: schedule.id })} class={s.CARD_ACTION}>
											<IconList class="size-3.5" />
											{m["code.schedules.history"]()}
										</a>
										<a href={address({ schedule: schedule.id, edit: "1" })} class={s.CARD_ACTION}>
											<IconEdit class="size-3.5" />
											{m["code.schedules.edit"]()}
										</a>
										<button
											type="button"
											class={s.CARD_DESTRUCTIVE}
											onclick={() => (confirmDelete = schedule)}
										>
											<IconTrash class="size-3.5" />
											{m["code.schedules.delete"]()}
										</button>
									</div>
								</div>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="{s.TIPS} mt-6">
					<p class={s.TIPS_TITLE}>{m["code.schedules.tips.title"]()}</p>
					<ul class={s.TIPS_LIST}>
						<li>{m["code.schedules.tips.spacing"]()}</li>
						<li>{m["code.schedules.tips.offline"]()}</li>
						<li>{m["code.schedules.tips.skipped"]()}</li>
						<li>{m["code.schedules.tips.failures"]()}</li>
						<li>{m["code.schedules.tips.chat"]()}</li>
					</ul>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if confirmDelete}
	{@const target = confirmDelete}
	<CodeConfirmDialog
		title={m["code.schedules.delete_title"]()}
		target={target.name}
		message={m["code.schedules.delete_message"]()}
		confirmLabel={m["code.schedules.delete_title"]()}
		busyLabel={m["code.schedules.deleting"]()}
		onconfirm={() => remove(target)}
		onclose={() => (confirmDelete = null)}
	/>
{/if}
