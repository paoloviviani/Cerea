<!--
	The sidebar's Recent list: one list, newest first, of the chats (project chats
	included) and the coding-agent sessions that were active lately
	(`utils/recentItems.ts`: the last 48 hours, filled to ten rows).

	It reads what the sidebar already holds, so it adds no endpoint and no
	server store: the chats are the layout's own list (`lastActivityAt`, kept
	live by the same watcher as the Chats branch, so a new message moves a chat
	to the top), the project names come from the projects the sidebar already
	reads, and the sessions are the Agents tree's cache, read through the same
	proxy for each online machine (the server keeps no second agent store). A
	user without agent access, or a deployment without agents, simply has no
	machines: the list is chats only.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import CarbonChat from "~icons/carbon/chat";
	import CarbonCode from "~icons/carbon/code";
	import CarbonFolder from "~icons/carbon/folder";
	import IconHelp from "~icons/carbon/help-filled";
	import IconRenew from "~icons/carbon/renew";
	import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import type { ProjectView } from "$lib/types/Project";
	import {
		buildRecent,
		RECENT_MIN_ITEMS,
		RECENT_WINDOW_MS,
		type RecentMachine,
	} from "$lib/utils/recentItems";
	import { formatRelativeTime } from "$lib/utils/relativeTime";
	import { bindProjectsCacheOwner, projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
	import { reconcileById } from "$lib/utils/reconcileById";
	import {
		bindCodeCacheOwner,
		codeTreeCache,
		isCodeTreeFresh,
		loadDeviceTree,
	} from "$lib/stores/codeTreeCache.svelte";
	import {
		codeDeviceList,
		refreshCodeDevices,
		useCodeDevicePoll,
	} from "$lib/stores/codeDeviceList.svelte";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";

	interface Props {
		conversations: ConvSidebar[];
		/** More chats exist than the sidebar has loaded. */
		hasMore: boolean;
		onloadmore: () => void;
		/** The deployment has coding agents; without it only chats are listed. */
		agentsEnabled: boolean;
	}

	let { conversations, hasMore, onloadmore, agentsEnabled }: Props = $props();

	const TREE_POLL_MS = 8000;
	let now = $state(Date.now());

	// Project names: the sidebar's own projects cache, filled here only when
	// the Chats branch has not (it is not mounted in this view).
	const projectNames = $derived(
		Object.fromEntries(projectsTreeCache.projects.map((project) => [project.id, project.name]))
	);
	// Which projects the listed chats name that the cache does not know yet. The
	// list is read again only when this set changes (a chat moved into a new
	// project), and never twice for the same set: a project that is gone would
	// otherwise be asked for forever.
	const unknownProjects = $derived(
		[
			...new Set(
				conversations.flatMap((conv) =>
					conv.projectId && !(conv.projectId in projectNames) ? [conv.projectId] : []
				)
			),
		]
			.sort()
			.join(",")
	);
	// A read that began before the account changed must not land in the next
	// account's cache.
	let owner = $state<string | undefined>(undefined);
	let projectsRead = 0;
	let askedFor = "";
	$effect(() => {
		const userId = page.data.user?.id as string | undefined;
		bindProjectsCacheOwner(userId);
		if (owner !== userId) {
			owner = userId;
			projectsRead += 1;
			askedFor = "";
		}
	});
	async function loadProjects() {
		const read = ++projectsRead;
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok || read !== projectsRead) return;
			const listed = ((await response.json()) as { data: ProjectView[] }).data;
			if (read !== projectsRead) return;
			const merged = reconcileById(projectsTreeCache.projects, listed);
			if (merged !== projectsTreeCache.projects) projectsTreeCache.projects = merged;
			projectsTreeCache.fetchedAt = Date.now();
			projectsTreeCache.failed = false;
			projectsTreeCache.loaded = true;
		} catch {
			// Project chats then show without their badge: the list still works.
		}
	}
	$effect(() => {
		if (unknownProjects && unknownProjects !== askedFor) {
			askedFor = unknownProjects;
			void loadProjects();
		}
	});

	// Sessions: the same shared device poll and subtree reads the Agents tree
	// uses, for the paired machines that are online.
	const agentsOn = $derived(agentsEnabled && codeReauth.checked && !codeReauth.required);
	// A machine that must be enrolled again has nothing to answer.
	const usable = (device: (typeof codeDeviceList.devices)[number]) =>
		device.status === "paired" && device.reenroll !== "revoked";
	const loadable = $derived(
		agentsOn ? codeDeviceList.devices.filter((d) => usable(d) && d.online !== false) : []
	);
	$effect(() => {
		bindCodeCacheOwner(page.data.user?.id);
	});
	async function refreshTrees(ifStale: boolean) {
		await Promise.all(
			loadable
				.filter((device) => !(ifStale && isCodeTreeFresh(device.id)))
				.map((device) => loadDeviceTree(device.id))
		);
	}
	$effect(() => {
		for (const device of loadable) {
			if (!(device.id in codeTreeCache.trees)) void loadDeviceTree(device.id);
		}
	});
	onMount(() => {
		const clock = setInterval(() => (now = Date.now()), 30_000);
		if (!agentsEnabled) return () => clearInterval(clock);
		const stopPoll = useCodeDevicePoll();
		void refreshTrees(true);
		const interval = setInterval(() => {
			if (!document.hidden) void refreshTrees(false);
		}, TREE_POLL_MS);
		const onFocus = () => {
			void refreshCodeDevices();
			void refreshTrees(false);
		};
		window.addEventListener("focus", onFocus);
		return () => {
			clearInterval(clock);
			stopPoll();
			clearInterval(interval);
			window.removeEventListener("focus", onFocus);
		};
	});

	const machines = $derived<RecentMachine[]>(
		agentsOn
			? codeDeviceList.devices
					.filter((device) => usable(device) && codeTreeCache.trees[device.id])
					.map((device) => ({
						id: device.id,
						name: device.name,
						online: device.online !== false,
						agents: codeTreeCache.trees[device.id].agents,
					}))
			: []
	);

	const items = $derived(
		buildRecent({
			chats: conversations,
			chatsComplete: !hasMore,
			projects: projectNames,
			machines,
			now,
		})
	);

	// More chat pages are fetched only while they can still matter: the oldest
	// chat loaded is inside the window, or the list is still short. Otherwise a
	// short list would page through the whole history.
	const oldestChat = $derived(
		conversations.reduce(
			(oldest, conv) =>
				Math.min(oldest, new Date(conv.lastActivityAt ?? conv.updatedAt).getTime() || 0),
			Infinity
		)
	);
	const wantMore = $derived(
		hasMore && (now - oldestChat <= RECENT_WINDOW_MS || items.length < RECENT_MIN_ITEMS)
	);

	const ROW =
		"group flex h-8 min-w-0 flex-none items-center gap-1.5 rounded-lg pr-2 pl-2 text-smd no-underline max-sm:h-10 sm:text-sm";
	const rowClass = (active: boolean) =>
		`${ROW} ${
			active
				? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-700 dark:text-white"
				: "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
		}`;
	const BADGE =
		"inline-flex max-w-[7rem] shrink-0 items-center gap-1 truncate rounded-full bg-gray-100 px-1.5 text-[.65rem] text-gray-500 dark:bg-gray-700 dark:text-gray-300";
