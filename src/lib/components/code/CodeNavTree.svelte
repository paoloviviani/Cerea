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
	import { onMount, untrack } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { DropdownMenu } from "bits-ui";
	import IconAdd from "~icons/carbon/add";
	import IconLaptop from "~icons/carbon/laptop";
	import IconFolder from "~icons/carbon/folder";
	import IconCode from "~icons/carbon/code";
	import IconBranch from "~icons/carbon/branch";
	import IconFork from "~icons/carbon/fork";
	import IconRenew from "~icons/carbon/renew";
	import IconTrash from "~icons/carbon/trash-can";
	import IconKebab from "~icons/lucide/ellipsis";
	import IconEdit from "~icons/carbon/edit";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheck from "~icons/carbon/checkmark";
	import IconClose from "~icons/carbon/close";
	import IconChevronRight from "~icons/carbon/chevron-right";
	import {
		listWorkspaces,
		listAgents,
		confirmDevice,
		revokeDevice,
		archiveAgent,
		deleteAgent,
		archiveWorkspace,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import type { CodeAgentSession, CodeWorkspace } from "$lib/types/CodeAgent";
	import {
		codeDeviceList,
		refreshCodeDevices,
		useCodeDevicePoll,
	} from "$lib/stores/codeDeviceList.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { buildEnrollCommand } from "$lib/codeEnrollCommand";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import WorkspaceDialog from "./WorkspaceDialog.svelte";
	import WorkspaceRenameDialog from "./WorkspaceRenameDialog.svelte";
	import WorktreeDialog from "./WorktreeDialog.svelte";
	import AgentRenameDialog from "./AgentRenameDialog.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";
	import {
		SHOW_SUBAGENTS_KEY,
		parentRow,
		spawnerRow,
		groupSpawned,
		readShowSubagents,
		subagentRow,
		spawnedRow,
		visibleAgents,
	} from "$lib/utils/codeSubagents";
	import {
		pruneTreeCollapse,
		readTreeCollapse,
		writeTreeCollapse,
		workspaceKey,
	} from "$lib/utils/codeTreeCollapse";

	/** One paired device's live subtree, read through the proxy. */
	interface DeviceSubtree {
		workspaces: CodeWorkspace[];
		agents: CodeAgentSession[];
		/** The daemon behind this pairing could not be reached. */
		off: boolean;
	}

	let trees = $state<Record<string, DeviceSubtree>>({});
	let pairingOpen = $state(false);
	let workspaceDialogFor = $state<string | null>(null);
	let agentDialogFor = $state<CodeWorkspace | null>(null);
	/** The workspace whose rename dialog is open, with its device. */
	let renameFor = $state<{ device: CodeDeviceView; workspace: CodeWorkspace } | null>(null);
	/** The repo workspace a "New worktree…" dialog is open for, with its device. */
	let worktreeFor = $state<{ device: CodeDeviceView; workspace: CodeWorkspace } | null>(null);
	/** The agent whose rename dialog is open, with its device. */
	let renameAgentFor = $state<{ device: CodeDeviceView; agent: CodeAgentSession } | null>(null);
	/** A removal waiting for its confirmation: which row, on which device. */
	let confirmRequest = $state<
		| { kind: "agent"; device: CodeDeviceView; agent: CodeAgentSession }
		| { kind: "agent-delete"; device: CodeDeviceView; agent: CodeAgentSession }
		| { kind: "workspace"; device: CodeDeviceView; workspace: CodeWorkspace }
		| { kind: "device"; device: CodeDeviceView }
		| null
	>(null);

	const selectedDeviceId = $derived(page.url.searchParams.get("device"));
	const selectedWorkspaceId = $derived(page.url.searchParams.get("ws"));
	const selectedAgentId = $derived(page.url.searchParams.get("agent"));

	// The same one-liner the pairing dialog prints (§12): a device flagged
	// `reenroll` shows it too, rather than a bare "go re-pair" pointer with
	// nothing to act on.
	const publicConfig = usePublicConfig();
	const reenrollCommand = $derived(
		buildEnrollCommand({
			origin: publicConfig.origin,
			issuer: page.data.codeOidcIssuerUrl ?? "",
			gatewayOrigin: page.data.codeGatewayOrigin || page.url.origin,
			clientId: page.data.codeOidcClientId,
		})
	);

	// Collapsed devices and device+workspace groups (1b), remembered in
	// localStorage across reloads. Only what is actually collapsed is
	// stored — the empty case (nobody has collapsed anything) needs no
	// entry at all, so a fresh browser or a freshly paired device starts
	// expanded. deviceCounts is each device's last-known workspace count,
	// carried in the same record so a collapsed device's badge still reads
	// right after a reload even though lazy loading means it is not
	// re-fetched to refresh it (a workspace's own session-count badge needs
	// no such cache — see `codeTreeCollapse.ts`).
	let collapsedDevices = $state<Set<string>>(new Set());
	let collapsedWorkspaces = $state<Set<string>>(new Set());
	let deviceCounts = $state<Record<string, number>>({});
	onMount(() => {
		const stored = readTreeCollapse(globalThis.localStorage);
		collapsedDevices = new Set(stored.devices);
		collapsedWorkspaces = new Set(stored.workspaces);
		deviceCounts = stored.deviceCounts;
	});
	function persistTreeState() {
		writeTreeCollapse(globalThis.localStorage, {
			devices: [...collapsedDevices],
			workspaces: [...collapsedWorkspaces],
			deviceCounts,
		});
	}
	// A device revoked (here or in another tab) never reappears, so its
	// stale id would otherwise sit in localStorage forever — dropped as
	// soon as the real device list says it is gone.
	$effect(() => {
		const known = new Set(codeDeviceList.devices.map((d) => d.id));
		if (known.size === 0) return;
		const pruned = pruneTreeCollapse(
			{ devices: [...collapsedDevices], workspaces: [...collapsedWorkspaces], deviceCounts },
			known
		);
		if (
			pruned.devices.length !== collapsedDevices.size ||
			pruned.workspaces.length !== collapsedWorkspaces.size ||
			Object.keys(pruned.deviceCounts).length !== Object.keys(deviceCounts).length
		) {
			collapsedDevices = new Set(pruned.devices);
			collapsedWorkspaces = new Set(pruned.workspaces);
			deviceCounts = pruned.deviceCounts;
			persistTreeState();
		}
	});
	// Every time a device's subtree loads (expanded or not — a device just
	// collapsed keeps polling nothing further, but its last answer is still
	// in `trees`), its workspace count is captured for the badge a future
	// reload might need to show before that device is expanded again.
	$effect(() => {
		let changed = false;
		const next = { ...deviceCounts };
		for (const [deviceId, tree] of Object.entries(trees)) {
			if (tree.off) continue;
			if (next[deviceId] !== tree.workspaces.length) {
				next[deviceId] = tree.workspaces.length;
				changed = true;
			}
		}
		if (changed) {
			deviceCounts = next;
			persistTreeState();
		}
	});

	/** Every row honours its stored state, the selected one included — the
	 * chevron on the row someone is looking at has to do something. Navigation
	 * reveals a collapsed row once (below); after that it is theirs to fold. */
	function isDeviceExpanded(deviceId: string): boolean {
		return !collapsedDevices.has(deviceId);
	}
	function isWorkspaceExpanded(deviceId: string, workspaceId: string): boolean {
		return !collapsedWorkspaces.has(workspaceKey(deviceId, workspaceId));
	}
	// A new address reveals the device and workspace it names, once: going
	// somewhere must never land on a folded row, but the first render is not a
	// navigation — a reload keeps what the person had folded, selection or not.
	let lastAddress: string | undefined;
	$effect(() => {
		const address = `${selectedDeviceId}|${selectedWorkspaceId}|${selectedAgentId}`;
		const previous = lastAddress;
		lastAddress = address;
		if (previous === undefined || previous === address) return;
		untrack(() => {
			let changed = false;
			if (selectedDeviceId && collapsedDevices.has(selectedDeviceId)) {
				const next = new Set(collapsedDevices);
				next.delete(selectedDeviceId);
				collapsedDevices = next;
				changed = true;
			}
			if (selectedDeviceId && selectedWorkspaceId) {
				const key = workspaceKey(selectedDeviceId, selectedWorkspaceId);
				if (collapsedWorkspaces.has(key)) {
					const next = new Set(collapsedWorkspaces);
					next.delete(key);
					collapsedWorkspaces = next;
					changed = true;
				}
			}
			if (changed) persistTreeState();
		});
	});
	function toggleDeviceCollapsed(deviceId: string) {
		const next = new Set(collapsedDevices);
		if (next.has(deviceId)) next.delete(deviceId);
		else next.add(deviceId);
		collapsedDevices = next;
		persistTreeState();
	}
	function toggleWorkspaceCollapsed(deviceId: string, workspaceId: string) {
		const key = workspaceKey(deviceId, workspaceId);
		const next = new Set(collapsedWorkspaces);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		collapsedWorkspaces = next;
		persistTreeState();
	}

	function agentsOf(tree: DeviceSubtree | undefined, workspaceId: string): CodeAgentSession[] {
		return groupSpawned(
			visibleAgents(tree?.agents ?? [], showSubagents).filter(
				(agent) => agent.workspaceId === workspaceId
			)
		);
	}

	// Subagents are listed under their own workspace, marked rather than
	// nested (a parent and its subagent can live in different worktrees).
	// The toggle hides them; on by default, remembered per browser.
	let showSubagents = $state(true);
	onMount(() => {
		showSubagents = readShowSubagents(globalThis.localStorage);
	});
	function toggleSubagents() {
		showSubagents = !showSubagents;
		globalThis.localStorage?.setItem(SHOW_SUBAGENTS_KEY, String(showSubagents));
	}
	const hasSubagents = $derived(
		Object.values(trees).some((tree) => tree.agents.some((agent) => agent.parentId))
	);

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

	async function reloadDevice(deviceId: string) {
		trees = { ...trees, [deviceId]: await loadTree(deviceId) };
	}

	// The device list itself is the shared poll (`codeDeviceList.svelte.ts`,
	// X4) — CodePanel reads the same interval instead of running its own.
	// This tree additionally loads each *online, paired, expanded* device's
	// own workspace/agent subtree: never for an offline one (X4 — a device
	// with nothing to answer must never even be asked, which is what used
	// to freeze the tree behind `Promise.all`), never for one still
	// `pending`, which has no subtree to show yet, and never for one
	// collapsed (1b) — its row and online status still show, but its
	// workspaces and agents are not fetched until it is expanded.
	const loadableDevices = $derived(
		codeDeviceList.devices.filter(
			(device) =>
				device.status === "paired" && device.online !== false && isDeviceExpanded(device.id)
		)
	);
	const TREE_POLL_MS = 8000;
	// Each device's subtree is painted in as it answers, not held behind
	// whichever device is slowest (X4): a `Promise.all` that only assigns
	// `trees` once every promise has settled meant one slow machine blocked
	// every other device's rows too, reload after reload.
	async function refreshTrees() {
		await Promise.all(
			loadableDevices.map(async (device) => {
				const tree = await loadTree(device.id);
				trees = { ...trees, [device.id]: tree };
			})
		);
	}
	// The device list (`codeDeviceList`) and this tree's own load are two
	// independent async fetches; nothing else ties them together. Without
	// this, a device that becomes loadable *after* the mount-time
	// `refreshTrees()` already ran (the ordinary case: `refreshCodeDevices()`
	// is still in flight when it runs) sat with no subtree at all until the
	// next `TREE_POLL_MS` tick — up to 8s of "no workspaces or agents yet"
	// after every page refresh, measured on the real-machine harness.
	$effect(() => {
		for (const device of loadableDevices) {
			if (!(device.id in trees)) void reloadDevice(device.id);
		}
	});
	onMount(() => {
		const stopDevicePoll = useCodeDevicePoll();
		void refreshTrees();
		const interval = setInterval(() => void refreshTrees(), TREE_POLL_MS);
		const onFocus = () => {
			void refreshCodeDevices();
			void refreshTrees();
		};
		window.addEventListener("focus", onFocus);
		return () => {
			stopDevicePoll();
			clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	});

	let actionFailure = $state<string | null>(null);

	async function handleConfirm(id: string) {
		try {
			await confirmDevice(id);
			await refreshCodeDevices();
		} catch (err) {
			actionFailure = err instanceof Error ? err.message : "Could not confirm the machine.";
		}
	}

	async function handleRevoke(id: string) {
		try {
			await revokeDevice(id);
			await refreshCodeDevices();
			const rest = { ...trees };
			delete rest[id];
			trees = rest;
			if (selectedDeviceId === id) {
				void goto(`${base}/code`, { keepFocus: true });
			}
		} catch {
			actionFailure = "Could not revoke the device.";
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

	/**
	 * Delete one session for good: unlike archive, its attachments go with
	 * it. Same redraw discipline as archive — the daemon answers first, the
	 * person leaves the deleted address second, the tree is re-read last.
	 */
	async function handleDeleteAgent(device: CodeDeviceView, agent: CodeAgentSession) {
		await deleteAgent(device.id, agent.id);
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

	async function handleArchiveWorkspace(
		device: CodeDeviceView,
		workspace: CodeWorkspace,
		removeWorktree: boolean
	) {
		await archiveWorkspace(device.id, workspace.id, removeWorktree ? { removeWorktree: true } : {});
		if (addressOnWorkspace(device.id, workspace.id)) {
			void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
		}
		await reloadDevice(device.id);
	}

	function handlePaired(device: CodeDeviceView) {
		pairingOpen = false;
		void refreshCodeDevices();
		void reloadDevice(device.id);
		void goto(`${base}/code?device=${device.id}`, { keepFocus: true });
	}

	function row(active: boolean, holdsSelection = false): string {
		// flex-1, not flex-none: the row's link fills the row so its
		// trailing actions (the add button, the kebab) pin to the sidebar's
		// right edge. A second flex utility on the call site would lose to
		// stylesheet order regardless of class order, so growth lives here
		// alone — call sites carry no flex sizing of their own.
		// `holdsSelection`: a folded row with the selection hidden inside it —
		// a lighter wash, so it does not read as the selected row itself.
		return `flex h-8 flex-1 items-center gap-1.5 rounded-lg px-2 text-left text-sm ${
			active
				? "bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-white"
				: holdsSelection
					? "bg-gray-50 font-medium text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
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

	{#if actionFailure}
		<div
			class="mx-2 mb-1 rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
		>
			<p class="flex items-center gap-1.5 font-medium">
				<IconWarning class="size-3.5" />
				{actionFailure}
			</p>
		</div>
	{/if}
	{#if codeDeviceList.loading}
		<p class="flex items-center gap-2 px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
			<IconRenew class="size-4 animate-spin" />
			Loading paired devices…
		</p>
	{:else if codeDeviceList.devices.length === 0}
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
		{#if hasSubagents}
			<button
				type="button"
				class="mb-1 flex h-6 items-center gap-1.5 px-2 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
				aria-pressed={showSubagents}
				onclick={toggleSubagents}
			>
				<span
					class="flex size-3 items-center justify-center rounded-sm border {showSubagents
						? 'border-blue-600 bg-blue-600 text-white'
						: 'border-gray-400'}"
				>
					{#if showSubagents}<IconCheck class="size-2.5" />{/if}
				</span>
				Show subagents
			</button>
		{/if}
		{#each codeDeviceList.devices as device (device.id)}
			{@const tree = trees[device.id]}
			{@const deviceActive = device.id === selectedDeviceId}
			{@const deviceExpanded = isDeviceExpanded(device.id)}
			{@const isDead = device.reenroll === "revoked"}
			<div>
				<div class="group flex items-center gap-1 pr-1">
					{#if device.status === "paired"}
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
							aria-expanded={deviceExpanded}
							aria-label="{deviceExpanded ? 'Collapse' : 'Expand'} {device.name}"
							onclick={() => toggleDeviceCollapsed(device.id)}
						>
							<IconChevronRight
								class="size-3 shrink-0 transition-transform {deviceExpanded ? 'rotate-90' : ''}"
							/>
						</button>
					{:else}
						<!-- A pending device has no subtree to collapse — a fixed
						     spacer keeps its row's icon aligned with every paired
						     device's, whose chevron takes this same slot. -->
						<span class="size-6 shrink-0"></span>
					{/if}
					{#if device.status === "pending" || isDead}
						<span class="min-w-0 {row(false)}">
							<IconLaptop class="size-3.5 shrink-0" />
							<span class="min-w-0 flex-1 truncate">{device.name}</span>
						</span>
					{:else}
						<a
							href="{base}/code?device={device.id}"
							class="min-w-0 {row(
								deviceActive && !selectedAgentId,
								deviceActive && !!selectedAgentId && !deviceExpanded
							)}"
							data-holds-selection={deviceActive && !!selectedAgentId && !deviceExpanded
								? ""
								: undefined}
							title={device.name}
						>
							<IconLaptop class="size-3.5 shrink-0" />
							<span class="min-w-0 flex-1 truncate">{device.name}</span>
						</a>
					{/if}
					{#if device.status === "pending"}
						<!-- The fresh human approval review C2 calls for: a
						     machine that connected with a valid bearer waits
						     here until Confirm, and nothing is forwarded to
						     it before that click. -->
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
							title="Confirm this machine"
							onclick={() => void handleConfirm(device.id)}
						>
							<IconCheck class="size-3.5" />
						</button>
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
							title="Reject this machine"
							onclick={() => (confirmRequest = { kind: "device", device })}
						>
							<IconClose class="size-3.5" />
						</button>
					{:else if isDead}
						<!-- A revoked-by-the-gateway row is a tombstone (never
						     reconnects under this machineId): no online pill, no
						     "Add workspace", no "Remove this pairing" — there is
						     nothing left to pair or unpair, only the re-enroll
						     banner below. -->
						<span
							class="shrink-0 rounded-full bg-red-100 px-1.5 text-[.65rem] text-red-800 dark:bg-red-900/60 dark:text-red-300"
						>
							access revoked
						</span>
					{:else}
						{@const online = device.online !== false}
						<span
							class="shrink-0 rounded-full px-1.5 text-[.65rem] {device.credentialState ===
							'expired'
								? 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-300'
								: online
									? 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-300'
									: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}"
							title={device.credentialState === "expired"
								? "This machine's gateway credential expired or was revoked."
								: online
									? "Connected"
									: "Not connected"}
						>
							{device.credentialState === "expired"
								? "credential expired"
								: online
									? "online"
									: "offline"}
						</span>
						{#if !deviceExpanded && deviceCounts[device.id] !== undefined}
							<!-- The last-known count (`deviceCounts`, persisted
							     alongside the collapse state): a device collapsed
							     before it was ever expanded this session has none
							     yet, rather than fetching its subtree just to fill
							     a badge nobody asked to see (1b's lazy loading). -->
							<span
								class="shrink-0 rounded-full bg-gray-100 px-1.5 text-[.65rem] text-gray-500 dark:bg-gray-700 dark:text-gray-300"
								data-testid="device-collapsed-count"
							>
								{deviceCounts[device.id]}
								{deviceCounts[device.id] === 1 ? "workspace" : "workspaces"}
							</span>
						{/if}
						<!-- Mirrors the workspace row's agent "+": always visible,
						     not hidden behind the kebab, because adding a
						     workspace is the primary action on a paired device
						     and the only way to add a second one once the
						     empty-state button (below) is gone. -->
						<button
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
							title="Add a workspace to this device"
							disabled={!online}
							onclick={() => (workspaceDialogFor = device.id)}
						>
							<IconAdd class="size-3.5" />
						</button>
						<button
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
							title="Remove this pairing"
							onclick={() => (confirmRequest = { kind: "device", device })}
						>
							<IconTrash class="size-3.5" />
						</button>
					{/if}
				</div>
				{#if device.reenroll}
					<div
						class="mb-1.5 ml-7 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
					>
						<p class="mb-1.5 flex items-center gap-1.5 font-medium">
							<IconWarning class="size-3.5 shrink-0" />
							Re-enroll this machine: {device.reenroll === "revoked"
								? "access was revoked"
								: "the identity provider changed"}
						</p>
						<div class="flex items-center gap-2 rounded-md border border-line bg-surface p-2">
							<p class="min-w-0 flex-1 font-mono text-[.65rem] break-all text-ink">
								{reenrollCommand}
							</p>
							<CopyToClipBoardBtn
								classNames="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
								value={reenrollCommand}
							/>
						</div>
					</div>
				{/if}
				{#if device.status === "paired" && !isDead && deviceExpanded}
					<!-- The guide runs down the centre of the size-6 chevron slot (ml-3),
					     the ProjectsBranch idiom: nesting is drawn, not padded. -->
					<div
						class="ml-3 border-l border-gray-200 pl-1.5 dark:border-gray-700"
						data-testid="device-rail"
					>
						{#if device.online === false || tree?.off}
							<!-- Offline renders as a plain label, never a spinner (X4):
						     an unreachable machine is never even asked for its
						     tree (see `loadableDevices` above), so there is
						     nothing here to wait on. -->
							<p class="py-0.5 pl-2 text-xs text-gray-400 dark:text-gray-500">Offline.</p>
						{:else if tree && tree.workspaces.length === 0}
							<button
								class="flex items-center gap-1.5 py-0.5 pl-2 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
								onclick={() => (workspaceDialogFor = device.id)}
							>
								<IconAdd class="size-3" />
								Add workspace
							</button>
						{:else}
							{#each tree?.workspaces ?? [] as ws (ws.id)}
								{@const wsActive = ws.id === selectedWorkspaceId && deviceActive}
								{@const wsExpanded = isWorkspaceExpanded(device.id, ws.id)}
								{@const wsSessionCount = agentsOf(tree, ws.id).length}
								<div>
									<div class="group flex items-center gap-1 pr-1">
										<button
											type="button"
											class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
											aria-expanded={wsExpanded}
											aria-label="{wsExpanded ? 'Collapse' : 'Expand'} {ws.name}"
											onclick={() => toggleWorkspaceCollapsed(device.id, ws.id)}
										>
											<IconChevronRight
												class="size-3 shrink-0 transition-transform {wsExpanded ? 'rotate-90' : ''}"
											/>
										</button>
										<span
											class="min-w-0 {row(
												wsActive && !selectedAgentId,
												wsActive && !!selectedAgentId && !wsExpanded
											)}"
											data-holds-selection={wsActive && !!selectedAgentId && !wsExpanded
												? ""
												: undefined}
										>
											<IconFolder class="size-3 shrink-0" />
											<span class="min-w-0 flex-1 truncate">{ws.name}</span>
											{#if ws.branch}
												<!-- Worktree workspaces sit beside their source repo in
											     this same flat list (not nested under it) — the
											     branch badge is what marks the relationship, kept
											     simple rather than building a second tree level. -->
												<span
													class="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400"
													title="git worktree on {ws.branch}"
												>
													<IconBranch class="size-2.5" />
													{ws.branch}
												</span>
											{/if}
											{#if !wsExpanded}
												<span
													class="shrink-0 rounded-full bg-gray-100 px-1.5 text-[10px] text-gray-500 dark:bg-gray-700 dark:text-gray-300"
													data-testid="workspace-collapsed-count"
												>
													{wsSessionCount}
													{wsSessionCount === 1 ? "session" : "sessions"}
												</span>
											{/if}
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
										<!-- The kebab sits at the row's right edge with air
								     between it and the add button: the two are
								     both 24px targets, and a tap meant to start
								     a session must never open a menu instead. -->
										<DropdownMenu.Root>
											<!-- The trigger stays in flow at all times (never
								     display:none) so its 24px slot is always reserved
								     — only opacity toggles on hover/focus/open. A
								     display toggle here would shrink the flex-1 name
								     span next to it and shove the dot/add button
								     sideways on hover, which is the bug this avoids.
								     Same idiom as NavConversationItem's chat kebab. -->
											<DropdownMenu.Trigger
												class="ml-1 flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 data-[state=open]:bg-gray-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100 dark:hover:bg-gray-700 dark:data-[state=open]:bg-gray-700"
												title="Workspace actions"
												aria-label="Workspace actions"
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
													{#if ws.isGitRepo}
														<!-- Only a git repo can be branched into a worktree;
													     a plain directory workspace has no repo to run
													     `git worktree add` against. -->
														<DropdownMenu.Item
															class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
															onSelect={() => (worktreeFor = { device, workspace: ws })}
														>
															<IconBranch class="size-4 opacity-90 dark:opacity-80" />
															New worktree…
														</DropdownMenu.Item>
													{/if}
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
									{#if wsExpanded}
										<div
											class="ml-3 border-l border-gray-200 pl-1.5 dark:border-gray-700"
											data-testid="workspace-rail"
										>
											{#each agentsOf(tree, ws.id) as agent (agent.id)}
												{@const agentActive = agent.id === selectedAgentId}
												{@const sub = subagentRow(
													agent,
													tree?.agents ?? [],
													tree?.workspaces ?? []
												)}
												{@const kids = parentRow(agent, tree?.agents ?? [], tree?.workspaces ?? [])}
												{@const spawns = spawnerRow(
													agent,
													tree?.agents ?? [],
													tree?.workspaces ?? []
												)}
												{@const spawned = spawnedRow(
													agent,
													tree?.agents ?? [],
													tree?.workspaces ?? []
												)}
												<!-- A subagent's rows sit in a rail of their own, one level
												     under the workspace's: the rail idiom again, so the badge
												     is not the only thing that says "not a top-level session". -->
												<div
													class={sub
														? "ml-3 border-l border-gray-200 pl-1.5 dark:border-gray-700"
														: ""}
													data-testid={sub ? "subagent-rail" : undefined}
												>
													<div class="group flex items-center gap-1 pr-1">
														<a
															href="{base}/code?device={device.id}&ws={ws.id}&agent={agent.id}"
															class="min-w-0 {row(agentActive)}"
															title={agent.title}
														>
															<IconCode class="size-3 shrink-0" />
															<span class="min-w-0 flex-1 truncate">{agent.title}</span>
															{#if sub}
																<span
																	class="shrink-0 rounded-sm bg-gray-100 px-1 text-[10px] font-medium text-gray-500 uppercase dark:bg-gray-700 dark:text-gray-300"
																	data-testid="subagent-badge">sub</span
																>
															{/if}
															{#if agent.state === "waiting-permission" || kids?.waiting}
																<span
																	class="shrink-0 rounded-sm bg-amber-100 px-1 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
																	title={agent.state === "waiting-permission"
																		? "Waiting for your approval"
																		: "A subagent is waiting for your approval"}
																	data-testid="waiting-approval"
																	>{agent.state === "waiting-permission"
																		? "waiting for approval"
																		: "subagent waiting"}</span
																>
															{:else}
																<span
																	class="size-1.5 shrink-0 rounded-full {agent.state === 'running'
																		? 'bg-blue-600'
																		: agent.state === 'error'
																			? 'bg-red-600'
																			: agent.state === 'done'
																				? 'bg-green-700'
																				: 'bg-gray-400'}"
																	title={agent.state}
																></span>
															{/if}
														</a>
														{#if spawns}
															<DropdownMenu.Root>
																<DropdownMenu.Trigger
																	class="flex h-6 shrink-0 items-center rounded-md px-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
																	title="Sessions spawned by this one"
																	data-testid="spawned-count"
																>
																	spawned {spawns.count}
																</DropdownMenu.Trigger>
																<DropdownMenu.Portal>
																	<DropdownMenu.Content
																		class="z-50 max-w-64 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
																		side="bottom"
																		align="end"
																		sideOffset={6}
																	>
																		{#each spawns.children as child (child.id)}
																			<DropdownMenu.Item
																				class="flex h-8 items-center gap-2 rounded-md px-2 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
																				onSelect={() =>
																					goto(
																						`${base}/code?device=${device.id}&ws=${child.workspaceId}&agent=${child.id}`
																					)}
																			>
																				<span class="min-w-0 flex-1 truncate">{child.title}</span>
																				{#if child.workspaceId !== agent.workspaceId && child.workspaceName}
																					<span class="shrink-0 text-xs text-gray-400"
																						>· {child.workspaceName}</span
																					>
																				{/if}
																			</DropdownMenu.Item>
																		{/each}
																	</DropdownMenu.Content>
																</DropdownMenu.Portal>
															</DropdownMenu.Root>
														{/if}
														{#if kids}
															<DropdownMenu.Root>
																<DropdownMenu.Trigger
																	class="flex h-6 shrink-0 items-center rounded-md px-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
																	title="Subagents of this session"
																	data-testid="subagent-count"
																>
																	{kids.count}
																	{kids.count === 1 ? "subagent" : "subagents"}
																</DropdownMenu.Trigger>
																<DropdownMenu.Portal>
																	<DropdownMenu.Content
																		class="z-50 max-w-64 rounded-xl border border-gray-200 bg-white/95 p-1 text-gray-800 shadow-lg backdrop-blur-sm dark:border-gray-700/60 dark:bg-gray-800/95 dark:text-gray-100"
																		side="bottom"
																		align="end"
																		sideOffset={6}
																	>
																		{#each kids.children as child (child.id)}
																			<DropdownMenu.Item
																				class="flex h-8 items-center gap-2 rounded-md px-2 text-sm select-none data-highlighted:bg-gray-100 dark:data-highlighted:bg-white/10"
																				onSelect={() =>
																					goto(
																						`${base}/code?device=${device.id}&ws=${child.workspaceId}&agent=${child.id}`
																					)}
																			>
																				<span class="min-w-0 flex-1 truncate">{child.title}</span>
																				{#if child.workspaceId !== agent.workspaceId && child.workspaceName}
																					<span class="shrink-0 text-xs text-gray-400"
																						>· {child.workspaceName}</span
																					>
																				{/if}
																			</DropdownMenu.Item>
																		{:else}
																			<p class="px-2 py-1 text-xs text-gray-500">
																				In another workspace not listed here.
																			</p>
																		{/each}
																	</DropdownMenu.Content>
																</DropdownMenu.Portal>
															</DropdownMenu.Root>
														{/if}
														<!-- The session's actions live in the same kebab
									     as the workspace's, at the row's right edge:
									     rename and archive are occasional, and a bare
									     trash can was the only visible offer for both. -->
														<DropdownMenu.Root>
															<!-- Reserved-space trigger, same as the workspace
										     kebab above: opacity toggles, display never
										     does, so the presence dot never jumps on
										     hover. -->
															<DropdownMenu.Trigger
																class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 data-[state=open]:bg-gray-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100 dark:hover:bg-gray-700 dark:data-[state=open]:bg-gray-700"
																title="Session actions"
																aria-label="Session actions"
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
																		onSelect={() => (renameAgentFor = { device, agent })}
																	>
																		<IconEdit class="size-4 opacity-90 dark:opacity-80" />
																		Rename
																	</DropdownMenu.Item>
																	<DropdownMenu.Item
																		class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-gray-700 select-none focus-visible:outline-hidden data-highlighted:bg-gray-100 sm:h-8 dark:text-gray-200 dark:data-highlighted:bg-white/10"
																		onSelect={() =>
																			(confirmRequest = { kind: "agent", device, agent })}
																	>
																		<IconTrash class="size-4 opacity-90 dark:opacity-80" />
																		Archive
																	</DropdownMenu.Item>
																	<DropdownMenu.Item
																		class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-red-600 select-none focus-visible:outline-hidden data-highlighted:bg-red-50 sm:h-8 dark:text-red-400 dark:data-highlighted:bg-red-500/10"
																		onSelect={() =>
																			(confirmRequest = { kind: "agent-delete", device, agent })}
																	>
																		<IconTrash class="size-4 opacity-90 dark:opacity-80" />
																		Delete
																	</DropdownMenu.Item>
																</DropdownMenu.Content>
															</DropdownMenu.Portal>
														</DropdownMenu.Root>
													</div>
													{#if spawned}
														{#if !spawned.gone && spawned.workspaceId}
															<a
																href="{base}/code?device={device.id}&ws={spawned.workspaceId}&agent={spawned.sessionId}"
																class="flex min-w-0 items-center gap-1 pl-2 text-[11px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
																data-testid="spawned-from"
															>
																<IconFork class="size-3 shrink-0" />
																<span class="truncate"
																	>spawned by {spawned.title}{spawned.elsewhere
																		? ` · ${spawned.elsewhere}`
																		: ""}</span
																>
															</a>
														{:else}
															<p
																class="flex min-w-0 items-center gap-1 pl-2 text-[11px] text-gray-400 italic dark:text-gray-500"
																data-testid="spawned-from"
															>
																<IconFork class="size-3 shrink-0" />
																<span class="truncate">spawned by {spawned.title} (gone)</span>
															</p>
														{/if}
													{/if}
													{#if sub}
														{#if sub.parentWorkspaceId}
															<a
																href="{base}/code?device={device.id}&ws={sub.parentWorkspaceId}&agent={sub.parentId}"
																class="block truncate pl-2 text-[11px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
																data-testid="subagent-from"
																>↳ from {sub.parentTitle}{sub.elsewhere
																	? ` · ${sub.elsewhere}`
																	: ""}</a
															>
														{:else}
															<p
																class="truncate pl-2 text-[11px] text-gray-400 dark:text-gray-500"
																data-testid="subagent-from"
															>
																↳ from a session not listed here
															</p>
														{/if}
													{/if}
												</div>
											{/each}
											{#if wsActive && agentsOf(tree, ws.id).length === 0}
												<p class="py-0.5 pl-2 text-xs text-gray-400 dark:text-gray-500">
													No agents yet.
												</p>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						{/if}
					</div>
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
		codeDeviceList.devices.find((d) =>
			trees[d.id]?.workspaces.some((w) => w.id === dialogWorkspace.id)
		)?.id ??
		""}
	<AgentDialog
		deviceId={dialogDevice}
		workspace={dialogWorkspace}
		onclose={() => (agentDialogFor = null)}
		oncreated={(agent) => {
			// The daemon owns the truth; reload the tree and take the person
			// straight to the new session. Navigation also closes the drawer.
			// Read the block's consts before clearing agentDialogFor: they are
			// derived from it, and the {#if} tears down as soon as it is null.
			const deviceId = dialogDevice;
			const workspaceId = dialogWorkspace.id;
			agentDialogFor = null;
			if (deviceId) {
				void reloadDevice(deviceId);
				void goto(`${base}/code?device=${deviceId}&ws=${workspaceId}&agent=${agent.id}`, {
					keepFocus: true,
				});
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
	{:else if request.kind === "agent-delete"}
		<CodeConfirmDialog
			title="Delete session"
			target={request.agent.title}
			message="The session is gone for good: its transcript and any files attached to it are deleted too. Local files on the device are untouched."
			confirmLabel="Delete session"
			busyLabel="Deleting…"
			onconfirm={() => handleDeleteAgent(request.device, request.agent)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else if request.kind === "device"}
		<CodeConfirmDialog
			title={request.device.status === "pending" ? "Reject this machine" : "Remove this pairing"}
			target={request.device.name}
			message={request.device.status === "pending"
				? "A rejected machine never pairs: the row becomes a tombstone and a reconnect under the same machine id is refused. The machine must re-enroll to try again."
				: "Revoking ends this machine's access: the row becomes a tombstone, a reconnect under the same machine id is refused, and its sessions stop. The machine must re-enroll to pair again."}
			confirmLabel={request.device.status === "pending" ? "Reject machine" : "Revoke pairing"}
			busyLabel="Revoking…"
			onconfirm={() => handleRevoke(request.device.id)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else}
		<CodeConfirmDialog
			title="Archive workspace"
			target={request.workspace.name}
			message="The workspace and its sessions disappear from the daemon's active list, their transcripts archived with them. Local files on the device are untouched."
			confirmLabel="Archive workspace"
			busyLabel="Archiving…"
			checkboxLabel={request.workspace.worktreeOf
				? "Also remove the git worktree (refused if it has uncommitted changes)"
				: undefined}
			onconfirm={(removeWorktree) =>
				handleArchiveWorkspace(request.device, request.workspace, removeWorktree)}
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

{#if worktreeFor}
	{@const dialogDevice = worktreeFor.device}
	{@const dialogWorkspace = worktreeFor.workspace}
	<WorktreeDialog
		deviceId={dialogDevice.id}
		workspace={dialogWorkspace}
		onclose={() => (worktreeFor = null)}
		oncreated={(workspace) => {
			// Read the block's consts before clearing worktreeFor: they are
			// derived from it, and the {#if} tears down as soon as it is
			// null, same trap AgentDialog's own oncreated hit first.
			const deviceId = dialogDevice.id;
			worktreeFor = null;
			void reloadDevice(deviceId);
			void goto(`${base}/code?device=${deviceId}&ws=${workspace.id}`, { keepFocus: true });
		}}
	/>
{/if}

{#if renameAgentFor}
	<AgentRenameDialog
		deviceId={renameAgentFor.device.id}
		agent={renameAgentFor.agent}
		onclose={() => (renameAgentFor = null)}
		onrenamed={() => {
			const id = renameAgentFor?.device.id;
			renameAgentFor = null;
			if (id) void reloadDevice(id);
		}}
	/>
{/if}
