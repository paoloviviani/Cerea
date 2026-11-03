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
	import { m } from "$lib/paraglide/messages";
	import { onMount, untrack } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { goto } from "$app/navigation";
	import { DropdownMenu } from "bits-ui";
	import RowMenu, { MENU_ITEM, MENU_ITEM_DANGER } from "./RowMenu.svelte";
	import { longPress } from "$lib/utils/longPress";
	import { formatCompactAge } from "$lib/utils/relativeTime";
	import IconAdd from "~icons/carbon/add";
	import IconLaptop from "~icons/carbon/laptop";
	import IconFolder from "~icons/carbon/folder";
	import IconBranch from "~icons/carbon/branch";
	import IconFork from "~icons/carbon/fork";
	import IconRenew from "~icons/carbon/renew";
	import IconTrash from "~icons/carbon/trash-can";
	import IconEdit from "~icons/carbon/edit";
	import IconUsers from "~icons/carbon/user-multiple";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheck from "~icons/carbon/checkmark";
	import IconHelp from "~icons/carbon/help-filled";
	import IconClose from "~icons/carbon/close";
	import IconChevronRight from "~icons/carbon/chevron-right";
	import IconTime from "~icons/carbon/time";
	import { SIDEBAR_ITEM, SIDEBAR_ITEM_ACTIVE } from "$lib/components/nav/sidebarItem";
	import IconPermissions from "~icons/carbon/security";
	import {
		bindCodeCacheOwner,
		codeTreeCache,
		dropCachedAgent,
		dropCachedTree,
		isCodeTreeFresh,
		loadDeviceTree,
		type DeviceSubtree,
	} from "$lib/stores/codeTreeCache.svelte";
	import { forgetTranscript, transcriptKey } from "$lib/stores/agentTranscriptCache";
	import {
		confirmDevice,
		revokeDevice,
		archiveAgent,
		deleteAgent,
		archiveWorkspace,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import {
		isScheduledTitle,
		type CodeAgentSession,
		type CodeWorkspace,
	} from "$lib/types/CodeAgent";
	import {
		codeDeviceList,
		refreshCodeDevices,
		dropCodeDevice,
		useCodeDevicePoll,
	} from "$lib/stores/codeDeviceList.svelte";
	import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { buildEnrollCommand } from "$lib/codeEnrollCommand";
	import PairDeviceDialog from "./PairDeviceDialog.svelte";
	import PermissionsDialog from "./PermissionsDialog.svelte";
	import MachineProfilesDialog from "./MachineProfilesDialog.svelte";
	import WorkspaceDialog from "./WorkspaceDialog.svelte";
	import WorkspaceRenameDialog from "./WorkspaceRenameDialog.svelte";
	import WorktreeDialog from "./WorktreeDialog.svelte";
	import AgentRenameDialog from "./AgentRenameDialog.svelte";
	import AgentDialog from "./AgentDialog.svelte";
	import CodeConfirmDialog from "./CodeConfirmDialog.svelte";
	import {
		SHOW_SUBAGENTS_KEY,
		parentRow,
		nestSessions,
		readShowSubagents,
		subagentRow,
		spawnedRow,
		visibleAgents,
		workspaceLabel,
	} from "$lib/utils/codeSubagents";
	import {
		pruneTreeCollapse,
		readTreeCollapse,
		writeTreeCollapse,
		workspaceKey,
	} from "$lib/utils/codeTreeCollapse";

	// The subtrees live in a module cache, not here: this component mounts and
	// unmounts as the person moves between chats and /code, and rows held in
	// component state began empty on every visit.
	bindCodeCacheOwner(page.data.user?.id);
	$effect(() => bindCodeCacheOwner(page.data.user?.id));
	const trees = $derived(codeTreeCache.trees);
	let pairingOpen = $state(false);
	let workspaceDialogFor = $state<string | null>(null);
	let agentDialogFor = $state<CodeWorkspace | null>(null);
	/** The workspace whose rename dialog is open, with its device. */
	let renameFor = $state<{ device: CodeDeviceView; workspace: CodeWorkspace } | null>(null);
	/** The repo workspace a "New worktree…" dialog is open for, with its device. */
	let worktreeFor = $state<{ device: CodeDeviceView; workspace: CodeWorkspace } | null>(null);
	/** The machine whose delegate-profiles dialog is open. */
	let profilesFor = $state<CodeDeviceView | null>(null);
	/** The agent whose rename dialog is open, with its device. */
	let renameAgentFor = $state<{ device: CodeDeviceView; agent: CodeAgentSession } | null>(null);
	/** The session whose Permissions dialog is open, with its device. The
	 * dialog reads that session's rules itself, so any row's menu can open
	 * it — the selection does not matter. */
	let permissionsFor = $state<{ device: CodeDeviceView; agent: CodeAgentSession } | null>(null);
	/** A removal waiting for its confirmation: which row, on which device. */
	let confirmRequest = $state<
		| { kind: "agent"; device: CodeDeviceView; agent: CodeAgentSession }
		| { kind: "agent-delete"; device: CodeDeviceView; agent: CodeAgentSession }
		| { kind: "workspace"; device: CodeDeviceView; workspace: CodeWorkspace }
		| { kind: "device"; device: CodeDeviceView }
		| null
	>(null);

	// On the Schedules pages `device`/`ws`/`agent` prefill the editor instead of
	// naming a selection, so the tree highlights the Schedules row alone.
	const schedulesActive = $derived(page.url.searchParams.get("view") === "schedules");
	const selectedDeviceId = $derived(schedulesActive ? null : page.url.searchParams.get("device"));
	const selectedWorkspaceId = $derived(schedulesActive ? null : page.url.searchParams.get("ws"));
	const selectedAgentId = $derived(schedulesActive ? null : page.url.searchParams.get("agent"));

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
		return visibleAgents(tree?.agents ?? [], showSubagents).filter(
			(agent) => agent.workspaceId === workspaceId
		);
	}

	// Machines that cannot answer sink to the bottom (the order is otherwise
	// the list's own, so a poll never reshuffles the ones in use).
	function isDimmed(device: CodeDeviceView): boolean {
		return device.reenroll === "revoked" || (device.status === "paired" && device.online === false);
	}
	const sortedDevices = $derived(
		[...codeDeviceList.devices].sort((a, b) => Number(isDimmed(a)) - Number(isDimmed(b)))
	);

	/** At most this many nested rows show under a session until it is opened. */
	const CHILDREN_SHOWN = 2;
	/** Parents whose nested rows are all shown (`deviceId:agentId`), in memory only. */
	let expandedChildren = $state<Set<string>>(new Set());
	function toggleChildren(key: string) {
		const next = new Set(expandedChildren);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedChildren = next;
	}

	/** The row whose ⋯ menu is open, by key: one menu at a time, and a touch
	 * long-press on a row opens the same menu the ⋯ button does. */
	let menuOpenKey = $state<string | null>(null);
	const menuOpen = (key: string) => menuOpenKey === key;
	const setMenuOpen = (key: string) => (open: boolean) => {
		if (open) menuOpenKey = key;
		else if (menuOpenKey === key) menuOpenKey = null;
	};
	const openMenu = (key: string) => () => (menuOpenKey = key);

	function ageOf(date: Date | string | undefined | null): string {
		return formatCompactAge(date);
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

	function reloadDevice(deviceId: string) {
		return loadDeviceTree(deviceId);
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
	// `ifStale` (the visit's first read) skips a device whose cached subtree is
	// still young, so returning to /code neither refetches nor flashes.
	async function refreshTrees(opts: { ifStale?: boolean } = {}) {
		await Promise.all(
			loadableDevices
				.filter((device) => !(opts.ifStale && isCodeTreeFresh(device.id)))
				.map((device) => loadDeviceTree(device.id))
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
		void refreshTrees({ ifStale: true });
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
			actionFailure = err instanceof Error ? err.message : m["code.nav.could_not_confirm"]();
		}
	}

	async function handleRevoke(id: string) {
		// A failure propagates to the confirm dialog, which stays open with the
		// reason under it (and a retry) rather than closing on a silent banner.
		await revokeDevice(id);
		// The server said yes: the card goes now. The list is re-read in the
		// background, never awaited: a slow or failing re-read must not hold
		// the dialog busy (or report a revoke that happened as a failure).
		dropCodeDevice(id);
		void refreshCodeDevices();
		dropCachedTree(id);
		if (selectedDeviceId === id) {
			void goto(`${base}/code`, { keepFocus: true });
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
		forgetTranscript(transcriptKey(device.id, agent.id));
		dropCachedAgent(device.id, agent.id);
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
		forgetTranscript(transcriptKey(device.id, agent.id));
		dropCachedAgent(device.id, agent.id);
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

	function row(active: boolean, holdsSelection = false, device = false): string {
		// flex-1, not flex-none: the row's link fills the row so its
		// trailing actions (the add button, the kebab) pin to the sidebar's
		// right edge. A second flex utility on the call site would lose to
		// stylesheet order regardless of class order, so growth lives here
		// alone — call sites carry no flex sizing of their own.
		// `holdsSelection`: a folded row with the selection hidden inside it —
		// a lighter wash, so it does not read as the selected row itself.
		// `device`: a machine row, a touch taller and always bold — it is the
		// group's heading now that the gutter under it is gone.
		const emphasis = device
			? "h-8 text-[0.95rem] font-semibold"
			: `h-7 text-sm${holdsSelection ? " font-medium" : ""}`;
		const wash = active
			? "bg-gray-100 font-semibold text-gray-900 dark:bg-gray-700 dark:text-white"
			: holdsSelection
				? "bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
				: "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700";
		return `flex ${emphasis} flex-1 items-center gap-1.5 rounded-lg px-2 text-left ${wash}`;
	}
</script>

<div class="flex flex-col gap-px">
	{#if page.data.codeSchedulesEnabled === true && codeDeviceList.devices.length > 0}
		<!-- The top of the sidebar: one address, not a branch. The pane it
		     opens holds the list, the editor and each schedule's history. -->
		<a
			href="{base}/code?view=schedules"
			class="mb-1.5 {schedulesActive ? SIDEBAR_ITEM_ACTIVE : SIDEBAR_ITEM}"
			data-testid="schedules-link"
		>
			<IconTime class="size-3.5 shrink-0" />
			{m["code.nav.schedules"]()}
		</a>
	{/if}
	<div class="flex items-center justify-between px-2 pt-1">
		<span class="text-xs font-semibold text-gray-400 dark:text-gray-500"
			>{m["code.nav.devices"]()}</span
		>
		<button
			class="flex h-6 items-center gap-1 rounded-lg px-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
			title={m["code.nav.pair_title"]()}
			onclick={() => (pairingOpen = true)}
		>
			<IconAdd class="size-3.5" />
			{m["code.nav.pair"]()}
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
			{m["code.nav.loading"]()}
		</p>
	{:else if codeDeviceList.devices.length === 0}
		<div class="px-2 py-3 text-sm text-gray-500 dark:text-gray-400">
			<p class="flex items-center gap-1.5">
				<IconLaptop class="size-4 shrink-0" />
				{m["code.nav.no_devices"]()}
			</p>
			<button
				class="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-2 text-sm font-medium text-white hover:bg-blue-700"
				onclick={() => (pairingOpen = true)}
			>
				<IconAdd class="size-4" />
				{m["code.nav.pair_device"]()}
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
				{m["code.nav.show_subagents"]()}
			</button>
		{/if}
		{#each sortedDevices as device (device.id)}
			{@const tree = trees[device.id]}
			{@const deviceActive = device.id === selectedDeviceId}
			{@const deviceExpanded = isDeviceExpanded(device.id)}
			{@const isDead = device.reenroll === "revoked"}
			{@const online = device.online !== false}
			{@const offline = device.status === "paired" && !isDead && !online}
			{@const expired = device.credentialState === "expired"}
			{@const deviceMenu = `d:${device.id}`}
			{@const dotLabel = expired
				? m["code.nav.credential_expired"]()
				: online
					? m["code.nav.connected"]()
					: m["code.nav.not_connected"]()}
			{@const offlineAge = formatCompactAge(device.lastSeenAt)}
			<!-- The pb separates one machine's group from the next, now that
			     the gutter under the machine row is gone. -->
			<div class="pb-2">
				<!-- `nav-row`: the hover/focus scope of this row's `＋` and `⋯`
				     (see the style block); `group` stays for callers that find
				     the row by it. An offline machine is dimmed. -->
				<div
					class="nav-row group flex items-center gap-1 pr-1 {offline ? 'opacity-60' : ''}"
					data-testid="device-row"
					use:longPress={openMenu(deviceMenu)}
				>
					{#if device.status === "paired"}
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
							aria-expanded={deviceExpanded}
							aria-label={deviceExpanded
								? m["code.nav.collapse"]({ name: device.name })
								: m["code.nav.expand"]({ name: device.name })}
							onclick={() => toggleDeviceCollapsed(device.id)}
						>
							<IconChevronRight
								class="size-3 shrink-0 transition-transform {deviceExpanded ? 'rotate-90' : ''}"
							/>
						</button>
					{:else}
						<!-- A pending device has no subtree to collapse — a fixed
						     spacer keeps its row's name aligned with every paired
						     device's, whose chevron takes this same slot. -->
						<span class="size-6 shrink-0"></span>
					{/if}
					{#if device.status === "pending" || isDead}
						<span class="min-w-0 {row(false, false, true)}">
							<span class="size-2 shrink-0"></span>
							<span class="min-w-0 flex-1 truncate">{device.name}</span>
						</span>
					{:else}
						<a
							href="{base}/code?device={device.id}"
							class="min-w-0 {row(
								deviceActive && !selectedAgentId,
								deviceActive && !!selectedAgentId && !deviceExpanded,
								true
							)}"
							data-holds-selection={deviceActive && !!selectedAgentId && !deviceExpanded
								? ""
								: undefined}
							title={device.name}
						>
							<!-- The machine's state as a dot: filled green connected,
							     hollow grey not. Words are kept for the states that
							     need them (a pill, below). -->
							<span
								role="img"
								aria-label={dotLabel}
								title={dotLabel}
								data-testid="device-status"
								data-status={expired ? "expired" : online ? "online" : "offline"}
								class="size-2 shrink-0 rounded-full {expired
									? 'bg-red-500'
									: online
										? 'bg-green-500'
										: 'border border-gray-400 dark:border-gray-500'}"
							></span>
							<span class="min-w-0 flex-1 truncate">{device.name}</span>
							{#if offline}
								<span
									class="shrink-0 text-[11px] font-normal text-gray-500 dark:text-gray-400"
									data-testid="offline-since"
									>{offlineAge
										? m["code.nav.offline_since"]({ age: offlineAge })
										: m["code.nav.offline"]()}</span
								>
							{/if}
						</a>
					{/if}
					{#if device.status === "pending"}
						<!-- The fresh human approval review C2 calls for: a
						     machine that connected with a valid bearer waits
						     here until Confirm, and nothing is forwarded to
						     it before that click. These two stay on the row:
						     they are the whole point of a pending machine. -->
						<span
							class="shrink-0 rounded-full bg-amber-100 px-1.5 text-[.65rem] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
						>
							{m["code.nav.pending"]()}
						</span>
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
							title={m["code.nav.confirm_title"]()}
							aria-label={m["code.nav.confirm_title"]()}
							onclick={() => void handleConfirm(device.id)}
						>
							<IconCheck class="size-3.5" />
						</button>
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
							title={m["code.nav.reject_title"]()}
							aria-label={m["code.nav.reject_title"]()}
							onclick={() => (confirmRequest = { kind: "device", device })}
						>
							<IconClose class="size-3.5" />
						</button>
					{:else if isDead}
						<!-- A revoked-by-the-gateway row is a tombstone (never
						     reconnects under this machineId): no "Add workspace",
						     nothing to pair — the re-enroll banner below, and
						     removal from the list, which is its menu's only item. -->
						<span
							class="shrink-0 rounded-full bg-red-100 px-1.5 text-[.65rem] text-red-800 dark:bg-red-900/60 dark:text-red-300"
						>
							{m["code.nav.revoked"]()}
						</span>
						<RowMenu
							open={menuOpen(deviceMenu)}
							onOpenChange={setMenuOpen(deviceMenu)}
							label={m["code.nav.machine_settings"]()}
						>
							<DropdownMenu.Item
								class={MENU_ITEM_DANGER}
								onSelect={() => (confirmRequest = { kind: "device", device })}
							>
								<IconTrash class="size-4 opacity-90 dark:opacity-80" />
								{m["code.nav.remove"]()}
							</DropdownMenu.Item>
						</RowMenu>
					{:else}
						{#if expired}
							<span
								class="shrink-0 rounded-full bg-red-100 px-1.5 text-[.65rem] text-red-800 dark:bg-red-900/60 dark:text-red-300"
								title={m["code.nav.credential_title"]()}
							>
								{m["code.nav.credential_expired"]()}
							</span>
						{/if}
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
								{m["code.nav.workspace_count"]({ count: deviceCounts[device.id] })}
							</span>
						{/if}
						<!-- A shortcut on a pointer that hovers (also in the menu,
						     which is all a touch screen shows). -->
						<button
							class="nav-reveal nav-plus flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
							title={m["code.nav.add_workspace_title"]()}
							aria-label={m["code.nav.add_workspace_title"]()}
							disabled={!online}
							onclick={() => (workspaceDialogFor = device.id)}
						>
							<IconAdd class="size-3.5" />
						</button>
						<!-- Every action of the machine, the removal last. The row
						     itself is a link to the machine's page. -->
						<RowMenu
							open={menuOpen(deviceMenu)}
							onOpenChange={setMenuOpen(deviceMenu)}
							label={m["code.nav.machine_settings"]()}
						>
							<DropdownMenu.Item
								class={MENU_ITEM}
								disabled={!online}
								onSelect={() => (workspaceDialogFor = device.id)}
							>
								<IconAdd class="size-4 opacity-90 dark:opacity-80" />
								{m["code.nav.add_workspace"]()}
							</DropdownMenu.Item>
							<DropdownMenu.Item class={MENU_ITEM} onSelect={() => (profilesFor = device)}>
								<IconUsers class="size-4 opacity-90 dark:opacity-80" />
								{m["code.nav.profiles"]()}
							</DropdownMenu.Item>
							<DropdownMenu.Separator class="my-1 h-px bg-gray-200 dark:bg-gray-700" />
							<DropdownMenu.Item
								class={MENU_ITEM_DANGER}
								onSelect={() => (confirmRequest = { kind: "device", device })}
							>
								<IconTrash class="size-4 opacity-90 dark:opacity-80" />
								{m["code.nav.remove"]()}
							</DropdownMenu.Item>
						</RowMenu>
					{/if}
				</div>
				{#if device.reenroll}
					<div
						class="mb-1.5 ml-7 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
					>
						<p class="mb-1.5 flex items-center gap-1.5 font-medium">
							<IconWarning class="size-3.5 shrink-0" />
							{device.reenroll === "revoked"
								? m["code.nav.reenroll_revoked"]()
								: m["code.nav.reenroll_idp"]()}
						</p>
						<div class="flex items-center gap-2 rounded-md border border-line bg-surface p-2">
							<pre
								class="min-w-0 flex-1 overflow-x-auto font-mono text-[.65rem] whitespace-pre text-ink">{reenrollCommand}</pre>
							<CopyToClipBoardBtn
								classNames="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
								value={reenrollCommand}
							/>
						</div>
					</div>
				{/if}
				{#if !device.reenroll && !isDead && codeLegacyMachines[device.id]}
					<!-- Learned from a session's rules (the Permissions dialog): this machine's
					     policy predates ceilings and its opencode.json has no ask block, so
					     it allows everything until re-enrolled. The same one-liner as the
					     `reenroll` banner above, since it is the same fix. -->
					<div
						class="mb-1.5 ml-7 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
						data-testid="legacy-machine-row-flag"
					>
						<p class="mb-1.5 flex items-center gap-1.5 font-medium">
							<IconWarning class="size-3.5 shrink-0" />
							{m["code.nav.reenroll_legacy"]()}
						</p>
						<p class="mb-1.5">{m["code.nav.legacy_detail"]()}</p>
						<div class="flex items-center gap-2 rounded-md border border-line bg-surface p-2">
							<pre
								class="min-w-0 flex-1 overflow-x-auto font-mono text-[.65rem] whitespace-pre text-ink">{reenrollCommand}</pre>
							<CopyToClipBoardBtn
								classNames="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
								value={reenrollCommand}
							/>
						</div>
					</div>
				{/if}
				{#if device.status === "paired" && !isDead && deviceExpanded}
					<!-- No gutter here: the machine row is the group's heading and
					     its workspaces start at the left edge, so the guide that
					     used to run under it (the ProjectsBranch idiom: nesting
					     drawn, not padded) has nothing left to mark. The vertical
					     space between machines, above, keeps the groups apart. -->
					<div data-testid="device-rail">
						{#if device.online === false || (tree?.off && tree.workspaces.length === 0)}
							<!-- Offline renders as a plain label, never a spinner (X4):
						     an unreachable machine is never even asked for its
						     tree (see `loadableDevices` above), so there is
						     nothing here to wait on. -->
							<p class="py-0.5 pl-2 text-xs text-gray-400 dark:text-gray-500">
								{m["code.nav.offline_dot"]()}
							</p>
						{:else if tree && tree.workspaces.length === 0}
							<button
								class="flex items-center gap-1.5 py-0.5 pl-2 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
								onclick={() => (workspaceDialogFor = device.id)}
							>
								<IconAdd class="size-3" />
								{m["code.nav.add_workspace"]()}
							</button>
						{:else}
							{#if tree?.off}
								<!-- The last read failed: the rows below are the last good ones. -->
								<p class="py-0.5 pl-2 text-xs text-gray-400 dark:text-gray-500">
									{m["code.nav.offline_dot"]()}
								</p>
							{/if}
							{#each tree?.workspaces ?? [] as ws (ws.id)}
								{@const wsActive = ws.id === selectedWorkspaceId && deviceActive}
								{@const wsExpanded = isWorkspaceExpanded(device.id, ws.id)}
								{@const wsSessionCount = agentsOf(tree, ws.id).length}
								{@const wsLabel = workspaceLabel(ws)}
								{@const wsMenu = `w:${device.id}:${ws.id}`}
								<div>
									<div
										class="nav-row group flex items-center gap-1 pr-1"
										use:longPress={openMenu(wsMenu)}
									>
										<button
											type="button"
											class="flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
											aria-expanded={wsExpanded}
											aria-label={wsExpanded
												? m["code.nav.collapse"]({ name: wsLabel })
												: m["code.nav.expand"]({ name: wsLabel })}
											onclick={() => toggleWorkspaceCollapsed(device.id, ws.id)}
										>
											<IconChevronRight
												class="size-3 shrink-0 transition-transform {wsExpanded ? 'rotate-90' : ''}"
											/>
										</button>
										<!-- The folder's name, its full path as the tooltip (and
										     the first line of the menu, for a screen with no hover). -->
										<span
											class="min-w-0 {row(
												wsActive && !selectedAgentId,
												wsActive && !!selectedAgentId && !wsExpanded
											)}"
											title={ws.path || ws.name}
											data-holds-selection={wsActive && !!selectedAgentId && !wsExpanded
												? ""
												: undefined}
										>
											<IconFolder class="size-3 shrink-0" />
											<span class="min-w-0 flex-1 truncate">{wsLabel}</span>
											{#if ws.branch}
												<!-- Worktree workspaces sit beside their source repo in
											     this same flat list (not nested under it) — the
											     branch badge is what marks the relationship, kept
											     simple rather than building a second tree level. -->
												<span
													class="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400"
													title={m["code.nav.worktree_on"]({ branch: ws.branch })}
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
													{m["code.nav.session_count"]({ count: wsSessionCount })}
												</span>
											{/if}
										</span>
										<button
											class="nav-reveal nav-plus flex size-6 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-600 dark:hover:bg-gray-700"
											title={m["code.nav.start_session_title"]()}
											aria-label={m["code.nav.start_session_title"]()}
											onclick={() => (agentDialogFor = ws)}
										>
											<IconAdd class="size-3.5" />
										</button>
										<RowMenu
											open={menuOpen(wsMenu)}
											onOpenChange={setMenuOpen(wsMenu)}
											label={m["code.nav.workspace_actions"]()}
										>
											<DropdownMenu.Group>
												<DropdownMenu.GroupHeading
													class="px-2 pt-1 pb-1.5 text-xs break-all text-gray-500 select-text dark:text-gray-400"
													data-testid="workspace-path"
												>
													{ws.path || ws.name}
												</DropdownMenu.GroupHeading>
											</DropdownMenu.Group>
											<DropdownMenu.Item class={MENU_ITEM} onSelect={() => (agentDialogFor = ws)}>
												<IconAdd class="size-4 opacity-90 dark:opacity-80" />
												{m["code.nav.new_session"]()}
											</DropdownMenu.Item>
											<DropdownMenu.Item
												class={MENU_ITEM}
												onSelect={() => (renameFor = { device, workspace: ws })}
											>
												<IconEdit class="size-4 opacity-90 dark:opacity-80" />
												{m["code.nav.rename"]()}
											</DropdownMenu.Item>
											{#if ws.isGitRepo}
												<!-- Only a git repo can be branched into a worktree;
											     a plain directory workspace has no repo to run
											     `git worktree add` against. -->
												<DropdownMenu.Item
													class={MENU_ITEM}
													onSelect={() => (worktreeFor = { device, workspace: ws })}
												>
													<IconBranch class="size-4 opacity-90 dark:opacity-80" />
													{m["code.nav.new_worktree"]()}
												</DropdownMenu.Item>
											{/if}
											<DropdownMenu.Item
												class={MENU_ITEM}
												onSelect={() =>
													(confirmRequest = { kind: "workspace", device, workspace: ws })}
											>
												<IconTrash class="size-4 opacity-90 dark:opacity-80" />
												{m["code.nav.archive"]()}
											</DropdownMenu.Item>
										</RowMenu>
									</div>
									{#if wsExpanded}
										<!-- One rail under the workspace, tight: a session's title
										     starts right of the workspace's folder icon. Delegates and
										     subtasks hang off their parent by a thin connector of
										     their own (a left border, no further indent step). -->
										{#snippet sessionRow(
											agent: CodeAgentSession,
											kind: "root" | "delegate" | "subtask"
										)}
											{@const agentActive = agent.id === selectedAgentId}
											{@const kids = parentRow(agent, tree?.agents ?? [], tree?.workspaces ?? [])}
											{@const cancelledSub =
												!!agent.parentId &&
												!!agent.cancelled &&
												agent.state !== "running" &&
												agent.state !== "waiting-permission"}
											{@const ownWaiting = agent.state === "waiting-permission"}
											{@const needsYou = !cancelledSub && (ownWaiting || !!kids?.waiting)}
											{@const age = ageOf(agent.updatedAt)}
											{@const sessionMenu = `a:${device.id}:${agent.id}`}
											{@const iconSize = kind === "subtask" ? "size-3" : "size-3.5"}
											<div
												class="nav-row group flex items-center gap-1 pr-1"
												data-testid="session-row"
												data-kind={kind}
												use:longPress={openMenu(sessionMenu)}
											>
												<a
													href="{base}/code?device={device.id}&ws={ws.id}&agent={agent.id}"
													class="min-w-0 {row(agentActive)} {kind === 'subtask'
														? 'text-[0.8rem]'
														: ''}"
													title={agent.title}
												>
													<span class="min-w-0 flex-1 truncate">{agent.title}</span>
													{#if isScheduledTitle(agent.title)}
														<IconTime
															class="size-3 shrink-0 text-gray-400"
															title={m["code.nav.scheduled_title"]()}
															data-testid="scheduled-badge"
														/>
													{/if}
													{#if cancelledSub}
														<span
															class="shrink-0 rounded-sm bg-gray-100 px-1 text-[10px] font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-300"
															title={m["code.nav.cancelled_title"]()}
															data-testid="subagent-cancelled">{m["code.nav.cancelled"]()}</span
														>
													{:else if needsYou}
														<!-- Waiting for the person: an approval or a
														     question is open on it (or on a subagent
														     under it). Amber, and named for a screen reader. -->
														<span
															class="flex shrink-0 items-center text-amber-500 dark:text-amber-400"
															title={ownWaiting
																? m["code.nav.waiting_title"]()
																: m["code.nav.sub_waiting_title"]()}
															data-testid="waiting-approval"
															data-state="needs-you"
														>
															<IconHelp class={iconSize} aria-hidden="true" />
															<span class="sr-only">{m["code.nav.needs_you"]()}</span>
														</span>
													{:else if agent.state === "running"}
														<span
															class="flex shrink-0 items-center text-blue-600 dark:text-blue-400"
															title={m["code.nav.state_running"]()}
															data-state="running"
														>
															<IconRenew class="{iconSize} animate-spin" aria-hidden="true" />
															<span class="sr-only">{m["code.nav.state_running"]()}</span>
														</span>
													{:else if agent.state === "error"}
														<span
															class="flex shrink-0 items-center text-red-600 dark:text-red-400"
															title={m["code.nav.state_error"]()}
															data-state="error"
														>
															<IconWarning class={iconSize} aria-hidden="true" />
															<span class="sr-only">{m["code.nav.state_error"]()}</span>
														</span>
													{/if}
													<!-- Idle is the common case and draws nothing. -->
													{#if age}
														<time
															class="shrink-0 text-[11px] font-normal text-gray-400 tabular-nums dark:text-gray-500"
															datetime={agent.updatedAt}
															data-testid="session-age">{age}</time
														>
													{/if}
												</a>
												<RowMenu
													open={menuOpen(sessionMenu)}
													onOpenChange={setMenuOpen(sessionMenu)}
													label={m["code.nav.session_actions"]()}
												>
													{#if page.data.codeSchedulesEnabled === true}
														<DropdownMenu.Item
															class={MENU_ITEM}
															onSelect={() =>
																goto(
																	`${base}/code?view=schedules&new=1&device=${device.id}&ws=${agent.workspaceId}&agent=${agent.id}`
																)}
														>
															<IconTime class="size-4 opacity-90 dark:opacity-80" />
															{m["code.nav.schedule_this"]()}
														</DropdownMenu.Item>
													{/if}
													{#if !agent.parentId}
														<!-- Permissions belong to the session, so the item
														     lives on its row's menu, next to rename and
														     archive; the dialog reads that session's rules
														     itself. A subagent follows its root's setting
														     and has no rules of its own to read. -->
														<DropdownMenu.Item
															class={MENU_ITEM}
															onSelect={() => (permissionsFor = { device, agent })}
														>
															<IconPermissions class="size-4 opacity-90 dark:opacity-80" />
															{m["code.nav.permissions"]()}
														</DropdownMenu.Item>
													{/if}
													<DropdownMenu.Item
														class={MENU_ITEM}
														onSelect={() => (renameAgentFor = { device, agent })}
													>
														<IconEdit class="size-4 opacity-90 dark:opacity-80" />
														{m["code.nav.rename"]()}
													</DropdownMenu.Item>
													<DropdownMenu.Item
														class={MENU_ITEM}
														onSelect={() => (confirmRequest = { kind: "agent", device, agent })}
													>
														<IconTrash class="size-4 opacity-90 dark:opacity-80" />
														{m["code.nav.archive"]()}
													</DropdownMenu.Item>
													<DropdownMenu.Item
														class={MENU_ITEM_DANGER}
														onSelect={() =>
															(confirmRequest = { kind: "agent-delete", device, agent })}
													>
														<IconTrash class="size-4 opacity-90 dark:opacity-80" />
														{m["code.nav.delete"]()}
													</DropdownMenu.Item>
												</RowMenu>
											</div>
										{/snippet}
										<div
											class="ml-3 border-l border-gray-200 pl-2 dark:border-gray-700"
											data-testid="workspace-rail"
										>
											{#each nestSessions(agentsOf(tree, ws.id)) as node (node.agent.id)}
												{@const agent = node.agent}
												{@const sub = subagentRow(
													agent,
													tree?.agents ?? [],
													tree?.workspaces ?? []
												)}
												{@const spawned = spawnedRow(
													agent,
													tree?.agents ?? [],
													tree?.workspaces ?? []
												)}
												{@const childKey = `${device.id}:${agent.id}`}
												{@const childrenOpen = expandedChildren.has(childKey)}
												{@const shownChildren = node.children.filter(
													(child, index) =>
														childrenOpen ||
														index < CHILDREN_SHOWN ||
														child.agent.id === selectedAgentId
												)}
												{@const hiddenChildren = node.children.length - shownChildren.length}
												<div>
													{@render sessionRow(agent, "root")}
													<!-- A row whose parent is not listed here (another
													     workspace, archived, hidden) stays top-level, and
													     still says where it came from. -->
													{#if spawned}
														{#if !spawned.gone && spawned.workspaceId}
															<a
																href="{base}/code?device={device.id}&ws={spawned.workspaceId}&agent={spawned.sessionId}"
																class="flex min-w-0 items-center gap-1 pl-2 text-[11px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
																data-testid="spawned-from"
															>
																<IconFork class="size-3 shrink-0" />
																<span class="truncate"
																	>{spawned.elsewhere
																		? m["code.nav.spawned_by_elsewhere"]({
																				title: spawned.title,
																				where: spawned.elsewhere,
																			})
																		: m["code.nav.spawned_by"]({ title: spawned.title })}</span
																>
															</a>
														{:else}
															<p
																class="flex min-w-0 items-center gap-1 pl-2 text-[11px] text-gray-400 italic dark:text-gray-500"
																data-testid="spawned-from"
															>
																<IconFork class="size-3 shrink-0" />
																<span class="truncate"
																	>{m["code.nav.spawned_by_gone"]({ title: spawned.title })}</span
																>
															</p>
														{/if}
													{/if}
													{#if sub}
														{#if sub.parentWorkspaceId}
															<a
																href="{base}/code?device={device.id}&ws={sub.parentWorkspaceId}&agent={sub.parentId}"
																class="block truncate pl-2 text-[11px] text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
																data-testid="subagent-from"
																>{sub.elsewhere
																	? m["code.nav.from_elsewhere"]({
																			title: sub.parentTitle ?? "",
																			where: sub.elsewhere,
																		})
																	: m["code.nav.from"]({ title: sub.parentTitle ?? "" })}</a
															>
														{:else}
															<p
																class="truncate pl-2 text-[11px] text-gray-400 dark:text-gray-500"
																data-testid="subagent-from"
															>
																{m["code.nav.from_unlisted"]()}
															</p>
														{/if}
													{/if}
													{#if node.children.length > 0}
														<div
															class="ml-2 border-l border-gray-200 pl-1.5 dark:border-gray-700"
															role="group"
															aria-label={m["code.nav.children_of"]({ title: agent.title })}
															data-testid="session-children"
														>
															{#each shownChildren as child (child.agent.id)}
																{@render sessionRow(child.agent, child.kind)}
															{/each}
															{#if hiddenChildren > 0}
																<button
																	type="button"
																	class="flex h-6 items-center rounded-md px-2 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
																	data-testid="children-more"
																	aria-expanded="false"
																	onclick={() => toggleChildren(childKey)}
																>
																	{m["code.nav.more_children"]({ count: hiddenChildren })}
																</button>
															{:else if childrenOpen && node.children.length > CHILDREN_SHOWN}
																<button
																	type="button"
																	class="flex h-6 items-center rounded-md px-2 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
																	data-testid="children-more"
																	aria-expanded="true"
																	onclick={() => toggleChildren(childKey)}
																>
																	{m["code.nav.fewer_children"]()}
																</button>
															{/if}
														</div>
													{/if}
												</div>
											{/each}
											{#if wsActive && agentsOf(tree, ws.id).length === 0}
												<p class="py-0.5 pl-2 text-xs text-gray-400 dark:text-gray-500">
													{m["code.nav.no_agents"]()}
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

{#if permissionsFor}
	<!-- The Permissions detail renders as a dialog over the panel: the person
	     usually opens it mid-turn and keeps the transcript and its approval
	     cards in view. It reads its session's rules itself, so it can be
	     opened for any row's menu, selected or not. On a phone the drawer's
	     own tree holds the menu, and the dialog overlays the open drawer. -->
	<PermissionsDialog
		deviceId={permissionsFor.device.id}
		agentId={permissionsFor.agent.id}
		sessionTitle={permissionsFor.agent.title}
		device={permissionsFor.device}
		subagent={Boolean(permissionsFor.agent.parentId)}
		policy={permissionsFor.device.policy}
		onreenroll={() => (pairingOpen = true)}
		onclose={() => (permissionsFor = null)}
	/>
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
			title={m["code.nav.archive_session"]()}
			target={request.agent.title}
			message={m["code.nav.archive_session_message"]()}
			confirmLabel={m["code.nav.archive_session"]()}
			busyLabel={m["code.nav.archiving"]()}
			onconfirm={() => handleArchiveAgent(request.device, request.agent)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else if request.kind === "agent-delete"}
		<CodeConfirmDialog
			title={m["code.nav.delete_session"]()}
			target={request.agent.title}
			message={m["code.nav.delete_session_message"]()}
			confirmLabel={m["code.nav.delete_session"]()}
			busyLabel={m["code.nav.deleting"]()}
			onconfirm={() => handleDeleteAgent(request.device, request.agent)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else if request.kind === "device"}
		<CodeConfirmDialog
			title={request.device.status === "pending"
				? m["code.nav.reject_title"]()
				: request.device.reenroll === "revoked"
					? m["code.nav.remove_machine"]()
					: m["code.nav.remove_pairing_title"]()}
			target={request.device.name}
			message={request.device.status === "pending"
				? m["code.nav.reject_message"]()
				: request.device.reenroll === "revoked"
					? m["code.nav.remove_message"]()
					: m["code.nav.revoke_message"]()}
			confirmLabel={request.device.status === "pending"
				? m["code.nav.reject_machine"]()
				: request.device.reenroll === "revoked"
					? m["code.nav.remove_machine_button"]()
					: m["code.nav.revoke_pairing"]()}
			busyLabel={request.device.reenroll === "revoked"
				? m["code.nav.removing"]()
				: m["code.nav.revoking"]()}
			onconfirm={() => handleRevoke(request.device.id)}
			onclose={() => (confirmRequest = null)}
		/>
	{:else}
		<CodeConfirmDialog
			title={m["code.nav.archive_workspace"]()}
			target={request.workspace.name}
			message={m["code.nav.archive_workspace_message"]()}
			confirmLabel={m["code.nav.archive_workspace"]()}
			busyLabel={m["code.nav.archiving"]()}
			checkboxLabel={request.workspace.worktreeOf ? m["code.nav.remove_worktree"]() : undefined}
			onconfirm={(removeWorktree) =>
				handleArchiveWorkspace(request.device, request.workspace, removeWorktree)}
			onclose={() => (confirmRequest = null)}
		/>
	{/if}
{/if}

{#if profilesFor}
	<MachineProfilesDialog device={profilesFor} onclose={() => (profilesFor = null)} />
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

<style>
	/* A row's ＋ and ⋯ show on hover and on keyboard focus anywhere inside the
	   row on a pointer that can hover; a touch screen has no hover, so ⋯ is
	   always there (a 44px target) and the ＋ shortcut is left to its menu.
	   The buttons keep their slot either way, so a row never shifts. */
	@media (hover: hover) {
		:global(.nav-reveal) {
			opacity: 0;
		}
		:global(.nav-row:hover .nav-reveal),
		:global(.nav-row:focus-within .nav-reveal),
		:global(.nav-reveal[data-state="open"]),
		:global(.nav-reveal:focus-visible) {
			opacity: 1;
		}
	}
	@media (hover: none) {
		:global(.nav-plus) {
			display: none;
		}
		:global(.nav-kebab) {
			width: 2.75rem;
			height: 2.75rem;
			margin-right: -0.25rem;
		}
	}
</style>
