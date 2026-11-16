<!--
	The workspace screen: what opens when a workspace is clicked in the Agents
	panel (`?device=&ws=`, no `agent`). It needs no session: a **New session**
	button, the workspace's sessions, and the **Terminal** and **Files** panels
	at the top right, the same components a session's header opens, rooted at
	the workspace (terminal cwd, file root).

	Both panels are machine ops scoped by workspace path, never by session, so
	nothing here asks for one. The header is the session view's own
	(AgentHeaderRow): on a phone the app's top bar carries the name and one
	Panels button that opens the sheet, exactly as in a session. The offers
	follow the capabilities: a panel the deployment, this galopin or the
	machine's policy does not allow is not shown at all (a session's header
	shows it disabled with the fix; here the screen has nothing to explain).
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { untrack } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import IconAdd from "~icons/carbon/add";
	import AgentHeaderRow, { type PaneId, type PaneItem } from "./AgentHeaderRow.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import CodeFiles from "./CodeFiles.svelte";
	import CodeTerminals from "./CodeTerminals.svelte";
	import SidePane from "$lib/components/chat/SidePane.svelte";
	import { listWorkspaces, listWorkspaceAgents } from "$lib/codeApi";
	import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import type { CodeAgentSession, CodeTurnState, CodeWorkspace } from "$lib/types/CodeAgent";
	import { agentDisplayTitle } from "$lib/utils/codeAgentTitle";
	import { workspaceLabel } from "$lib/utils/codeSubagents";
	import { fileSaveBlock, fileUploadAllowed } from "$lib/utils/codeFiles";
	import { formatCompactAge } from "$lib/utils/relativeTime";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		workspaceId: string;
	}

	let { deviceId, workspaceId }: Props = $props();

	const device = $derived(codeDeviceList.devices.find((d) => d.id === deviceId));
	const offline = $derived(device?.online === false);

	let workspace = $state<CodeWorkspace | null | undefined>(undefined);
	let agents = $state<CodeAgentSession[] | null>(null);
	let failure = $state<string | null>(null);
	let dialogOpen = $state(false);

	// Re-read on mount and when the machine comes back; an offline machine is
	// never asked (the session view's own rule: no 502 on every tick).
	$effect(() => {
		if (offline) return;
		void deviceId;
		void workspaceId;
		untrack(() => void load());
	});

	async function load() {
		failure = null;
		try {
			const [list, sessions] = await Promise.all([
				listWorkspaces(deviceId),
				listWorkspaceAgents(deviceId, workspaceId),
			]);
			workspace = list.workspaces.find((w) => w.id === workspaceId) ?? null;
			agents = sessions.agents.filter((a) => !a.parentId);
		} catch (err) {
			failure = err instanceof Error ? err.message : m["code.workspace.failed"]();
		}
	}

	const sorted = $derived(
		[...(agents ?? [])].sort((a, b) =>
			a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
		)
	);
	const label = $derived(workspace ? workspaceLabel(workspace) : "");

	// The offers: the deployment switch, this galopin and the machine's policy.
	const filesOffered = $derived(
		page.data.codeFilesEnabled === true &&
			device?.machine?.capabilities.files === true &&
			device?.policy?.files !== "off"
	);
	const terminalOffered = $derived(
		page.data.codeTerminalEnabled === true &&
			device?.machine?.capabilities.terminal === true &&
			device?.policy?.terminal === "allowed"
	);
	const saveBlocked = $derived(fileSaveBlock(page.data.codeFileWriteEnabled === true, device));

	// The screen owns the side pane: whatever a previous surface left open is
	// not this workspace's content.
	$effect(() => {
		sidePane.reset();
		return () => sidePane.reset();
	});

	const items = $derived.by<PaneItem[]>(() => {
		const out: PaneItem[] = [];
		if (!workspace || offline) return out;
		if (terminalOffered) {
			out.push({
				id: "terminal",
				word: m["code.view.terminal"](),
				label: m["code.view.terminal"](),
				title: m["code.view.terminal_title"](),
				pressed: sidePane.open && sidePane.view === "terminal",
			});
		}
		if (filesOffered) {
			out.push({
				id: "files",
				word: m["code.view.files"](),
				label: m["code.view.files"](),
				title: m["code.view.files_title"](),
				pressed: sidePane.open && sidePane.view === "files",
			});
		}
		return out;
	});

	function selectPane(id: PaneId) {
		if (id === "files") sidePane.toggleFiles();
		else if (id === "terminal") sidePane.toggleTerminal();
	}

	const STATES: Record<CodeTurnState, () => string> = {
		idle: m["code.view.state.idle"],
		running: m["code.view.state.running"],
		"waiting-permission": m["code.view.state.waiting_permission"],
		done: m["code.view.state.done"],
		error: m["code.view.state.error"],
	};
	const DOT: Record<CodeTurnState, string> = {
		done: "bg-green-500",
		running: "animate-pulse bg-blue-500",
		"waiting-permission": "bg-amber-500",
		error: "bg-red-500",
		idle: "bg-gray-400",
	};
	const href = (agent: CodeAgentSession) =>
		`${base}/code?device=${deviceId}&ws=${workspaceId}&agent=${agent.id}`;
