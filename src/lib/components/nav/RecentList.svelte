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
	import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import type { ProjectView } from "$lib/types/Project";
	import { buildRecent, type RecentMachine } from "$lib/utils/recentItems";
	import { formatRelativeTime } from "$lib/utils/relativeTime";
	import { projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
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
	const needsProjects = $derived(conversations.some((conv) => conv.projectId));
	async function loadProjects() {
		try {
			const response = await fetch(`${base}/api/v2/projects`);
			if (!response.ok) return;
			const listed = ((await response.json()) as { data: ProjectView[] }).data;
			const merged = reconcileById(projectsTreeCache.projects, listed);
			if (merged !== projectsTreeCache.projects) projectsTreeCache.projects = merged;
			projectsTreeCache.fetchedAt = Date.now();
			projectsTreeCache.failed = false;
			projectsTreeCache.loaded = true;
		} catch {
			// Project chats then show without their badge: the list still works.
		}
	}
	let projectsAsked = false;
	$effect(() => {
		if (needsProjects && !projectsAsked && !projectsTreeCache.loaded) {
			projectsAsked = true;
			void loadProjects();
		}
	});

	// Sessions: the same shared device poll and subtree reads the Agents tree
	// uses, for the paired machines that are online.
	const agentsOn = $derived(agentsEnabled && codeReauth.checked && !codeReauth.required);
	const loadable = $derived(
		agentsOn
			? codeDeviceList.devices.filter(
					(device) => device.status === "paired" && device.online !== false
				)
			: []
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
					.filter((device) => device.status === "paired" && codeTreeCache.trees[device.id])
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
	{#each items as item (`${item.kind}:${item.id}`)}
		{#if item.kind === "chat"}
			<a
				href="{base}/conversation/{item.id}"
				class={rowClass(page.params.id === item.id)}
				title={item.title}
				data-testid="recent-row"
				data-kind="chat"
			>
				<CarbonChat class="size-3.5 shrink-0" aria-label={m["app.nav.recent_chat"]()} />
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
				class="{rowClass(page.url.searchParams.get('agent') === item.id)} {item.machine.online
					? ''
					: 'opacity-70'}"
				title={item.title}
				data-testid="recent-row"
				data-kind="agent"
			>
				<CarbonCode class="size-3.5 shrink-0" aria-label={m["app.nav.recent_agent"]()} />
				<span class="min-w-0 flex-1 truncate">{item.title}</span>
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
	{#if hasMore}
		<InfiniteScroll onvisible={onloadmore} />
	{/if}
</div>
