<script lang="ts" module>
	export const titles: { [key: string]: string } = {
		today: "Today",
		week: "This week",
		month: "This month",
		older: "Older",
	} as const;
</script>

<!--
	The left panel, as one tree.

	It used to be three stacked lists — a flat run of conversations, then a run
	of links, then the person — which meant the panel had no structure to read
	and everything competed for the same attention. Now every top-level thing
	is a branch: Models, Projects, Knowledge, Agents, MCP Servers, Chats, with
	the person at the foot in a menu that opens upward.

	Three decisions worth knowing.

	**A branch's contents are fetched when it is opened**, never on load. The
	panel is drawn on every page and most branches are closed most of the time;
	loading all of them would make the sidebar the most expensive thing on the
	screen. The badge on a closed branch either comes from data the layout
	already has, or appears once the branch has been opened.

	**A `+` beside a branch opens that thing's create dialog**, and the branch
	itself expands. They are separate buttons: "add one of these" and "show me
	them" are different actions, and folding them together makes one of them
	unreachable by keyboard.

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
	import { enabledServersCount } from "$lib/stores/mcpServers";
	import { useSettingsStore } from "$lib/stores/settings";
	import { GatewayError, gwGet, type Agent, type VectorStore } from "$lib/gateway";
	import MCPServerManager from "./mcp/MCPServerManager.svelte";
	import ModelsManager from "./models/ModelsManager.svelte";
	import ProjectsManager from "./projects/ProjectsManager.svelte";
	import KnowledgeManager from "./knowledge/KnowledgeManager.svelte";
	import AgentsManager from "./agents/AgentsManager.svelte";
	import LucideBoxes from "~icons/lucide/boxes";
	import LucideLibrary from "~icons/lucide/library";
	import LucideBot from "~icons/lucide/bot";
	import IconMCP from "$lib/components/icons/IconMCP.svelte";

	const publicConfig = usePublicConfig();
	const client = useAPIClient();
	const settings = useSettingsStore();

	interface Props {
		conversations: ConvSidebar[];
		user: LayoutData["user"];
		p?: number;
		ondeleteConversation?: (id: string) => void;
		oneditConversationTitle?: (payload: { id: string; title: string }) => void;
	}

	let {
		conversations = $bindable(),
		user,
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

	const listedModels = $derived((page.data.models as Model[]).filter((model) => !model.unlisted));
	const nModels = $derived(listedModels.length);

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
	let showModelsModal = $state(false);
	let showProjectsModal = $state(false);
	let showKnowledgeModal = $state(false);
	let showAgentsModal = $state(false);
	/** Which item an overlay should open on, when a leaf was clicked. */
	let projectTarget = $state<string | undefined>(undefined);
	let knowledgeTarget = $state<string | undefined>(undefined);
	let agentTarget = $state<string | undefined>(undefined);

	let projectsBranch = $state<ReturnType<typeof ProjectsBranch> | undefined>(undefined);

	// ---- branch contents, each loaded on first open ------------------------

	let modelsOpen = $state(false);
	let chatsOpen = $state(true);

	let knowledgeOpen = $state(false);
	let bases = $state<VectorStore[] | null>(null);
	let basesFailed = $state(false);

	let agentsOpen = $state(false);
	let agents = $state<Agent[] | null>(null);
	let agentsFailed = $state(false);

	async function loadBases() {
		try {
			bases = (await gwGet<{ data: VectorStore[] }>("vector_stores")).data;
			basesFailed = false;
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
			// A sidebar branch is not the place to report this loudly: the label
			// says so and the rest of the panel keeps working.
			bases = [];
			basesFailed = true;
		}
	}

	async function loadAgents() {
		try {
			agents = (await gwGet<{ data: Agent[] }>("agents")).data;
			agentsFailed = false;
		} catch (err) {
			if (!(err instanceof GatewayError)) throw err;
			agents = [];
			agentsFailed = true;
		}
	}

	async function toggleKnowledge() {
		knowledgeOpen = !knowledgeOpen;
		if (knowledgeOpen && bases === null) await loadBases();
	}

	async function toggleAgents() {
		agentsOpen = !agentsOpen;
		if (agentsOpen && agents === null) await loadAgents();
	}

	/**
	 * After an overlay closes, the branch it belongs to may be stale — the
	 * dialog is where things are created, renamed and deleted. Only a branch
	 * that has already been opened is reloaded, so a closed one stays free.
	 */
	function refreshAfter(kind: "projects" | "knowledge" | "agents") {
		if (kind === "projects") void projectsBranch?.reload();
		if (kind === "knowledge" && bases !== null) void loadBases();
		if (kind === "agents" && agents !== null) void loadAgents();
	}
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
	<TreeBranch label="Models" badge={nModels} bind:open={modelsOpen}>
		{#snippet icon()}
			<LucideBoxes class="size-3.5 shrink-0" />
		{/snippet}
		{#if listedModels.length === 0}
			<TreeLeaf label="None available to you" depth={1} />
		{:else}
			{#each listedModels.slice(0, 12) as model (model.id)}
				<TreeLeaf
					label={model.displayName || model.id}
					depth={1}
					active={model.id === $settings.activeModel}
					title={model.id}
					onclick={() => settings.instantSet({ activeModel: model.id })}
				/>
			{/each}
			<TreeLeaf
				label={listedModels.length > 12 ? `All ${listedModels.length} models…` : "Manage…"}
				depth={1}
				onclick={() => (showModelsModal = true)}
			/>
		{/if}
	</TreeBranch>

	{#if signedIn}
		<ProjectsBranch
			bind:this={projectsBranch}
			onopen={(id) => {
				projectTarget = id;
				showProjectsModal = true;
			}}
		/>

		<TreeBranch
			label="Knowledge"
			badge={bases?.length}
			open={knowledgeOpen}
			onactivate={toggleKnowledge}
			onadd={() => {
				knowledgeTarget = undefined;
				showKnowledgeModal = true;
			}}
			addTitle="New knowledge base"
		>
			{#snippet icon()}
				<LucideLibrary class="size-3.5 shrink-0" />
			{/snippet}
			{#if bases === null}
				<TreeLeaf label="Loading…" depth={1} />
			{:else if basesFailed}
				<TreeLeaf label="Unavailable" depth={1} title="Could not reach the gateway" />
			{:else if bases.length === 0}
				<TreeLeaf
					label="No knowledge bases yet"
					depth={1}
					onclick={() => {
						knowledgeTarget = undefined;
						showKnowledgeModal = true;
					}}
				/>
			{:else}
				{#each bases as store (store.id)}
					<TreeLeaf
						label={store.name}
						depth={1}
						title="{store.file_counts.completed} indexed"
						onclick={() => {
							knowledgeTarget = store.id;
							showKnowledgeModal = true;
						}}
					/>
				{/each}
			{/if}
		</TreeBranch>

		<TreeBranch
			label="Agents"
			badge={agents?.length}
			open={agentsOpen}
			onactivate={toggleAgents}
			onadd={() => {
				agentTarget = undefined;
				showAgentsModal = true;
			}}
			addTitle="New agent"
		>
			{#snippet icon()}
				<LucideBot class="size-3.5 shrink-0" />
			{/snippet}
			{#if agents === null}
				<TreeLeaf label="Loading…" depth={1} />
			{:else if agentsFailed}
				<TreeLeaf label="Unavailable" depth={1} title="Could not reach the gateway" />
			{:else if agents.length === 0}
				<TreeLeaf
					label="No agents yet"
					depth={1}
					onclick={() => {
						agentTarget = undefined;
						showAgentsModal = true;
					}}
				/>
			{:else}
				{#each agents as agent (agent.id)}
					<TreeLeaf
						label={agent.name}
						depth={1}
						title="Runs on {agent.model}"
						onclick={() => {
							agentTarget = agent.id;
							showAgentsModal = true;
						}}
					/>
				{/each}
			{/if}
		</TreeBranch>

		<TreeBranch
			label="MCP Servers"
			badge={$enabledServersCount > 0 ? $enabledServersCount : undefined}
			onactivate={() => (showMcpModal = true)}
		>
			{#snippet icon()}
				<IconMCP classNames="size-3.5 shrink-0" />
			{/snippet}
		</TreeBranch>
	{/if}

	<TreeBranch label="Chats" badge={loose.length || undefined} bind:open={chatsOpen}>
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
	{#if signedIn}
		<UserMenu {user} />
	{:else}
		<a
			href="{base}/settings/application"
			class="flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-gray-500 no-underline hover:bg-gray-100 max-sm:h-10 dark:text-gray-400 dark:hover:bg-gray-700"
		>
			Settings
		</a>
	{/if}
</div>

{#if showModelsModal}
	<ModelsManager
		models={(page.data.models ?? []) as never}
		mlAssistantModels={(page.data.mlAssistantModels ?? []) as never}
		onclose={() => (showModelsModal = false)}
	/>
{/if}

{#if showProjectsModal}
	<ProjectsManager
		initialId={projectTarget}
		onclose={() => {
			showProjectsModal = false;
			refreshAfter("projects");
		}}
	/>
{/if}

{#if showKnowledgeModal}
	<KnowledgeManager
		initialId={knowledgeTarget}
		onclose={() => {
			showKnowledgeModal = false;
			refreshAfter("knowledge");
		}}
	/>
{/if}

{#if showAgentsModal}
	<AgentsManager
		initialId={agentTarget}
		onclose={() => {
			showAgentsModal = false;
			refreshAfter("agents");
		}}
	/>
{/if}

{#if showMcpModal}
	<MCPServerManager onclose={() => (showMcpModal = false)} />
{/if}