</script>

<div class="pointer-events-none flex h-full min-h-0 flex-1 flex-col" data-testid="workspace-screen">
	<div class="pointer-events-auto flex flex-col gap-0.5 px-4 pt-3 pb-2 max-md:py-0">
		<AgentHeaderRow
			name={label}
			path={workspace?.path}
			turnState={null}
			stateLabel=""
			{items}
			onselect={selectPane}
		/>
	</div>

	<div class="pointer-events-none flex min-h-0 flex-1">
		<div
			class="pointer-events-auto scrollbar-custom min-w-0 flex-1 overflow-y-auto px-4 pt-2 pb-6"
			data-testid="workspace-body"
		>
			<div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
				{#if workspace === null}
					<p class="text-sm text-ink-muted" data-testid="workspace-not-found">
						{m["code.workspace.not_found"]()}
					</p>
				{:else}
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
						<div class="min-w-0 flex-1">
							{#if workspace?.path}
								<p class="text-xs break-all text-ink-muted" data-testid="workspace-path">
									{workspace.path}
								</p>
							{:else}
								<p class="text-xs text-ink-faint">{m["code.workspace.loading"]()}</p>
							{/if}
						</div>
						<button
							type="button"
							class={s.PRIMARY}
							data-testid="workspace-new-session"
							disabled={!workspace || offline}
							onclick={() => (dialogOpen = true)}
						>
							<IconAdd class="size-4" />
							{m["code.nav.new_session"]()}
						</button>
					</div>

					{#if offline}
						<p
							class="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"
							data-testid="workspace-offline"
						>
							{m["code.workspace.offline"]()}
						</p>
					{:else if failure}
						<div class={s.ERROR}>{failure}</div>
					{:else}
						<section aria-labelledby="workspace-sessions-title">
							<h2
								id="workspace-sessions-title"
								class="mb-1 text-xs font-medium tracking-wide text-ink-muted uppercase"
							>
								{m["code.workspace.sessions"]()}
							</h2>
							{#if agents === null}
								<p class="text-xs text-ink-faint">{m["code.workspace.loading"]()}</p>
							{:else if sorted.length === 0}
								<p class="text-xs text-ink-muted" data-testid="workspace-no-sessions">
									{m["code.workspace.no_sessions"]()}
								</p>
							{:else}
								<ul class="flex flex-col" data-testid="workspace-sessions">
									{#each sorted as agent (agent.id)}
										{@const age = formatCompactAge(agent.updatedAt)}
										<li>
											<a
												href={href(agent)}
												class="flex min-h-11 items-center gap-2 rounded-lg px-2 py-2 text-sm text-ink hover:bg-gray-50 dark:hover:bg-gray-800"
												data-testid="workspace-session"
											>
												<span
													class="size-2 shrink-0 rounded-full {DOT[agent.state]}"
													role="img"
													aria-label={STATES[agent.state]()}
													title={STATES[agent.state]()}
												></span>
												<span class="min-w-0 flex-1 truncate">
													{agentDisplayTitle(agent.title, workspace, m["code.nav.new_session"]())}
												</span>
												{#if age}<span class="shrink-0 text-xs text-ink-faint">{age}</span>{/if}
											</a>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/if}
				{/if}
			</div>
		</div>

		{#if workspace && sidePane.open && sidePane.view === "files" && filesOffered}
			<SidePane label={m["code.workspace.files_label"]()} title={m["code.view.files"]()}>
				<CodeFiles
					{deviceId}
					{workspaceId}
					writable={saveBlocked === null}
					{saveBlocked}
					uploadable={fileUploadAllowed(saveBlocked, device)}
				/>
			</SidePane>
		{:else if workspace && sidePane.open && sidePane.view === "terminal" && terminalOffered}
			<SidePane label={m["code.workspace.terminal_label"]()} title={m["code.view.terminal"]()}>
				<CodeTerminals {deviceId} {workspaceId} />
			</SidePane>
		{/if}
	</div>
</div>

{#if dialogOpen && workspace}
	<AgentDialog
		{deviceId}
		{workspace}
		onclose={() => (dialogOpen = false)}
		oncreated={(agent) => {
			dialogOpen = false;
			void goto(`${base}/code?device=${deviceId}&ws=${workspaceId}&agent=${agent.id}`, {
				keepFocus: true,
			});
		}}
	/>
{/if}
