<script lang="ts" module>
	export const titles: { [key: string]: string } = {
		today: "Today",
		week: "This week",
		month: "This month",
		older: "Older",
	} as const;
</script>

<!--
	The left panel: two trees, then the rows, then the person.

	The split is the point. **Projects and Chats are trees**, because they have
	contents worth expanding. **Models, Knowledge, Agents and MCP Servers are
	rows at the foot**, because each opens a dialog and has no hierarchy —
	making all six branches was tried and was worse, a disclosure triangle that
	revealed a list you then clicked to open the dialog anyway.

	Three decisions worth knowing.

	**A tree's contents are fetched when it is opened**, never on load. The
	panel is drawn on every page. A project's chats load when *its* folder
	opens, not with the project list — a dozen projects would otherwise be a
	dozen requests to draw a sidebar nobody expanded.

	**Managing a project happens on its own row**, through the `⋯`: Edit opens
	that project, Delete removes it. The `+` on the Projects header is the only
	control there that is not about an existing project. Nothing here opens a
	list of every project, because the tree already is one.

	**A project's chats live under the project, so Chats leaves them out.** That
	is what `projectId` on the sidebar conversation is for — without it every
	conversation in a project would appear twice, and deleting it in one place
	would leave it in the other.
-->
<script lang="ts">
	import { base } from "$app/paths";

	import Logo from "$lib/components/icons/Logo.svelte";
	import { isAborted } from "$lib/stores/isAborted";

	import NavConversationItem from "./NavConversationItem.svelte";
	import TreeBranch from "./nav/TreeBranch.svelte";
	import TreeLeaf from "./nav/TreeLeaf.svelte";
	import ProjectsBranch from "./nav/ProjectsBranch.svelte";
	import UserMenu from "./nav/UserMenu.svelte";
	import type { LayoutData } from "../../routes/$types";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import type { Model } from "$lib/types/Model";
	import { page } from "$app/state";
	import InfiniteScroll from "./InfiniteScroll.svelte";
	import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { requireAuthUser } from "$lib/utils/auth";
	import { totalEnabledMcpCount } from "$lib/stores/mcpConnectors";
	import MCPServerManager from "./mcp/MCPServerManager.svelte";
	import ProjectsManager from "./projects/ProjectsManager.svelte";
	import KnowledgeManager from "./knowledge/KnowledgeManager.svelte";
	import AgentsManager from "./agents/AgentsManager.svelte";
	import CarbonChat from "~icons/carbon/chat";
	import { modelsOverlay } from "$lib/stores/modelsOverlay.svelte";

	/** The bottom block's rows, which are all the same shape. */
	const ROW =
		"flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-left text-gray-500 hover:bg-gray-100 max-sm:h-10 dark:text-gray-400 dark:hover:bg-gray-700";
	const ROW_BADGE =
		"ml-auto rounded-md bg-gray-500/5 px-1.5 py-0.5 text-xs text-gray-400 dark:bg-gray-500/20";

	const publicConfig = usePublicConfig();
	const client = useAPIClient();

	interface Props {
		conversations: ConvSidebar[];
		user: LayoutData["user"];
		/** The gateway's own answer — the chat's user flag means nothing here. */
		gatewayIsAdmin: LayoutData["gatewayIsAdmin"];
		p?: number;
		ondeleteConversation?: (id: string) => void;
		oneditConversationTitle?: (payload: { id: string; title: string }) => void;
	}

	let {
		conversations = $bindable(),
		user,
		gatewayIsAdmin,
		p = $bindable(0),
		ondeleteConversation,
		oneditConversationTitle,
	}: Props = $props();

	let hasMore = $state(true);

	function handleNewChatClick(e: MouseEvent) {
		isAborted.set(true);

		if (requireAuthUser()) {
			e.preventDefault();
		}
	}

	const signedIn = $derived(Boolean(user?.username || user?.email));

	const dateRanges = [
		new Date().setDate(new Date().getDate() - 1),
		new Date().setDate(new Date().getDate() - 7),
		new Date().setMonth(new Date().getMonth() - 1),
	];

	// A project's conversations are shown inside the project, so they are left
	// out here rather than listed twice.
	const loose = $derived(conversations.filter((conv) => !conv.projectId));

	let groupedConversations = $derived({
		today: loose.filter(({ updatedAt }) => updatedAt.getTime() > dateRanges[0]),
		week: loose.filter(
			({ updatedAt }) => updatedAt.getTime() > dateRanges[1] && updatedAt.getTime() < dateRanges[0]
		),
		month: loose.filter(
			({ updatedAt }) => updatedAt.getTime() > dateRanges[2] && updatedAt.getTime() < dateRanges[1]
		),
		older: loose.filter(({ updatedAt }) => updatedAt.getTime() < dateRanges[2]),
	});

	const nModels = $derived((page.data.models as Model[]).filter((model) => !model.unlisted).length);

	async function handleVisible() {
		p++;
		const newConvs = await client.conversations
			.get({
				query: {
					p,
				},
			})
			.then(handleResponse)
			.then((r) => r.conversations)
			.catch((): ConvSidebar[] => []);

		if (newConvs.length === 0) {
			hasMore = false;
		}

		conversations = [...conversations, ...newConvs];
	}

	$effect(() => {
		if (conversations.length <= CONV_NUM_PER_PAGE) {
			// reset p to 0 if there's only one page of content
			// that would be caused by a data loading invalidation
			p = 0;
		}
	});

	// ---- the overlays a branch's `+` and its leaves open -------------------

	let showMcpModal = $state(false);
	let showProjectsModal = $state(false);
	let showKnowledgeModal = $state(false);
	let showAgentsModal = $state(false);
	/** Which project the overlay opens on, and whether it opens to create one. */
	let projectTarget = $state<string | undefined>(undefined);
	let projectCreate = $state(false);

	let projectsBranch = $state<ReturnType<typeof ProjectsBranch> | undefined>(undefined);
	let chatsOpen = $state(true);
