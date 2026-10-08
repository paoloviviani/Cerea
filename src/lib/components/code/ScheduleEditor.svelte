<!--
	Create or edit a schedule. The target is an ordered picker — machine, then a
	workspace on it (or a new one, made when the schedule is saved), then a new
	session each run or one existing session — followed by mode, model and the
	permission word, whether the run may work with the machine's other
	sessions, the prompt and the timetable.

	The two coordination options (both off) become `session.grantCoordination` at
	each run (see the agent executor). The editor says what the machine will make
	of them: a galopin too old to grant them, or a ceiling that holds a granted
	tool at Ask, which then still waits in the Needs-you inbox.

	The workspace and session lists come from the same /code listings the tree
	uses (`listWorkspaces`, `listWorkspaceAgents`); an offline machine can be
	chosen, and then there is nothing to list: the run is recorded
	"missed: machine offline" for as long as it is away. "New workspace…" goes
	through the same forwarder route and dialog rules as the tree's "Add a
	workspace" (the machine's `workspaceRoots` apply, and its refusal is shown
	here, inline); it is created on Save, before the schedule, and kept if the
	schedule then fails to save so a retry does not make a second one.
-->
<script lang="ts">
	import { onMount, untrack } from "svelte";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconTime from "~icons/carbon/time";
	import {
		createSchedule,
		createWorkspace,
		listProviderModels,
		listProviderModes,
		listProviders,
		listWorkspaceAgents,
		listWorkspaces,
		previewRecurrence,
		suggestWorkspaceDirectories,
		updateSchedule,
		type Recurrence,
		type ScheduleView,
	} from "$lib/codeApi";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import type {
		CodeAgentSession,
		CodeDirectory,
		CodeProviderMode,
		CodeProviderModel,
		CodeWorkspace,
	} from "$lib/types/CodeAgent";
	import {
		allTimezones,
		browserTimezone,
		formatWhen,
		WEEKDAY_NAMES,
	} from "$lib/utils/scheduleFormat";
	import * as s from "$lib/components/overlay/styles";
	import { ceilingNote, coordinationKeys, coordinationSupport } from "$lib/utils/coordination";

	interface Props {
		/** The schedule being edited; absent for a new one. */
		editing?: ScheduleView;
		/** Where "Schedule this…" came from. */
		prefill?: { deviceId?: string; workspaceId?: string; sessionId?: string };
		onsaved: (schedule: ScheduleView) => void;
		oncancel: () => void;
	}

	let { editing, prefill, onsaved, oncancel }: Props = $props();

	const NEW = "__new__";
	type Target = {
		deviceId?: string;
		workspaceId?: string;
		sessionMode?: "new" | "existing";
		sessionId?: string;
		modeId?: string;
		modelId?: string;
		permissionMode?: "deny" | "ask" | "allow";
		canMessage?: boolean;
		canSpawn?: boolean;
		labels?: { machine?: string; workspace?: string; session?: string };
	};
	const stored = (untrack(() => editing?.target) ?? {}) as Target;
	const initial = untrack(() => prefill) ?? {};

	let name = $state(untrack(() => editing?.name) ?? "");
	let prompt = $state(untrack(() => editing?.prompt) ?? "");
	let deviceId = $state(stored.deviceId ?? initial.deviceId ?? "");
	let workspaceChoice = $state(stored.workspaceId ?? initial.workspaceId ?? "");
	let sessionChoice = $state(
		stored.sessionMode === "existing" ? (stored.sessionId ?? NEW) : (initial.sessionId ?? NEW)
	);
	let modeId = $state(stored.modeId ?? "");
	let modelId = $state(stored.modelId ?? "");
	let permissionMode = $state<"deny" | "ask" | "allow">(stored.permissionMode ?? "ask");
	let canMessage = $state(stored.canMessage === true);
	let canSpawn = $state(stored.canSpawn === true);
	let enabled = $state(untrack(() => editing?.enabled) ?? true);

	const initialRecurrence: Recurrence = untrack(() => editing?.recurrence) ?? {
		type: "daily",
		at: "09:00",
	};
	let preset = $state<"hours" | "daily" | "weekdays" | "weekly" | "cron">(initialRecurrence.type);
	let hoursEvery = $state(initialRecurrence.type === "hours" ? initialRecurrence.every : 4);
	let at = $state("at" in initialRecurrence ? initialRecurrence.at : "09:00");
	let weekday = $state(initialRecurrence.type === "weekly" ? initialRecurrence.day : 1);
	let cronExpr = $state(initialRecurrence.type === "cron" ? initialRecurrence.expr : "0 9 * * 1-5");
	let timezone = $state(untrack(() => editing?.timezone) ?? browserTimezone());

	// What the machine says.
	let workspaces = $state<CodeWorkspace[]>([]);
	let sessions = $state<CodeAgentSession[]>([]);
	let modes = $state<CodeProviderMode[]>([]);
	let models = $state<CodeProviderModel[]>([]);
	let provider = $state("opencode");
	let loadingMachine = $state(false);
	let machineNote = $state<string | null>(null);

	// A workspace to create on save.
	let newPath = $state("");
	let newTitle = $state("");
	let suggestions = $state<CodeDirectory[]>([]);
	let suggestTimer: ReturnType<typeof setTimeout> | undefined;

	let preview = $state<{ ok: true; next: Date[] } | { ok: false; error: string } | null>(null);
	let previewTimer: ReturnType<typeof setTimeout> | undefined;
	let busy = $state(false);
	let failure = $state<string | null>(null);

	const pairedDevices = $derived(codeDeviceList.devices.filter((d) => d.status === "paired"));
	const device = $derived(pairedDevices.find((d) => d.id === deviceId));
	const online = $derived(device?.online === true);
	const makingWorkspace = $derived(workspaceChoice === NEW);
	const knownWorkspace = $derived(workspaces.find((w) => w.id === workspaceChoice));
	const timezones = allTimezones();
	// What the chosen machine will make of the coordination options.
	const coordination = $derived(device ? coordinationSupport(device) : null);
	const coordinationCeiling = $derived(
		device && coordination?.ok
			? ceilingNote(device, coordinationKeys({ canMessage, canSpawn }))
			: null
	);

	const recurrence = $derived<Recurrence>(
		preset === "hours"
			? { type: "hours", every: Math.trunc(Number(hoursEvery)) }
			: preset === "weekly"
				? { type: "weekly", day: Number(weekday), at }
				: preset === "cron"
					? { type: "cron", expr: cronExpr.trim() }
					: { type: preset, at }
	);

	/** Load what the chosen machine has. An offline one has nothing to load. */
	async function loadMachine(id: string) {
		workspaces = [];
		modes = [];
		models = [];
		machineNote = null;
		if (!id) return;
		const row = codeDeviceList.devices.find((d) => d.id === id);
		if (row?.online !== true) {
			machineNote = `${row?.name ?? "This machine"} is offline, so its workspaces cannot be listed now. The schedule can still be saved; each run is recorded as missed until it is back.`;
			return;
		}
		loadingMachine = true;
		try {
			const [ws, providers] = await Promise.all([listWorkspaces(id), listProviders(id)]);
			if (deviceId !== id) return;
			workspaces = ws.workspaces;
			provider = providers.providers.find((p) => p.available)?.id ?? "opencode";
			const [m, mm] = await Promise.all([
				listProviderModes(id, provider).catch(() => ({ modes: [] })),
				listProviderModels(id, provider).catch(() => ({ models: [] })),
			]);
			if (deviceId !== id) return;
			modes = m.modes;
			models = mm.models;
			if (!modeId) modeId = modes.find((x) => x.id === "plan")?.id ?? modes[0]?.id ?? "";
		} catch (err) {
			machineNote = err instanceof Error ? err.message : "Could not read this machine.";
		} finally {
			loadingMachine = false;
		}
	}

	async function loadSessions(id: string, workspaceId: string) {
		sessions = [];
		if (!id || !workspaceId || workspaceId === NEW || !online) return;
		try {
			const { agents } = await listWorkspaceAgents(id, workspaceId);
			if (deviceId === id && workspaceChoice === workspaceId) {
				sessions = agents.filter((a) => !a.parentId);
			}
		} catch {
			sessions = [];
		}
	}

	onMount(() => {
		if (!deviceId && pairedDevices.length === 1) deviceId = pairedDevices[0].id;
	});

	$effect(() => {
		const id = deviceId;
		// Re-read when the machine comes online.
		void online;
		untrack(() => void loadMachine(id));
	});

	$effect(() => {
		const id = deviceId;
		const ws = workspaceChoice;
		void online;
		untrack(() => void loadSessions(id, ws));
	});

	// The preview follows the timetable, a beat after the last keystroke.
	$effect(() => {
		const rec = recurrence;
		const tz = timezone;
		clearTimeout(previewTimer);
		previewTimer = setTimeout(() => {
			previewRecurrence(rec, tz)
				.then((answer) => {
					if (rec === recurrence && tz === timezone) preview = answer;
				})
				.catch(() => (preview = null));
		}, 250);
		return () => clearTimeout(previewTimer);
	});

	function onDeviceChange() {
		workspaceChoice = "";
		sessionChoice = NEW;
		modeId = "";
		modelId = "";
		newPath = "";
	}

	function onWorkspaceChange() {
		sessionChoice = NEW;
	}

	function scheduleSuggest(prefix: string) {
		clearTimeout(suggestTimer);
		if (!prefix.trim() || !online) {
			suggestions = [];
			return;
		}
		suggestTimer = setTimeout(async () => {
			try {
				const { directories } = await suggestWorkspaceDirectories(deviceId, prefix);
				suggestions = newPath === prefix ? directories : suggestions;
			} catch {
				suggestions = [];
			}
		}, 250);
	}

	const sessionTitle = (id: string) => sessions.find((x) => x.id === id)?.title;

	async function save() {
		if (busy) return;
		failure = null;
		if (!name.trim()) return (failure = "Give the schedule a name.");
		if (!deviceId) return (failure = "Choose the machine it runs on.");
		if (!workspaceChoice) return (failure = "Choose a workspace.");
		if (makingWorkspace && !newPath.trim())
			return (failure = "Enter the new workspace's directory.");
		if (!prompt.trim()) return (failure = "Write the prompt it sends.");
		busy = true;
		try {
			let workspaceId = workspaceChoice;
			let workspaceName = knownWorkspace?.name ?? stored.labels?.workspace;
			if (makingWorkspace) {
				const { workspace } = await createWorkspace(deviceId, {
					path: newPath.trim(),
					...(newTitle.trim() ? { title: newTitle.trim() } : {}),
				});
				workspaces = [...workspaces, workspace];
				workspaceId = workspace.id;
				workspaceName = workspace.name;
				// Kept, so a failed save below does not make a second one on retry.
				workspaceChoice = workspace.id;
			}
			const existing = sessionChoice !== NEW && !makingWorkspace;
			const target = {
				deviceId,
				workspaceId,
				sessionMode: existing ? "existing" : "new",
				...(existing ? { sessionId: sessionChoice } : {}),
				...(modeId ? { modeId } : {}),
				...(modelId ? { modelId } : {}),
				permissionMode,
				...(canMessage ? { canMessage: true } : {}),
				...(canSpawn ? { canSpawn: true } : {}),
				labels: {
					...(workspaceName ? { workspace: workspaceName } : {}),
					...(existing ? { session: sessionTitle(sessionChoice) ?? stored.labels?.session } : {}),
				},
			};
			const input = {
				name: name.trim(),
				prompt: prompt.trim(),
				recurrence,
				timezone,
				enabled,
				target,
			};
			const saved = editing ? await updateSchedule(editing.id, input) : await createSchedule(input);
			onsaved(saved.schedule);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save the schedule.";
		} finally {
			busy = false;
		}
	}