</script>

<div class="flex flex-col gap-px" data-testid="recent-list">
	{#each items as item (item.kind === "agent" ? `agent:${item.machine.id}:${item.id}` : `chat:${item.id}`)}
		{#if item.kind === "chat"}
			<a
				href="{base}/conversation/{item.id}"
				class={rowClass(page.params.id === item.id)}
				title={item.title}
				data-testid="recent-row"
				data-kind="chat"
			>
				<CarbonChat class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="sr-only">{m["app.nav.recent_chat"]()}</span>
				{#if item.unread && page.params.id !== item.id}
					<span
						class="size-1.5 flex-none rounded-full bg-accent-solid"
						title={m["app.nav_item.unread"]()}
						aria-label={m["app.nav_item.unread"]()}
						data-testid="unread-dot"
					></span>
				{/if}
				<span class="min-w-0 flex-1 truncate">{item.title}</span>
				{#if item.project?.name}
					<span class={BADGE} data-testid="recent-project" title={item.project.name}>
						<CarbonFolder class="size-2.5 shrink-0" />
						<span class="truncate">{item.project.name}</span>
					</span>
				{/if}
				<time
					class="shrink-0 text-[.65rem] text-gray-400 dark:text-gray-500"
					datetime={new Date(item.activityAt).toISOString()}
					data-testid="recent-time">{formatRelativeTime(item.activityAt, now)}</time
				>
			</a>
		{:else}
			<a
				href="{base}/code?device={item.machine.id}&ws={item.workspaceId}&agent={item.id}"
				class="{rowClass(
					page.route.id === '/code' && page.url.searchParams.get('agent') === item.id
				)} {item.machine.online ? '' : 'opacity-70'}"
				title={item.title}
				data-testid="recent-row"
				data-kind="agent"
			>
				<CarbonCode class="size-3.5 shrink-0" aria-hidden="true" />
				<span class="sr-only">{m["app.nav.recent_agent"]()}</span>
				<span class="min-w-0 flex-1 truncate">{item.title}</span>
				{#if item.state === "waiting-permission"}
					<span
						class="flex shrink-0 items-center text-amber-500 dark:text-amber-400"
						title={m["code.nav.waiting_title"]()}
						data-testid="recent-needs-you"
					>
						<IconHelp class="size-3.5" aria-hidden="true" />
						<span class="sr-only">{m["code.nav.needs_you"]()}</span>
					</span>
				{:else if item.state === "running"}
					<span
						class="flex shrink-0 items-center text-blue-600 dark:text-blue-400"
						title={m["code.nav.state_running"]()}
						data-testid="recent-running"
					>
						<IconRenew class="size-3.5 animate-spin" aria-hidden="true" />
						<span class="sr-only">{m["code.nav.state_running"]()}</span>
					</span>
				{/if}
				<span class={BADGE} data-testid="recent-machine" title={item.machine.name}>
					<span
						role="img"
						aria-label={item.machine.online
							? m["code.nav.connected"]()
							: m["code.nav.not_connected"]()}
						data-testid="recent-machine-dot"
						data-status={item.machine.online ? "online" : "offline"}
						class="size-1.5 shrink-0 rounded-full {item.machine.online
							? 'bg-green-500'
							: 'border border-gray-400 dark:border-gray-500'}"
					></span>
					<span class="truncate">{item.machine.name}</span>
				</span>
				<time
					class="shrink-0 text-[.65rem] text-gray-400 dark:text-gray-500"
					datetime={new Date(item.activityAt).toISOString()}
					data-testid="recent-time">{formatRelativeTime(item.activityAt, now)}</time
				>
			</a>
		{/if}
	{/each}
	{#if items.length === 0}
		<p class="px-3 py-2 text-sm text-ink-faint" data-testid="recent-empty">
			{m["app.nav.no_recent"]()}
		</p>
	{/if}
	{#if agentsEnabled && codeReauth.required}
		<a
			href="{base}/code"
			class="px-3 py-2 text-xs text-ink-faint no-underline hover:underline"
			data-testid="recent-reauth"
		>
			{m["app.nav.recent_sign_in"]()}
		</a>
	{/if}
	{#if wantMore}
		<InfiniteScroll onvisible={onloadmore} />
	{/if}
</div>
