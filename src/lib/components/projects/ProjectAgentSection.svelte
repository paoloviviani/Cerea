<!--
	"Agent workspace": the signed-in user's own default target for the coding
	sessions their chats in this project start (ADR 0106 §3).

	Personal by design: a machine is one user's, and a shared project's members
	each keep their own profile, so this never rides the project's Save. It has
	its own Save and Remove, and talks to `/api/v2/projects/[id]/agent-profile`
	(the caller's own profile; the server checks the machine and workspace are
	theirs and says why when not).

	The machines come from the /code client's shared device list, the workspaces
	from the chosen machine. Mode and model are not offered: the /code UI has no
	reusable picker for them (the schedule editor draws its own selects), and a
	stored value is carried through untouched while the machine is unchanged.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import * as s from "$lib/components/overlay/styles";
	import { listWorkspaces, loadCodeStatus } from "$lib/codeApi";
	import { codeDeviceList, useCodeDevicePoll } from "$lib/stores/codeDeviceList.svelte";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import CodeReauthCard from "$lib/components/code/CodeReauthCard.svelte";
	import type { CodeWorkspace } from "$lib/types/CodeAgent";
	import type { PermissionMode } from "$lib/types/machineProtocol";
	import type { ProjectAgentProfile, ProjectAgentProfileInput } from "$lib/types/AgentSession";
	import IconShieldX from "~icons/carbon/security";
	import IconShieldQuestion from "~icons/carbon/help";
	import IconShieldCheck from "~icons/carbon/checkmark-outline";

	interface Props {
		projectId: string;
	}

	let { projectId }: Props = $props();

	const ENDPOINT = $derived(`${base}/api/v2/projects/${projectId}/agent-profile`);

	let loading = $state(true);
	let saved = $state<ProjectAgentProfile | null>(null);
	let deviceId = $state("");
	let workspaceId = $state("");
	let permissionMode = $state<PermissionMode>("ask");
	let workspaces = $state<CodeWorkspace[]>([]);
	let loadingWorkspaces = $state(false);
	let workspaceNote = $state<string | null>(null);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let notice = $state<string | null>(null);

	const pairedDevices = $derived(codeDeviceList.devices.filter((d) => d.status === "paired"));
	const device = $derived(pairedDevices.find((d) => d.id === deviceId));
	const dirty = $derived(
		!saved ||
			saved.deviceId !== deviceId ||
			saved.workspaceId !== workspaceId ||
			saved.permissionMode !== permissionMode
	);
	const canSave = $derived(!busy && !!deviceId && !!workspaceId && dirty);
	/** The stored workspace's name when the machine cannot list it now. */
	const savedWorkspace = $derived(
		saved && saved.deviceId === deviceId && saved.workspaceId === workspaceId
			? saved.labels.workspace
			: null
	);
	const noMachines = $derived(
		!loading && !codeDeviceList.loading && !codeReauth.required && pairedDevices.length === 0
	);

	const PERMISSIONS: Array<{
		mode: PermissionMode;
		label: () => string;
		title: () => string;
		icon: typeof IconShieldX;
	}> = [
		{
			mode: "deny",
			label: m["code.permission_mode.plan"],
			title: m["code.composer.plan_title"],
			icon: IconShieldX,
		},
		{
			mode: "ask",
			label: m["code.permission_mode.ask"],
			title: m["code.composer.ask_title"],
			icon: IconShieldQuestion,
		},
		{
			mode: "allow",
			label: m["code.permission_mode.allow"],
			title: m["code.composer.allow_title"],
			icon: IconShieldCheck,
		},
	];

	async function problem(response: Response, fallback: string): Promise<Error> {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		return new Error(parsed?.message ?? fallback);
	}

	function adopt(profile: ProjectAgentProfile | null) {
		saved = profile;
		deviceId = profile?.deviceId ?? "";
		workspaceId = profile?.workspaceId ?? "";
		permissionMode = profile?.permissionMode ?? "ask";
	}

	/** What the chosen machine has. An offline one has nothing to list. */
	async function loadMachine(id: string) {
		workspaces = [];
		workspaceNote = null;
		if (!id) return;
		const row = codeDeviceList.devices.find((d) => d.id === id);
		if (!row) return;
		if (!row.online) {
			workspaceNote = m["projects.agent.offline_note"]({ name: row.name });
			return;
		}
		loadingWorkspaces = true;
		try {
			const { workspaces: list } = await listWorkspaces(id);
			if (deviceId !== id) return;
			workspaces = list;
		} catch (err) {
			if (deviceId === id)
				workspaceNote =
					err instanceof Error && err.message
						? err.message
						: m["projects.agent.workspaces_failed"]();
		} finally {
			if (deviceId === id) loadingWorkspaces = false;
		}
	}

	onMount(() => {
		void loadCodeStatus();
		const stopPoll = useCodeDevicePoll();
		void (async () => {
			try {
				const response = await fetch(ENDPOINT);
				if (response.ok) {
					const body = (await response.json().catch(() => null)) as {
						data?: ProjectAgentProfile | null;
					} | null;
					adopt(body?.data ?? null);
				} else if (response.status !== 404) {
					throw await problem(response, m["projects.agent.error_load"]());
				}
			} catch (err) {
				failure = err instanceof Error ? err.message : m["projects.agent.error_load"]();
			} finally {
				loading = false;
			}
		})();
		return stopPoll;
	});

	// Re-read the workspaces when the machine changes or comes online.
	$effect(() => {
		const id = deviceId;
		void device?.online;
		void loadMachine(id);
	});

	function onDeviceChange() {
		workspaceId = "";
		notice = null;
	}

	async function save() {
		if (!canSave) return;
		busy = true;
		failure = null;
		notice = null;
		// Mode and model are not edited here: keep what is stored while the
		// target is the same machine, drop them when it moved.
		const keep = saved && saved.deviceId === deviceId ? saved : null;
		const input: ProjectAgentProfileInput = {
			deviceId,
			workspaceId,
			permissionMode,
			...(keep?.modeId ? { modeId: keep.modeId } : {}),
			...(keep?.modelId ? { modelId: keep.modelId } : {}),
		};
		try {
			const response = await fetch(ENDPOINT, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!response.ok) throw await problem(response, m["projects.agent.error_save"]());
			const body = (await response.json().catch(() => null)) as {
				data?: ProjectAgentProfile;
			} | null;
			if (body?.data) adopt(body.data);
			notice = m["projects.agent.saved"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.agent.error_save"]();
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (busy || !saved) return;
		busy = true;
		failure = null;
		notice = null;
		try {
			const response = await fetch(ENDPOINT, { method: "DELETE" });
			if (!response.ok && response.status !== 404) {
				throw await problem(response, m["projects.agent.error_save"]());
			}
			adopt(null);
			notice = m["projects.agent.removed"]();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["projects.agent.error_save"]();
		} finally {
			busy = false;
		}
	}
</script>

<div data-testid="project-agent" class="space-y-3">
	<p class="text-xs text-ink-muted">{m["projects.agent.description"]()}</p>
	<p class="text-xs font-medium text-ink-muted" data-testid="project-agent-personal">
		{m["projects.agent.only_you"]()}
	</p>

	{#if loading}
		<p class="text-sm text-ink-muted">{m["projects.agent.workspace_loading"]()}</p>
	{:else if codeReauth.required}
		<CodeReauthCard compact />
	{:else if noMachines}
		<div class={s.TIPS} data-testid="project-agent-no-machines">
			<p class="text-xs text-ink-muted">{m["projects.agent.no_machines"]()}</p>
			<a href="{base}/code" class="mt-2 inline-block text-xs text-accent">
				{m["projects.agent.no_machines_link"]()}
			</a>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-3">
			<div class="min-w-0">
				<label class={s.LABEL} for="project-agent-device">{m["projects.agent.machine"]()}</label>
				<select
					id="project-agent-device"
					class={s.INPUT}
					style="font-size: 16px;"
					bind:value={deviceId}
					onchange={onDeviceChange}
					disabled={busy}
				>
					<option value="" disabled>{m["projects.agent.machine_choose"]()}</option>
					{#each pairedDevices as d (d.id)}
						<option value={d.id}
							>{m["projects.agent.machine_option"]({
								name: d.name,
								state: d.online
									? m["projects.agent.machine_online"]()
									: m["projects.agent.machine_offline"](),
							})}</option
						>
					{/each}
					{#if deviceId && !device && saved}
						<option value={deviceId}>{saved.labels.device}</option>
					{/if}
				</select>
			</div>
			<div class="min-w-0">
				<label class={s.LABEL} for="project-agent-workspace"
					>{m["projects.agent.workspace"]()}</label
				>
				<select
					id="project-agent-workspace"
					class={s.INPUT}
					style="font-size: 16px;"
					bind:value={workspaceId}
					disabled={busy || !deviceId}
				>
					<option value="" disabled>
						{loadingWorkspaces
							? m["projects.agent.workspace_loading"]()
							: m["projects.agent.workspace_choose"]()}
					</option>
					{#each workspaces as w (w.id)}
						<option value={w.id}>{w.name}</option>
					{/each}
					{#if workspaceId && savedWorkspace && !workspaces.some((w) => w.id === workspaceId)}
						<option value={workspaceId}>{savedWorkspace}</option>
					{/if}
				</select>
			</div>
		</div>
		{#if workspaceNote}
			<p class="text-xs text-warn" data-testid="project-agent-note">{workspaceNote}</p>
		{/if}

		<div>
			<span class={s.LABEL} id="project-agent-permission">{m["projects.agent.permission"]()}</span>
			<div
				role="radiogroup"
				aria-labelledby="project-agent-permission"
				class="flex flex-wrap gap-2"
			>
				{#each PERMISSIONS as p (p.mode)}
					<button
						type="button"
						role="radio"
						aria-checked={permissionMode === p.mode}
						class={permissionMode === p.mode ? s.PRIMARY : s.SECONDARY}
						title={p.title()}
						disabled={busy}
						onclick={() => (permissionMode = p.mode)}
					>
						<p.icon class="size-4" aria-hidden="true" />
						{p.label()}
					</button>
				{/each}
			</div>
			<p class={s.HINT}>{m["projects.agent.permission_hint"]()}</p>
		</div>

		{#if failure}
			<p class={s.ERROR} role="alert" data-testid="project-agent-error">{failure}</p>
		{/if}
		{#if notice}
			<p class="text-xs text-ok" role="status">{notice}</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<button type="button" class={s.PRIMARY} disabled={!canSave} onclick={save}>
				{m["projects.agent.save"]()}
			</button>
			{#if saved}
				<button type="button" class={s.SECONDARY} disabled={busy} onclick={remove}>
					{m["projects.agent.remove"]()}
				</button>
			{/if}
		</div>
	{/if}

	{#if loading === false && failure && (codeReauth.required || noMachines)}
		<p class={s.ERROR} role="alert">{failure}</p>
	{/if}
</div>