</script>

<div
	class="sticky top-0 flex flex-none touch-none items-center justify-between px-1.5 py-3.5 max-sm:pt-0"
>
	<a
		class="flex items-center rounded-xl text-lg font-semibold select-none"
		href="{publicConfig.PUBLIC_ORIGIN}{base}/"
	>
		<Logo classNames="dark:invert mr-[2px]" />
		{publicConfig.PUBLIC_APP_NAME}
	</a>
	<a
		href={`${base}/`}
		onclick={handleNewChatClick}
		class="flex rounded-lg border bg-white px-2 py-0.5 text-center whitespace-nowrap shadow-xs hover:shadow-none sm:text-smd dark:border-gray-600 dark:bg-gray-700"
		title="Ctrl/Cmd + Shift + O"
	>
		New Chat
	</a>
</div>

<div
	class="scrollbar-custom flex touch-pan-y flex-col gap-px overflow-y-auto rounded-r-xl border border-l-0 border-gray-100 from-gray-50 px-2 pt-2 pb-3 text-[.9rem] max-sm:bg-linear-to-t md:bg-linear-to-l dark:border-transparent dark:from-gray-800/30"
>
	{#if signedIn}
		<ProjectsBranch
			bind:this={projectsBranch}
			onopen={(id) => {
				projectTarget = id;
				projectCreate = id === undefined;
				showProjectsModal = true;
			}}
		/>
	{/if}

	<TreeBranch label="Chats" badge={loose.length || undefined} bind:open={chatsOpen}>
		{#snippet icon()}
			<CarbonChat class="size-3.5 shrink-0" />
		{/snippet}
		{#each Object.entries(groupedConversations) as [group, convs]}
			{#if convs.length}
				<h4 class="mt-2 mb-1 pl-6 text-xs text-gray-400 first:mt-0.5 dark:text-gray-500">
					{titles[group]}
				</h4>
				{#each convs as conv (String(conv.id))}
					<div class="pl-3">
						<NavConversationItem {conv} {oneditConversationTitle} {ondeleteConversation} />
					</div>
				{/each}
			{/if}
		{/each}
		{#if loose.length === 0}
			<TreeLeaf label="No chats yet" depth={1} href="{base}/" />
		{/if}
		{#if hasMore}
			<InfiniteScroll onvisible={handleVisible} />
		{/if}
	</TreeBranch>
</div>

<div
	class="flex touch-none flex-col gap-px rounded-r-xl border border-l-0 border-gray-100 p-2 text-base sm:text-sm md:mt-3 md:bg-linear-to-l md:from-gray-50 dark:border-transparent md:dark:from-gray-800/30"
>
	<!-- Rows, not branches: each opens a dialog and contains nothing to expand.
	     `/models/[id]` is still a real address, so the routes remain; this is
	     only the way in. -->
	<button onclick={() => modelsOverlay.show()} class={ROW}>
		Models
		<span class={ROW_BADGE}>{nModels}</span>
	</button>

	{#if signedIn}
		<button onclick={() => (showKnowledgeModal = true)} class={ROW}> Knowledge </button>
		<button onclick={() => (showAgentsModal = true)} class={ROW}> Agents </button>
		<button onclick={() => (showMcpModal = true)} class={ROW}>
			MCP Servers
			{#if $totalEnabledMcpCount > 0}
				<span
					class="ml-auto rounded-md bg-blue-600/10 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-600/20 dark:text-blue-400"
				>
					{$totalEnabledMcpCount}
				</span>
			{/if}
		</button>
	{/if}

	{#if signedIn}
		<div class="mt-1 border-t border-gray-200/60 pt-1 dark:border-gray-700/60">
			<UserMenu {user} {gatewayIsAdmin} />
		</div>
	{:else}
		<a
			href="{base}/settings/application"
			class="flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-gray-500 no-underline hover:bg-gray-100 max-sm:h-10 dark:text-gray-400 dark:hover:bg-gray-700"
		>
			Settings
		</a>
	{/if}
</div>

{#if showProjectsModal}
	<ProjectsManager
		initialId={projectTarget}
		initialView={projectCreate ? "create" : undefined}
		onclose={() => {
			showProjectsModal = false;
			// The dialog is where a project is created, renamed and shared, so
			// the tree may be stale by the time it closes.
			void projectsBranch?.reload();
		}}
	/>
{/if}

{#if showKnowledgeModal}
	<KnowledgeManager onclose={() => (showKnowledgeModal = false)} />
{/if}

{#if showAgentsModal}
	<AgentsManager onclose={() => (showAgentsModal = false)} />
{/if}

{#if showMcpModal}
	<MCPServerManager onclose={() => (showMcpModal = false)} />
{/if}