</script>

<div class="pointer-events-auto scrollbar-custom min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
	<div class={s.EMBEDDED} data-testid="schedule-editor">
		<form
			class="p-4 sm:p-6"
			onsubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div class={s.HEADER}>
				<h2 class={s.TITLE}>{editing ? "Edit schedule" : "New schedule"}</h2>
				<p class={s.SUBTITLE}>
					Sends a prompt to a coding session on one of your machines, on a timetable.
				</p>
			</div>

			{#if failure}
				<div class="{s.ERROR} mb-4" role="alert">
					<p class="flex items-center gap-1.5 font-medium">
						<IconWarning class="size-4 shrink-0" />
						Could not save
					</p>
					<p class="mt-1 break-words">{failure}</p>
				</div>
			{/if}

			<label class={s.LABEL} for="sched-name">Name</label>
			<input
				id="sched-name"
				class={s.INPUT}
				style="font-size: 16px;"
				maxlength={80}
				placeholder="Nightly test run"
				bind:value={name}
				disabled={busy}
			/>

			<h3 class="{s.SECTION_TITLE} mt-6">Where it runs</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-device">1. Machine</label>
					<select
						id="sched-device"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={deviceId}
						onchange={onDeviceChange}
						disabled={busy}
					>
						<option value="" disabled>Choose a machine</option>
						{#each pairedDevices as d (d.id)}
							<option value={d.id}>{d.name} · {d.online ? "online" : "offline"}</option>
						{/each}
					</select>
				</div>
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-workspace">2. Workspace</label>
					<select
						id="sched-workspace"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={workspaceChoice}
						onchange={onWorkspaceChange}
						disabled={busy || !deviceId}
					>
						<option value="" disabled>
							{loadingMachine ? "Loading…" : "Choose a workspace"}
						</option>
						{#each workspaces as w (w.id)}
							<option value={w.id}>{w.name}</option>
						{/each}
						{#if workspaceChoice && workspaceChoice !== NEW && !knownWorkspace}
							<option value={workspaceChoice}>{stored.labels?.workspace ?? workspaceChoice}</option>
						{/if}
						{#if online}
							<option value={NEW}>New workspace…</option>
						{/if}
					</select>
				</div>
			</div>
			{#if machineNote}
				<p class="{s.NOTICE} mt-3" data-testid="machine-offline-note">{machineNote}</p>
			{/if}

			{#if makingWorkspace}
				<div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" data-testid="new-workspace">
					<div class="relative min-w-0">
						<label class={s.LABEL} for="sched-newpath">Directory on the machine</label>
						<input
							id="sched-newpath"
							class={s.INPUT}
							style="font-size: 16px;"
							placeholder="/home/you/checkouts/myrepo"
							maxlength={1024}
							autocomplete="off"
							bind:value={newPath}
							oninput={() => scheduleSuggest(newPath)}
							disabled={busy}
						/>
						{#if suggestions.length > 0}
							<div
								role="listbox"
								aria-label="Matching directories"
								class="absolute z-20 mt-1 scrollbar-custom max-h-48 w-full overflow-y-auto rounded-lg border border-line bg-surface py-1 text-sm shadow-lg"
							>
								{#each suggestions as dir (dir.path)}
									<button
										type="button"
										role="option"
										aria-selected="false"
										class="block w-full truncate px-3 py-1.5 text-left text-ink hover:bg-sunken"
										onpointerdown={(e) => {
											e.preventDefault();
											newPath = dir.path;
											suggestions = [];
										}}
									>
										{dir.path}
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-newtitle">Title (optional)</label>
						<input
							id="sched-newtitle"
							class={s.INPUT}
							style="font-size: 16px;"
							maxlength={120}
							bind:value={newTitle}
							disabled={busy}
						/>
					</div>
					<p class="{s.HINT} sm:col-span-2">
						Created when you save. The machine decides which directories it will serve.
					</p>
				</div>
			{/if}

			<div class="mt-4 min-w-0">
				<label class={s.LABEL} for="sched-session">3. Session</label>
				<select
					id="sched-session"
					class={s.INPUT}
					style="font-size: 16px;"
					bind:value={sessionChoice}
					disabled={busy || makingWorkspace || !workspaceChoice}
				>
					<option value={NEW}>A new session each run</option>
					{#each sessions as session (session.id)}
						<option value={session.id}>{session.title}</option>
					{/each}
					{#if sessionChoice !== NEW && !sessions.some((x) => x.id === sessionChoice)}
						<option value={sessionChoice}>{stored.labels?.session ?? sessionChoice}</option>
					{/if}
				</select>
				<p class={s.HINT}>
					{sessionChoice === NEW
						? "Each run starts a session titled “name · date” in this workspace."
						: "Every run goes to this one session; its mode, model and permission word are set to the ones below."}
				</p>
			</div>

			<h3 class="{s.SECTION_TITLE} mt-6">How the agent runs</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-mode">Agent mode</label>
					<select
						id="sched-mode"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={modeId}
						disabled={busy || !deviceId}
					>
						<option value="">Default (plan)</option>
						{#each modes as m (m.id)}
							<option value={m.id}>{m.label}</option>
						{/each}
						{#if modeId && !modes.some((m) => m.id === modeId)}
							<option value={modeId}>{modeId}</option>
						{/if}
					</select>
				</div>
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-model">Model</label>
					<select
						id="sched-model"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={modelId}
						disabled={busy || !deviceId}
					>
						<option value="">The machine's default</option>
						{#each models as m (m.id)}
							<option value={m.id}>{m.label}</option>
						{/each}
						{#if modelId && !models.some((m) => m.id === modelId)}
							<option value={modelId}>{modelId}</option>
						{/if}
					</select>
				</div>
			</div>

			<div class="mt-4">
				<span class={s.LABEL} id="sched-perm-label">Permission mode</span>
				<div class="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="sched-perm-label">
					{#each [["deny", "Deny"], ["ask", "Ask"], ["allow", "Allow"]] as const as [value, label] (value)}
						<button
							type="button"
							role="radio"
							aria-checked={permissionMode === value}
							class={permissionMode === value ? s.PRIMARY : s.SECONDARY}
							onclick={() => (permissionMode = value)}
							disabled={busy}
						>
							{label}
						</button>
					{/each}
				</div>
				{#if permissionMode === "ask"}
					<p class="{s.NOTICE} mt-2" data-testid="ask-warning">
						Nobody is watching a scheduled run. On Ask it stops at its first approval and waits; the
						approval card appears in the Needs-you inbox at the top of this page. Choose Allow for
						work that must finish on its own.
					</p>
				{:else if permissionMode === "allow"}
					<p class={s.HINT}>
						Runs without asking, but never past the machine's own ceiling: what that machine caps at
						Ask still asks.
					</p>
				{:else}
					<p class={s.HINT}>The agent can read but is refused anything that changes or runs.</p>
				{/if}
			</div>

			<div class="mt-4" data-testid="coordination-options">
				<span class={s.LABEL} id="sched-coord-label">Other sessions on this machine</span>
				<div class="space-y-2" role="group" aria-labelledby="sched-coord-label">
					<label class="flex items-start gap-2 text-sm text-ink">
						<input type="checkbox" class="mt-1" bind:checked={canMessage} disabled={busy} />
						<span>Can find, read and message other sessions</span>
					</label>
					<label class="flex items-start gap-2 text-sm text-ink">
						<input type="checkbox" class="mt-1" bind:checked={canSpawn} disabled={busy} />
						<span>Can start new sessions</span>
					</label>
				</div>
				<p class={s.HINT}>
					Lets a run orchestrate the machine's other sessions without stopping at an approval card.
					Never past the machine's own limits: a session in another workspace, a long chain of agent
					messages and anything the machine caps at Ask still ask.
				</p>
				{#if coordination && !coordination.ok}
					<p class="{s.NOTICE} mt-2" data-testid="coordination-unsupported">
						{coordination.reason === "too-old"
							? "This machine's galopin is too old to grant coordination; update it. The schedule still runs, without these options."
							: "This machine was enrolled without agent tools, so these options cannot be granted. The schedule still runs, without them."}
					</p>
				{:else if coordinationCeiling}
					<p class="{s.NOTICE} mt-2" data-testid="coordination-ceiling">{coordinationCeiling}</p>
				{/if}
			</div>

			<label class="{s.LABEL} mt-6" for="sched-prompt">Prompt</label>
			<textarea
				id="sched-prompt"
				class="{s.INPUT} min-h-28"
				style="font-size: 16px;"
				maxlength={8000}
				placeholder="Run the test suite and summarise any failures."
				bind:value={prompt}
				disabled={busy}
			></textarea>

			<h3 class="{s.SECTION_TITLE} mt-6">When</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-preset">Repeats</label>
					<select
						id="sched-preset"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={preset}
						disabled={busy}
					>
						<option value="hours">Every N hours</option>
						<option value="daily">Every day</option>
						<option value="weekdays">Weekdays</option>
						<option value="weekly">Every week</option>
						<option value="cron">Advanced (cron expression)</option>
					</select>
				</div>
				<div class="min-w-0">
					{#if preset === "hours"}
						<label class={s.LABEL} for="sched-hours">Every how many hours</label>
						<input
							id="sched-hours"
							class={s.INPUT}
							style="font-size: 16px;"
							type="number"
							min="1"
							max="720"
							step="1"
							bind:value={hoursEvery}
							disabled={busy}
						/>
					{:else if preset === "cron"}
						<label class={s.LABEL} for="sched-cron">Cron expression</label>
						<input
							id="sched-cron"
							class="{s.INPUT} font-mono"
							style="font-size: 16px;"
							placeholder="0 9 * * 1-5"
							spellcheck="false"
							autocomplete="off"
							bind:value={cronExpr}
							disabled={busy}
						/>
					{:else}
						<label class={s.LABEL} for="sched-at">At</label>
						<input
							id="sched-at"
							class={s.INPUT}
							style="font-size: 16px;"
							type="time"
							bind:value={at}
							disabled={busy}
						/>
					{/if}
				</div>
				{#if preset === "weekly"}
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-day">On</label>
						<select
							id="sched-day"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={weekday}
							disabled={busy}
						>
							{#each WEEKDAY_NAMES as day, index (day)}
								<option value={index}>{day}</option>
							{/each}
						</select>
					</div>
				{/if}
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-tz">Timezone</label>
					<input
						id="sched-tz"
						class={s.INPUT}
						style="font-size: 16px;"
						list="sched-tz-list"
						autocomplete="off"
						bind:value={timezone}
						disabled={busy}
					/>
					<datalist id="sched-tz-list">
						{#each timezones as zone (zone)}
							<option value={zone}></option>
						{/each}
					</datalist>
				</div>
			</div>
			{#if preset === "cron"}
				<p class={s.HINT}>
					Five fields: minute hour day-of-month month day-of-week. At least 15 minutes between runs.
				</p>
			{/if}

			<div class="mt-3 rounded-lg bg-sunken p-3" data-testid="schedule-preview" aria-live="polite">
				{#if preview?.ok}
					<p class="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink">
						<IconTime class="size-3.5" /> Next runs ({timezone})
					</p>
					<ul class="space-y-0.5 text-xs text-ink-muted">
						{#each preview.next as when (when.getTime())}
							<li>{formatWhen(when, timezone)}</li>
						{/each}
					</ul>
				{:else if preview}
					<p class="flex items-start gap-1.5 text-xs text-danger" data-testid="preview-error">
						<IconWarning class="mt-px size-3.5 shrink-0" />
						<span class="min-w-0 break-words">{preview.error}</span>
					</p>
				{:else}
					<p class="text-xs text-ink-faint">Working out the next runs…</p>
				{/if}
			</div>

			<label class="mt-4 flex items-center gap-2 text-sm text-ink">
				<input type="checkbox" bind:checked={enabled} disabled={busy} />
				Enabled
			</label>

			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" class={s.SECONDARY} onclick={oncancel} disabled={busy}>Cancel</button>
				<button type="submit" class={s.PRIMARY} disabled={busy}>
					{busy ? "Saving…" : editing ? "Save changes" : "Create schedule"}
				</button>
			</div>
		</form>
	</div>
</div>
