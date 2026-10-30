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
	import { m } from "$lib/paraglide/messages";
	import { onMount, untrack } from "svelte";
	import { page } from "$app/state";
	import ScheduleCreatedBy from "./ScheduleCreatedBy.svelte";
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
	import { allTimezones, browserTimezone, formatWhen } from "$lib/utils/scheduleFormat";
	import { weekdayNames } from "./scheduleLabels";
	import * as s from "$lib/components/overlay/styles";
	import { ceilingNote, coordinationKeys, coordinationSupport } from "$lib/utils/coordination";

	interface Props {
		/** The schedule being edited; absent for a new one. */
		editing?: ScheduleView;
		/** Where "Schedule this…" came from. */
		prefill?: {
			deviceId?: string;
			workspaceId?: string;
			sessionId?: string;
			/** A conversation's "Schedule…": the chat to continue, or to copy the model and project from. */
			conversationId?: string;
		};
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

	// What it runs: a coding agent on a paired machine (people the /code panel is on for), or
	// a chat (everyone). An existing schedule keeps its kind.
	const agentsAllowed = page.data.codeSchedulesEnabled !== false;
	let kind = $state<"agent" | "chat">(
		untrack(() => editing?.kind) ?? (initial.conversationId || !agentsAllowed ? "chat" : "agent")
	);
	type ChatTarget = {
		mode?: "continue" | "new";
		conversationId?: string;
		model?: string;
		projectId?: string;
		billingGroupId?: string;
	};
	const chatStored = (untrack(() => (editing?.kind === "chat" ? editing.target : {})) ??
		{}) as ChatTarget;
	let chatMode = $state<"continue" | "new">(chatStored.mode ?? "continue");
	let chatConversationId = $state(chatStored.conversationId ?? initial.conversationId ?? "");
	let chatModel = $state(chatStored.model ?? "");
	const chatConversations = $derived(
		(page.data.conversations ?? []) as { id: string | { toString(): string }; title: string }[]
	);
	const chatModels = $derived(
		(page.data.models ?? []) as {
			id: string;
			displayName?: string;
			name?: string;
			unlisted?: boolean;
		}[]
	);
	const templateChat = $derived(
		chatConversations.find((c) => String(c.id) === initial.conversationId)
	);

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
	let stopAfter = $state(
		untrack(() => (editing?.maxOccurrences != null ? String(editing.maxOccurrences) : ""))
	);

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
			machineNote = m["code.schedule_editor.offline"]({
				name: row?.name ?? m["code.schedule_editor.machine_fallback"](),
			});
			return;
		}
		loadingMachine = true;
		try {
			const [ws, providers] = await Promise.all([listWorkspaces(id), listProviders(id)]);
			if (deviceId !== id) return;
			workspaces = ws.workspaces;
			provider = providers.providers.find((p) => p.available)?.id ?? "opencode";
			const [modeList, modelList] = await Promise.all([
				listProviderModes(id, provider).catch(() => ({ modes: [] })),
				listProviderModels(id, provider).catch(() => ({ models: [] })),
			]);
			if (deviceId !== id) return;
			modes = modeList.modes;
			models = modelList.models;
			if (!modeId) modeId = modes.find((x) => x.id === "plan")?.id ?? modes[0]?.id ?? "";
		} catch (err) {
			machineNote = err instanceof Error ? err.message : m["code.schedule_editor.could_not_read"]();
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
		if (!name.trim()) return (failure = m["code.schedule_editor.err_name"]());
		if (kind === "chat") {
			if (chatMode === "continue" && !chatConversationId)
				return (failure = m["code.schedule_editor.err_chat"]());
			if (chatMode === "new" && !chatModel && !initial.conversationId)
				return (failure = m["code.schedule_editor.err_model"]());
		} else if (!deviceId) return (failure = m["code.schedule_editor.err_machine"]());
		if (kind === "agent") {
			if (!workspaceChoice) return (failure = m["code.schedule_editor.err_workspace"]());
			if (makingWorkspace && !newPath.trim())
				return (failure = m["code.schedule_editor.err_new_dir"]());
		}
		if (!prompt.trim()) return (failure = m["code.schedule_editor.err_prompt"]());
		// Empty = no stopping criterion; `null` clears one on an edit.
		const capRaw = stopAfter == null ? "" : String(stopAfter).trim();
		if (capRaw !== "" && (!/^\d+$/.test(capRaw) || Number(capRaw) < 1 || Number(capRaw) > 100000)) {
			return (failure = m["code.schedule_editor.err_stop_after"]());
		}
		busy = true;
		try {
			if (kind === "chat") {
				const target =
					chatMode === "continue"
						? { mode: "continue", conversationId: chatConversationId }
						: {
								mode: "new",
								...(initial.conversationId ? { conversationId: initial.conversationId } : {}),
								...(chatModel ? { model: chatModel } : {}),
								...(chatStored.projectId && !initial.conversationId
									? { projectId: chatStored.projectId }
									: {}),
							};
				const input = {
					name: name.trim(),
					prompt: prompt.trim(),
					recurrence,
					timezone,
					enabled,
					maxOccurrences: capRaw === "" ? null : Number(capRaw),
					target,
				};
				const saved = editing
					? await updateSchedule(editing.id, input)
					: await createSchedule({ ...input, kind: "chat" });
				onsaved(saved.schedule);
				return;
			}
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
				maxOccurrences: capRaw === "" ? null : Number(capRaw),
				target,
			};
			const saved = editing ? await updateSchedule(editing.id, input) : await createSchedule(input);
			onsaved(saved.schedule);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.schedule_editor.could_not_save"]();
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
				<h2 class={s.TITLE}>
					{editing ? m["code.schedule_editor.title_edit"]() : m["code.schedule_editor.title_new"]()}
				</h2>
				<p class={s.SUBTITLE}>{m["code.schedule_editor.subtitle"]()}</p>
				<ScheduleCreatedBy createdBy={editing?.createdBy} class="mt-2" />
			</div>

			{#if failure}
				<div class="{s.ERROR} mb-4" role="alert">
					<p class="flex items-center gap-1.5 font-medium">
						<IconWarning class="size-4 shrink-0" />
						{m["code.schedule_editor.save_failed"]()}
					</p>
					<p class="mt-1 break-words">{failure}</p>
				</div>
			{/if}

			<label class={s.LABEL} for="sched-name">{m["code.schedule_editor.name"]()}</label>
			<input
				id="sched-name"
				class={s.INPUT}
				style="font-size: 16px;"
				maxlength={80}
				placeholder={m["code.schedule_editor.name_placeholder"]()}
				bind:value={name}
				disabled={busy}
			/>

			{#if !editing && agentsAllowed}
				<div class="mt-6" role="radiogroup" aria-label={m["code.schedule_editor.kind"]()}>
					<span class={s.LABEL}>{m["code.schedule_editor.kind"]()}</span>
					<div class="mt-1 flex flex-wrap gap-4 text-sm text-ink">
						<label class="flex items-center gap-2">
							<input
								type="radio"
								name="sched-kind"
								value="chat"
								bind:group={kind}
								disabled={busy}
								data-testid="kind-chat"
							/>
							{m["code.schedule_editor.kind_chat"]()}
						</label>
						<label class="flex items-center gap-2">
							<input
								type="radio"
								name="sched-kind"
								value="agent"
								bind:group={kind}
								disabled={busy}
								data-testid="kind-agent"
							/>
							{m["code.schedule_editor.kind_agent"]()}
						</label>
					</div>
				</div>
			{/if}

			{#if kind === "chat"}
				<h3 class="{s.SECTION_TITLE} mt-6">{m["code.schedule_editor.where"]()}</h3>
				<div role="radiogroup" class="space-y-2" aria-label={m["code.schedule_editor.where"]()}>
					<div class="flex items-start gap-2 text-sm text-ink">
						<input
							id="sched-mode-continue"
							type="radio"
							class="mt-1"
							name="sched-chat-mode"
							value="continue"
							bind:group={chatMode}
							disabled={busy}
							aria-describedby="sched-mode-continue-hint"
							data-testid="mode-continue"
						/>
						<div>
							<label for="sched-mode-continue" class="font-medium">
								{m["code.schedule_editor.mode_continue"]()}
							</label>
							<p id="sched-mode-continue-hint" class="text-xs text-ink-muted">
								{m["code.schedule_editor.mode_continue_hint"]()}
							</p>
						</div>
					</div>
					<div class="flex items-start gap-2 text-sm text-ink">
						<input
							id="sched-mode-new"
							type="radio"
							class="mt-1"
							name="sched-chat-mode"
							value="new"
							bind:group={chatMode}
							disabled={busy}
							aria-describedby="sched-mode-new-hint"
							data-testid="mode-new"
						/>
						<div>
							<label for="sched-mode-new" class="font-medium">
								{m["code.schedule_editor.mode_new"]()}
							</label>
							<p id="sched-mode-new-hint" class="text-xs text-ink-muted">
								{m["code.schedule_editor.mode_new_hint"]()}
							</p>
						</div>
					</div>
				</div>

				{#if chatMode === "continue"}
					<label class="{s.LABEL} mt-4" for="sched-chat">{m["code.schedule_editor.chat"]()}</label>
					<select
						id="sched-chat"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={chatConversationId}
						disabled={busy}
					>
						<option value="" disabled>{m["code.schedule_editor.choose_chat"]()}</option>
						{#each chatConversations as c (String(c.id))}
							<option value={String(c.id)}>{c.title}</option>
						{/each}
						{#if chatConversationId && !chatConversations.some((c) => String(c.id) === chatConversationId)}
							<option value={chatConversationId}>
								{editing?.targetLabel.replace(/^[^›]*›\s*/, "") ?? chatConversationId}
							</option>
						{/if}
					</select>
				{:else if templateChat}
					<p class={s.HINT}>
						{m["code.schedule_editor.same_as_chat"]({ title: templateChat.title })}
					</p>
				{:else}
					<label class="{s.LABEL} mt-4" for="sched-model">{m["code.schedule_editor.model"]()}</label
					>
					<select
						id="sched-model"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={chatModel}
						disabled={busy}
					>
						<option value="" disabled>{m["code.schedule_editor.choose_model"]()}</option>
						{#each chatModels.filter((x) => !x.unlisted) as model (model.id)}
							<option value={model.id}>{model.displayName ?? model.name ?? model.id}</option>
						{/each}
					</select>
				{/if}
				<p class={s.HINT} data-testid="chat-unattended-hint">
					{m["code.schedule_editor.chat_unattended"]()}
				</p>
			{:else}
				<h3 class="{s.SECTION_TITLE} mt-6">{m["code.schedule_editor.where"]()}</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-device">{m["code.schedule_editor.machine"]()}</label>
						<select
							id="sched-device"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={deviceId}
							onchange={onDeviceChange}
							disabled={busy}
						>
							<option value="" disabled>{m["code.schedule_editor.choose_machine"]()}</option>
							{#each pairedDevices as d (d.id)}
								<option value={d.id}
									>{m["code.schedule_editor.machine_option"]({
										name: d.name,
										state: d.online
											? m["code.schedule_editor.online"]()
											: m["code.schedule_editor.offline_state"](),
									})}</option
								>
							{/each}
						</select>
					</div>
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-workspace"
							>{m["code.schedule_editor.workspace"]()}</label
						>
						<select
							id="sched-workspace"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={workspaceChoice}
							onchange={onWorkspaceChange}
							disabled={busy || !deviceId}
						>
							<option value="" disabled>
								{loadingMachine
									? m["code.schedule_editor.loading"]()
									: m["code.schedule_editor.choose_workspace"]()}
							</option>
							{#each workspaces as w (w.id)}
								<option value={w.id}>{w.name}</option>
							{/each}
							{#if workspaceChoice && workspaceChoice !== NEW && !knownWorkspace}
								<option value={workspaceChoice}
									>{stored.labels?.workspace ?? workspaceChoice}</option
								>
							{/if}
							{#if online}
								<option value={NEW}>{m["code.schedule_editor.new_workspace"]()}</option>
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
							<label class={s.LABEL} for="sched-newpath"
								>{m["code.schedule_editor.new_dir"]()}</label
							>
							<input
								id="sched-newpath"
								class={s.INPUT}
								style="font-size: 16px;"
								placeholder={m["code.schedule_editor.new_dir_placeholder"]()}
								maxlength={1024}
								autocomplete="off"
								bind:value={newPath}
								oninput={() => scheduleSuggest(newPath)}
								disabled={busy}
							/>
							{#if suggestions.length > 0}
								<div
									role="listbox"
									aria-label={m["code.schedule_editor.matching_dirs"]()}
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
							<label class={s.LABEL} for="sched-newtitle"
								>{m["code.schedule_editor.new_title"]()}</label
							>
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
							{m["code.schedule_editor.new_hint"]()}
						</p>
					</div>
				{/if}

				<div class="mt-4 min-w-0">
					<label class={s.LABEL} for="sched-session">{m["code.schedule_editor.session"]()}</label>
					<select
						id="sched-session"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={sessionChoice}
						disabled={busy || makingWorkspace || !workspaceChoice}
					>
						<option value={NEW}>{m["code.schedule_editor.session_new"]()}</option>
						{#each sessions as session (session.id)}
							<option value={session.id}>{session.title}</option>
						{/each}
						{#if sessionChoice !== NEW && !sessions.some((x) => x.id === sessionChoice)}
							<option value={sessionChoice}>{stored.labels?.session ?? sessionChoice}</option>
						{/if}
					</select>
					<p class={s.HINT}>
						{sessionChoice === NEW
							? m["code.schedule_editor.session_new_hint"]()
							: m["code.schedule_editor.session_existing_hint"]()}
					</p>
				</div>

				<h3 class="{s.SECTION_TITLE} mt-6">{m["code.schedule_editor.how"]()}</h3>
				<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-mode">{m["code.schedule_editor.mode"]()}</label>
						<select
							id="sched-mode"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={modeId}
							disabled={busy || !deviceId}
						>
							<option value="">{m["code.schedule_editor.mode_default"]()}</option>
							{#each modes as mode (mode.id)}
								<option value={mode.id}>{mode.label}</option>
							{/each}
							{#if modeId && !modes.some((x) => x.id === modeId)}
								<option value={modeId}>{modeId}</option>
							{/if}
						</select>
					</div>
					<div class="min-w-0">
						<label class={s.LABEL} for="sched-model">{m["code.schedule_editor.model"]()}</label>
						<select
							id="sched-model"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={modelId}
							disabled={busy || !deviceId}
						>
							<option value="">{m["code.schedule_editor.model_default"]()}</option>
							{#each models as model (model.id)}
								<option value={model.id}>{model.label}</option>
							{/each}
							{#if modelId && !models.some((x) => x.id === modelId)}
								<option value={modelId}>{modelId}</option>
							{/if}
						</select>
					</div>
				</div>

				<div class="mt-4">
					<span class={s.LABEL} id="sched-perm-label">{m["code.schedule_editor.permission"]()}</span
					>
					<div class="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="sched-perm-label">
						{#each [["deny", m["code.permission_mode.plan"]()], ["ask", m["code.permission_mode.ask"]()], ["allow", m["code.permission_mode.allow"]()]] as const as [value, label] (value)}
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
							{m["code.schedule_editor.ask_warning"]()}
						</p>
					{:else if permissionMode === "allow"}
						<p class={s.HINT}>{m["code.schedule_editor.allow_hint"]()}</p>
					{:else}
						<p class={s.HINT}>{m["code.schedule_editor.plan_hint"]()}</p>
					{/if}
				</div>

				<div class="mt-4" data-testid="coordination-options">
					<span class={s.LABEL} id="sched-coord-label">{m["code.schedule_editor.others"]()}</span>
					<div class="space-y-2" role="group" aria-labelledby="sched-coord-label">
						<label class="flex items-start gap-2 text-sm text-ink">
							<input type="checkbox" class="mt-1" bind:checked={canMessage} disabled={busy} />
							<span>{m["code.schedule_editor.can_message"]()}</span>
						</label>
						<label class="flex items-start gap-2 text-sm text-ink">
							<input type="checkbox" class="mt-1" bind:checked={canSpawn} disabled={busy} />
							<span>{m["code.schedule_editor.can_spawn"]()}</span>
						</label>
					</div>
					<p class={s.HINT}>{m["code.schedule_editor.others_hint"]()}</p>
					{#if coordination && !coordination.ok}
						<p class="{s.NOTICE} mt-2" data-testid="coordination-unsupported">
							{coordination.reason === "too-old"
								? m["code.schedule_editor.too_old"]()
								: m["code.schedule_editor.tools_off"]()}
						</p>
					{:else if coordinationCeiling}
						<p class="{s.NOTICE} mt-2" data-testid="coordination-ceiling">{coordinationCeiling}</p>
					{/if}
				</div>
			{/if}

			<label class="{s.LABEL} mt-6" for="sched-prompt">{m["code.schedule_editor.prompt"]()}</label>
			<textarea
				id="sched-prompt"
				class="{s.INPUT} min-h-28"
				style="font-size: 16px;"
				maxlength={8000}
				placeholder={m["code.schedule_editor.prompt_placeholder"]()}
				bind:value={prompt}
				disabled={busy}
			></textarea>

			<h3 class="{s.SECTION_TITLE} mt-6">{m["code.schedule_editor.when"]()}</h3>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-preset">{m["code.schedule_editor.repeats"]()}</label>
					<select
						id="sched-preset"
						class={s.INPUT}
						style="font-size: 16px;"
						bind:value={preset}
						disabled={busy}
					>
						<option value="hours">{m["code.schedule_editor.preset_hours"]()}</option>
						<option value="daily">{m["code.schedule_editor.preset_daily"]()}</option>
						<option value="weekdays">{m["code.schedule_editor.preset_weekdays"]()}</option>
						<option value="weekly">{m["code.schedule_editor.preset_weekly"]()}</option>
						<option value="cron">{m["code.schedule_editor.preset_cron"]()}</option>
					</select>
				</div>
				<div class="min-w-0">
					{#if preset === "hours"}
						<label class={s.LABEL} for="sched-hours"
							>{m["code.schedule_editor.every_hours"]()}</label
						>
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
						<label class={s.LABEL} for="sched-cron">{m["code.schedule_editor.cron"]()}</label>
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
						<label class={s.LABEL} for="sched-at">{m["code.schedule_editor.at"]()}</label>
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
						<label class={s.LABEL} for="sched-day">{m["code.schedule_editor.on"]()}</label>
						<select
							id="sched-day"
							class={s.INPUT}
							style="font-size: 16px;"
							bind:value={weekday}
							disabled={busy}
						>
							{#each weekdayNames() as day, index (day)}
								<option value={index}>{day}</option>
							{/each}
						</select>
					</div>
				{/if}
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-tz">{m["code.schedule_editor.timezone"]()}</label>
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
				<div class="min-w-0">
					<label class={s.LABEL} for="sched-stopafter"
						>{m["code.schedule_editor.stop_after"]()}</label
					>
					<input
						id="sched-stopafter"
						class={s.INPUT}
						style="font-size: 16px;"
						type="number"
						min="1"
						max="100000"
						step="1"
						placeholder={m["code.schedule_editor.for_ever"]()}
						autocomplete="off"
						bind:value={stopAfter}
						disabled={busy}
					/>
				</div>
			</div>
			{#if preset === "cron"}
				<p class={s.HINT}>{m["code.schedule_editor.cron_hint"]()}</p>
			{/if}
			<p class={s.HINT} data-testid="stopafter-hint">
				{m["code.schedule_editor.stop_after_hint"]()}
			</p>

			<div class="mt-3 rounded-lg bg-sunken p-3" data-testid="schedule-preview" aria-live="polite">
				{#if preview?.ok}
					<p class="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink">
						<IconTime class="size-3.5" />
						{m["code.schedule_editor.next_runs"]({ timezone })}
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
					<p class="text-xs text-ink-faint">{m["code.schedule_editor.working_out"]()}</p>
				{/if}
			</div>

			<label class="mt-4 flex items-center gap-2 text-sm text-ink">
				<input type="checkbox" bind:checked={enabled} disabled={busy} />
				{m["code.schedule_editor.enabled"]()}
			</label>

			<div class="mt-6 flex flex-wrap justify-end gap-2">
				<button type="button" class={s.SECONDARY} onclick={oncancel} disabled={busy}>
					{m["code.common.cancel"]()}
				</button>
				<button type="submit" class={s.PRIMARY} disabled={busy}>
					{busy
						? m["code.schedule_editor.saving"]()
						: editing
							? m["code.schedule_editor.save_changes"]()
							: m["code.schedule_editor.create"]()}
				</button>
			</div>
		</form>
	</div>
</div>
