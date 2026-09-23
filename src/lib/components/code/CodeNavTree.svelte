<!--
	The sidebar's agents panel: paired devices, each with its workspaces and
	their sessions, plus every action the person needs — pair, add a
	workspace, start an agent, revoke, archive a session, rename or archive
	a workspace. Nothing here talks to the daemon: rows are Cerea's pairing
	records and proxy calls (`codeApi`), and an agent row is only ever an
	address (`/code?device=&ws=&agent=`).

	All mutations live here, not in the agent pane: one owner for the
	device list means a pair, a revoke or a creation updates the tree the
	person is looking at, wherever they opened the dialog from.

	The two removals confirm first, then ask the daemon and redraw the
	acted-on device's subtree from its answer — never an optimistic splice,
	because the daemon owns the listings an archived row disappears from.
	When the row that went is the one open in the address, the person is
	navigated away: an archived session or workspace is not one the panel
	can still show. A creation navigates the other way: the workspace or
	session just made is the one the person is dropped on, so the panel
	lands where the action put them.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { DropdownMenu } from "bits-ui";
	import IconAdd from "~icons/carbon/add";
	import IconLaptop from "~icons/carbon/laptop";
	import IconFolder from "~icons/carbon/folder";
	import IconCode from "~icons/carbon/code";
	import IconRenew from "~icons/carbon/renew";
	import IconTrash from "~icons/carbon/trash-can";
	import IconKebab from "~icons/carbon/overflow-menu-vertical";
	import IconEdit from "~icons/carbon/edit";
	import IconWarning from "~icons/carbon/warning-filled";
	import {
		listDevices,
		listWorkspaces,
		listAgents,
		revokeDevice,
		archiveAgent,
		archiveWorkspace,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import WorkspaceDialog from "./WorkspaceDialog.svelte";
	import WorkspaceRenameDialog from "./WorkspaceRenameDialog.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";

	/** One paired device's live subtree, read through the proxy. */
	interface DeviceSubtree {
		workspaces: CodeWorkspace[];
		agents: CodeAgentSession[];
		/** The daemon behind this pairing could not be reached. */
		off: boolean;
	}

	let devices = $state<CodeDeviceView[]>([]);
	let trees = $state<Record<string, DeviceSubtree>>({});
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let pairingOpen = $state(false);
	let workspaceDialogFor = $state<string | null>(null);
	let agentDialogFor = $state<CodeWorkspace | null>(null);
	/** The workspace whose rename dialog is open, with its device. */
	let renameFor = $state<{ device: CodeDeviceView; workspace: CodeWorkspace } | null>(null);
	/** A removal waiting for its confirmation: which row, on which device. */
	let confirmRequest = $state<
		| { kind: "agent"; device: CodeDeviceView; agent: CodeAgentSession }
		| { kind: "workspace"; device: CodeDeviceView; workspace: CodeWorkspace }
		| null
	>(null);

	const selectedDeviceId = $derived(page.url.searchParams.get("device"));
	const selectedWorkspaceId = $derived(page.url.searchParams.get("ws"));
	const selectedAgentId = $derived(page.url.searchParams.get("agent"));

	function agentsOf(tree: DeviceSubtree | undefined, workspaceId: string): CodeAgentSession[] {
		return (tree?.agents ?? []).filter((agent) => agent.workspaceId === workspaceId);
	}

	async function loadTree(deviceId: string): Promise<DeviceSubtree> {
		try {
			const [{ workspaces }, { agents }] = await Promise.all([
				listWorkspaces(deviceId),
				listAgents(deviceId),
			]);
			return { workspaces, agents, off: false };
		} catch {
			return { workspaces: [], agents: [], off: true };
		}
	}

	async function load() {
		failure = null;
		try {
			devices = (await listDevices()).devices;
			const paired = devices.filter((d) => d.status === "paired");
			const settled = await Promise.all(paired.map((d) => loadTree(d.id)));
			trees = Object.fromEntries(paired.map((d, i) => [d.id, settled[i]]));
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load paired devices.";
		} finally {
			loading = false;
		}
	}

	async function reloadDevice(deviceId: string) {
		trees = { ...trees, [deviceId]: await loadTree(deviceId) };
	}

	onMount(() => void load());

	async function handleRevoke(id: string) {
		try {
			await revokeDevice(id);
			devices = devices.filter((d) => d.id !== id);
			const rest = { ...trees };
			delete rest[id];
			trees = rest;
			if (selectedDeviceId === id) {
				void goto(`${base}/code`, { keepFocus: true });
			}
		} catch {
			failure = "Could not revoke the device.";
		}
	}

	/**
	 * Archive one session. The daemon answers first, the person leaves the
	 * archived session's address second, and the tree is re-read last — the
	 * daemon's listings, not a local guess, decide what the tree shows.
	 * Throw on failure: the confirm dialog holds the question open with the
	 * daemon's own words, and nothing here pretends it worked.
	 */
	async function handleArchiveAgent(device: CodeDeviceView, agent: CodeAgentSession) {
		await archiveAgent(device.id, agent.id);
		if (selectedDeviceId === device.id && selectedAgentId === agent.id) {
			void goto(`${base}/code?device=${device.id}&ws=${agent.workspaceId}`, { keepFocus: true });
		}
		await reloadDevice(device.id);
	}

	/** Whether the open address lives on a workspace that just went — its
	 * own row, or one of the sessions that were archived with it. */
	function addressOnWorkspace(deviceId: string, workspaceId: string): boolean {
		if (selectedDeviceId !== deviceId) return false;
		if (selectedWorkspaceId === workspaceId) return true;
		const agent = trees[deviceId]?.agents.find((a) => a.id === selectedAgentId);
		return agent?.workspaceId === workspaceId;
	}

	async function handleArchiveWorkspace(device: CodeDeviceView, workspace: CodeWorkspace) {
		await archiveWorkspace(device.id, workspace.id);
		if (addressOnWorkspace(device.id, workspace.id)) {
			void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
		}
		await reloadDevice(device.id);
	}

	function handlePaired(device: CodeDeviceView) {
		devices = [device, ...devices.filter((d) => d.id !== device.id)];
		void reloadDevice(device.id);
		void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
	}

	function row(active: boolean): string {
		return `flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-left text-sm ${
			active
				? "bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-white"
				: "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
		}`;
	}
</script>

<div class="flex flex-col gap-px">
	<div class="flex items-center justify-between px-2 pt-1">
		<span class="text-xs font-semibold text-gray-400 dark:text-gray-500">Devices</span>
		<button
			class="flex h-6 items-center gap-1 rounded-lg px-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
			title="Pair a new device"
			onclick={() => (pairingOpen = true)}
		>
			<IconAdd class="size-3.5" />
			Pair
		</button>
	</div>

	{#if loading}
		<p class="flex items-center gap-2 px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
			<IconRenew class="size-4 animate-spin" />
			Loading paired devices…
		</p>
	{:else if failure}
		<div
			class="mx-2 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
		>
			<p class="flex items-center gap-1.5 font-medium">
				<IconWarning class="size-3.5" />
				Could not load devices
			</p>
			<button
				class="mt-1 font-medium underline underline-offset-2"
				onclick={() => {
					loading = true;
					void load();
				}}
			>
				Retry
			</button>
		</div>
	{:else if devices.length === 0}
		<div class="px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
			<p class="flex items-center gap-1.5">
				<IconLaptop class="size-4 shrink-0" />
				No paired devices
			</p>
			<button
				class="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-2 text-sm font-medium text-white hover:bg-blue-700"
				onclick={() => (pairingOpen = true)}
			>
				<IconAdd class="size-4" />
				Pair a device
			</button>
		</div>
	{:else}
		{#each devices as device (device.id)}
			{@const tree = trees[device.id]}
			{@const deviceActive = device.id === selectedDeviceId}
			<div>
				<div class="flex items-center gap-1 pr-1">
					<a
						href="{base}/code?device={device.id}"
						class="min-w-0 flex-1 {row(deviceActive && !selectedAgentId)}"
						title={device.name}
					>
						<IconLaptop class="size-3.5 shrink-0" />
						<span class="min-w-0 flex-1 truncate">{device.name}</span>
						<span
							class="shrink-0 rounded-full px-1.5 text-[.65rem] {device.status === 'paired'
								? 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-300'
								: 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-300'}"
						>
							{device.status}
						</span>
					</a>
					<button
						class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
						title="Remove this pairing"
						onclick={() => void handleRevoke(device.id)}
					>
						<IconTrash class="size-3.5" />
					</button>
				</div>
				{#if device.status === "pending" && device.pairingCode}
					<p class="pl-6 text-xs text-gray-400 dark:text-gray-500">
						code <span class="font-mono font-semibold text-gray-600 dark:text-gray-300">
							{device.pairingCode}
						</span>
					</p>
				{/if}
				{#if device.status === "paired"}
					{#if tree?.off}
						<p class="py-0.5 pl-6 text-xs text-gray-400 dark:text-gray-500">
							Daemon not connected.
						</p>
					{:else if tree && tree.workspaces.length === 0}
						<button
							class="flex items-center gap-1.5 py-0.5 pl-6 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
							onclick={() => (workspaceDialogFor = device.id)}
						>
							<IconAdd class="size-3" />
							Add workspace
						</button>
					{:else}
						{#each tree?.workspaces ?? [] as ws (ws.id)}
							{@const wsActive = ws.id === selectedWorkspaceId && deviceActive}
							<div>
								<div class="flex items-center gap-1 pr-1">
									<span class="min-w-0 flex-1 {row(wsActive && !selectedAgentId)} pl-4">
										<IconFolder class="size-3 shrink-0" />
										<span class="min-w-0 flex-1 truncate">{ws.name}</span>
									</span>
									<button
										class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
										title="Start a coding session in this workspace"
										onclick={() => (agentDialogFor = ws)}
									>
										<IconAdd class="size-3.5" />
									</button>
									<!-- The workspace's actions live in one kebab, not a
								     row of icons: rename and archive are occasional,
								     and a bare trash can was the only visible offer
								     for both. -->
									<DropdownMenu.Root>
										<DropdownMenu.Trigger
											class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
											title="Workspace actions"
										>
											<IconKebab class="size-3.5" />
										</DropdownMenu.Trigger>
										<DropdownMenu.Portal>
											<DropdownMenu.Content
												class="z-50 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
												side="bottom"
												align="end"
												sideOffset={6}
												trapFocus={false}
												onCloseAutoFocus={(e) => e.preventDefault()}
												interactOutsideBehavior="defer-otherwise-close"
											>
												<DropdownMenu.Item
													class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
													onSelect={() => (renameFor = { device, workspace: ws })}
												>
													<IconEdit class="size-4 opacity-90 dark:opacity-80" />
													Rename
												</DropdownMenu.Item>
												<DropdownMenu.Item
													class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
													onSelect={() =>
														(confirmRequest = { kind: "workspace", device, workspace: ws })}
												>
													<IconTrash class="size-4 opacity-90 dark:opacity-80" />
													Archive
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Portal>
									</DropdownMenu.Root>
								</div>
								{#each agentsOf(tree, ws.id) as agent (agent.id)}
									{@const agentActive = agent.id === selectedAgentId}
									<div class="flex items-center gap-1 pr-1">
										<a
											href="{base}/code?device={device.id}&ws={ws.id}&agent={agent.id}"
											class="min-w-0 flex-1 pl-8 {row(agentActive)}"
											title={agent.title}
										>
											<IconCode class="size-3 shrink-0" />
											<span class="min-w-0 flex-1 truncate">{agent.title}</span>
											<span
												class="size-1.5 shrink-0 rounded-full {agent.state === 'running' ||
												agent.state === 'waiting-permission'
													? 'bg-blue-600'
													: agent.state === 'error'
														? 'bg-red-600'
														: agent.state === 'done'
															? 'bg-green-700'
															: 'bg-gray-400'}"
												title={agent.state}
											></span>
										</a>
										<button
											class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
											title="Archive this session"
											onclick={() => (confirmRequest = { kind: "agent", device, agent })}
										>
											<IconTrash class="size-3.5" />
										</button>
									</div>
								{/each}
								{#if wsActive && agentsOf(tree, ws.id).length === 0}
									<p class="py-0.5 pl-10 text-xs text-gray-400 dark:text-gray-500">
										No agents yet.
									</p>
								{/if}
							</div>
						{/each}
					{/if}
				{/if}
			</div>
		{/each}
	{/if}
</div>

{#if pairingOpen}
	<PairDeviceDialog onclose={() => (pairingOpen = false)} onpaired={handlePaired} />
{/if}

{#if workspaceDialogFor}
	<WorkspaceDialog
		deviceId={workspaceDialogFor}
		onclose={() => (workspaceDialogFor = null)}
		oncreated={(workspace) => {
			// The daemon owns the truth; reload the tree and drop the person
			// on the workspace they just made — staying wherever they were
			// would leave the fresh row unselected and the panel pointing at
			// something they have already moved past. Navigation also closes
			// the drawer.
			const id = workspaceDialogFor;
			workspaceDialogFor = null;
			if (id) {
				void reloadDevice(id);
				void goto(`${base}/code?device=${id}&ws=${workspace.id}`, { keepFocus: true });
			}
		}}
	/>
{/if}

{#if agentDialogFor}
	{@const dialogWorkspace = agentDialogFor}
	{@const dialogDevice =
		selectedDeviceId ??
		devices.find((d) => trees[d.id]?.workspaces.some((w) => w.id === dialogWorkspace.id))?.id ??
		""}
	<AgentDialog
		deviceId={dialogDevice}
		workspace={dialogWorkspace}
		onclose={() => (agentDialogFor = null)}
		oncreated={(agent) => {
			// The daemon owns the truth; reload the tree and take the person
			// straight to the new session. Navigation also closes the drawer.
			agentDialogFor = null;
			if (dialogDevice) {
				void reloadDevice(dialogDevice);
				void goto(
					`${base}/code?device=${dialogDevice}&ws=${dialogWorkspace.id}&agent=${agent.id}`,
					{ keepFocus: true }
				);
			}
		}}
	/>
{/if}

{#if confirmRequest}
	{@const request = confirmRequest}
	{#if request.kind === "agent"}
		<CodeConfirmDialog
			title="Archive session"
			target={request.agent.title}
			message="This session disappears from the daemon's active list, its transcript archived with it. Local files on the device are untouched."
			confirmLabel="Archive session"
			busyLabel="Archiving…"
			onconfirm={() => handleArchiveAgent(request.device, request.agent)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else}
		<CodeConfirmDialog
			title="Archive workspace"
			target={request.workspace.name}
			message="The workspace and its sessions disappear from the daemon's active list, their transcripts archived with them. Local files on the device are untouched."
			confirmLabel="Archive workspace"
			busyLabel="Archiving…"
			onconfirm={() => handleArchiveWorkspace(request.device, request.workspace)}
			onclose={() => (confirmRequest = null)}
		/>
	{/if}
{/if}

{#if renameFor}
	<WorkspaceRenameDialog
		deviceId={renameFor.device.id}
		workspace={renameFor.workspace}
		onclose={() => (renameFor = null)}
		onrenamed={() => {
			const id = renameFor?.device.id;
			renameFor = null;
			if (id) void reloadDevice(id);
		}}
	/>
{/if}
