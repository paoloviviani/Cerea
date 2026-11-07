<script lang="ts" module>
	import { m } from "$lib/paraglide/messages";
	export const titles: { [key: string]: string } = {
		get today() {
			return m["app.nav.group_today"]();
		},
		get week() {
			return m["app.nav.group_week"]();
		},
		get month() {
			return m["app.nav.group_month"]();
		},
		get older() {
			return m["app.nav.group_older"]();
		},
	};
</script>

<!--
	The left panel, top to bottom: the logo, the Chats | Agents switch, the one
	"New …" button that follows the switch, the list (two trees in Chats, the
	machines tree in Agents), then the foot — Schedules, Workspace, and the user
	row with its menu.

	The split is the point. **Projects and Chats are trees**, because they have
	contents worth expanding. **Schedules and Workspace are rows**, because each
	is one address and has no hierarchy — making branches of them was tried and
	was worse, a disclosure triangle that revealed a list you then clicked to
	open the dialog anyway. Workspace is the one page that hosts the managers
	(models, MCP servers, knowledge bases) as tabs. Settings and Admin are not
	rows any more: they, with the quota summary, the Console link, the theme
	switch, Reload and Sign out, live in the user menu (`nav/NavFooter.svelte`).

	**The switch sits at the top** because it decides what everything under it
	is: which list, and what "New" means (a chat, or an agent session). The
	Schedules row is the same in both modes — one page for both kinds — and
	carries a badge only when a run needs attention. "Needs you" is a badge on
	the Agents half of the switch and nothing else: no pinned line.

	Three decisions worth knowing.

	**A tree's contents are fetched when it is opened**, never on load. The
	panel is drawn on every page. A project's chats load when *its* folder
	opens, not with the project list — a dozen projects would otherwise be a
	dozen requests to draw a sidebar nobody expanded.

	**Managing a project happens on its own row**, through the `⋯`: Project
	settings goes to that project's page (`/projects/<id>`), Delete removes it.
	The `+` on the Projects header goes to `/projects/new` and is the only
	control there that is not about an existing project. Nothing here opens a
	list of every project, because the tree already is one.

	**A project's chats live under the project, so Chats leaves them out.** That
	is what `projectId` on the sidebar conversation is for — without it every
	conversation in a project would appear twice, and deleting it in one place
	would leave it in the other.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { page } from "$app/state";

	import Logo from "$lib/components/icons/Logo.svelte";
	import { isAborted } from "$lib/stores/isAborted";

	import NavConversationItem from "./NavConversationItem.svelte";
	import TreeBranch from "./nav/TreeBranch.svelte";
	import TreeLeaf from "./nav/TreeLeaf.svelte";
	import ProjectsBranch from "./nav/ProjectsBranch.svelte";
	import IconTime from "~icons/carbon/time";
	import LucideLayoutDashboard from "~icons/lucide/layout-dashboard";
	import NewAgentSession from "./code/NewAgentSession.svelte";
	import { scheduleAttention, watchScheduleAttention } from "$lib/stores/scheduleAttention.svelte";
	import NavFooter from "./nav/NavFooter.svelte";
	import type { LayoutData } from "../../routes/$types";
	import type { ConvSidebar } from "$lib/types/ConvSidebar";
	import InfiniteScroll from "./InfiniteScroll.svelte";
	import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { useAPIClient, handleResponse } from "$lib/APIClient";
	import { requireAuthUser } from "$lib/utils/auth";
	import { chatDrag } from "$lib/stores/chatDrag.svelte";
	import { useMoveConversation } from "$lib/utils/useMoveConversation";
	import CarbonChat from "~icons/carbon/chat";
	import CarbonCode from "~icons/carbon/code";
	import CarbonEdit from "~icons/carbon/edit";
	import CarbonSettings from "~icons/carbon/settings";
	import CodeNavTree from "./code/CodeNavTree.svelte";
	import CodeReauthCard from "./code/CodeReauthCard.svelte";
	import { codeNav } from "$lib/stores/codeNav.svelte";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import { codeNeedsYou } from "$lib/stores/codeNeedsYou.svelte";
	import { loadCodeStatus } from "$lib/codeApi";

	/** The bottom block's rows, which are all the same shape. */
	const ROW =
		"flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-left text-gray-500 hover:bg-gray-100 max-sm:h-10 dark:text-gray-400 dark:hover:bg-gray-700";
	const ROW_ACTIVE =
		"flex h-8 flex-none items-center gap-1.5 rounded-lg px-2 text-left bg-gray-100 font-semibold text-gray-900 max-sm:h-10 dark:bg-gray-700 dark:text-white";

	const NEW_BUTTON =
		"flex h-8 items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2 text-sm font-medium text-gray-800 shadow-xs hover:bg-gray-50 max-sm:h-10 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700";

	const publicConfig = usePublicConfig();
	const client = useAPIClient();

	interface Props {
		conversations: ConvSidebar[];
		user: LayoutData["user"];
		/** The gateway's own answer — the chat's user flag means nothing here. */
		gatewayIsAdmin: LayoutData["gatewayIsAdmin"];
		/** Deployment flag for the agents panel in this list (off unless deployed). */
		codeAgentsEnabled?: boolean;
		p?: number;
		ondeleteConversation?: (id: string) => void;
		oneditConversationTitle?: (payload: { id: string; title: string }) => void;
	}

	let {
		conversations = $bindable(),
		user,
		gatewayIsAdmin,
		codeAgentsEnabled = false,
		p = $bindable(0),
		ondeleteConversation,
		oneditConversationTitle,
	}: Props = $props();

	let hasMore = $state(true);

	const moveConversation = useMoveConversation();

	/** A project chat was dropped on the Chats branch: take it out of its project. */
	async function dropOut() {
		const dragged = chatDrag.current;
		chatDrag.current = null;
		if (!dragged?.projectId) return;
		const projects = (await fetch(`${base}/api/v2/projects`)
			.then((response) => (response.ok ? response.json() : { data: [] }))
			.catch(() => ({ data: [] }))) as { data: { id: string; name: string }[] };
		const from = projects.data.find((project) => project.id === dragged.projectId)?.name;
		await moveConversation(
			{ id: dragged.id, title: dragged.title, model: dragged.model },
			null,
			from
		);
	}

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

	// One flat list, keyed by id: a chat that moves to another date group (its
	// updatedAt changed) keeps its component, so an open row menu or delete
	// confirmation stays attached to that chat instead of being rebuilt.
	const listRows = $derived(
		Object.entries(groupedConversations).flatMap(([group, convs]) =>
			convs.length
				? [
						{ key: `group:${group}`, group, conv: null as ConvSidebar | null },
						...convs.map((conv) => ({ key: `conv:${String(conv.id)}`, group, conv })),
					]
				: []
		)
	);

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

		// A list that shifted between pages can hand back a chat already shown:
		// keep one row per id (the keyed list would throw on a duplicate).
		const seen = new Set(conversations.map((c) => c.id));
		conversations = [...conversations, ...newConvs.filter((c: ConvSidebar) => !seen.has(c.id))];
	}

	$effect(() => {
		if (conversations.length <= CONV_NUM_PER_PAGE) {
			// reset p to 0 if there's only one page of content
			// that would be caused by a data loading invalidation
			p = 0;
		}
	});

	let chatsOpen = $state(true);

	// codeNav.view is "auto" until something picks a side explicitly; while
	// auto, the route decides — landing on /code (a reload, or a link in from
	// elsewhere) opens on Agents without a flash, since this is a pure read
	// of request-scoped `page` state, computed the same way during SSR and
	// after hydration. A click on either pill below sets an explicit value
	// and this stops following the route.
	// Ask `/status` once the sidebar is live: the agents tree must not fire its
	// requests (the server refuses them to a stale sign-in) before it knows.
	$effect(() => {
		if (codeAgentsEnabled) void loadCodeStatus();
	});

	// Asks waiting across the machines, from the Needs-you bar (nothing is
	// published without /code or with a stale sign-in).
	const needsYouCount = $derived(
		codeAgentsEnabled && !codeReauth.required ? codeNeedsYou.pending.length : 0
	);
	const schedulesActive = $derived(page.url.pathname === `${base}/schedules`);
	// Agents only exist where the deployment has them: with the switch gone, the
	// list is always chats.
	const effectiveView = $derived(
		!codeAgentsEnabled
			? "chats"
			: codeNav.view === "auto"
				? page.route.id === "/code"
					? "agents"
					: "chats"
				: codeNav.view
	);
	// One Schedules page for both kinds. The row opens it filtered to the mode
	// you are in; the page's own filter changes that.
	const schedulesOn = $derived(
		signedIn && (page.data.chatSchedulesEnabled === true || page.data.codeSchedulesEnabled === true)
	);
	const schedulesHref = $derived(
		page.data.chatSchedulesEnabled === true && page.data.codeSchedulesEnabled === true
			? `${base}/schedules?kind=${effectiveView === "agents" ? "agent" : "chat"}`
			: `${base}/schedules`
	);
	$effect(() => {
		if (schedulesOn) return watchScheduleAttention();
	});
	let newAgentOpen = $state(false);
</script>

<div class="sticky top-0 flex flex-none touch-none flex-col gap-2 px-1.5 pt-3.5 pb-2 max-sm:pt-0">
	<a
		class="flex items-center rounded-xl pl-2.5 text-lg font-semibold select-none"
		href="{publicConfig.PUBLIC_ORIGIN}{base}/"
	>
		<!-- The mark alone: its alt carries the app name for screen readers. -->
		<Logo variant="small" classNames="h-[27px] w-auto" />
	</a>

	{#if codeAgentsEnabled}
		<!-- The panel switch: chats and coding agents are two contents of the same
		     list, not two destinations. It decides what the button below makes.
		     Two boxes of padding rather than margins: +layout.svelte pins every
		     NavMenu child to the nav's column (`--nav-width`), so horizontal insets
		     must be padding inside that box. -->
		<div class="flex rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
			<button
				data-testid="sidebar-view-chats"
				class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors {effectiveView ===
				'chats'
					? 'bg-white text-gray-900 shadow-xs dark:bg-gray-600/60 dark:text-white'
					: 'text-ink-muted hover:text-ink'}"
				onclick={() => (codeNav.view = "chats")}
			>
				<CarbonChat class="size-3.5" />
				{m["app.nav.chats"]()}
			</button>
			<button
				data-testid="sidebar-view-agents"
				class="flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors {effectiveView ===
				'agents'
					? 'bg-white text-gray-900 shadow-xs dark:bg-gray-600/60 dark:text-white'
					: 'text-ink-muted hover:text-ink'}"
				aria-label={needsYouCount > 0
					? m["app.nav.agents_needs_you"]({ count: needsYouCount })
					: undefined}
				onclick={() => (codeNav.view = "agents")}
			>
				<CarbonCode class="size-3.5" />
				{m["app.nav.agents"]()}
				{#if needsYouCount > 0}
					<span
						data-testid="sidebar-agents-badge"
						aria-hidden="true"
						class="min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white"
						>{needsYouCount}</span
					>
				{/if}
			</button>
		</div>
	{/if}

	<!-- Follows the switch. The same bordered, quiet button in both modes so the
	     top of the panel does not jump when you flip it. -->
	{#if effectiveView === "agents"}
		<button
			type="button"
			data-testid="new-agent-session"
			onclick={() => (newAgentOpen = true)}
			class={NEW_BUTTON}
		>
			<CarbonEdit class="size-3.5" />
			{m["app.nav.new_agent_session"]()}
		</button>
	{:else}
		<a
			href={`${base}/`}
			onclick={handleNewChatClick}
			class={NEW_BUTTON}
			data-testid="new-chat"
			title={m["app.nav.new_chat_shortcut"]()}
		>
			<CarbonEdit class="size-3.5" />
			{m["app.nav.new_chat"]()}
		</a>
	{/if}
</div>

<div
	class="scrollbar-custom flex touch-pan-y flex-col gap-px overflow-y-auto rounded-r-xl border border-l-0 border-gray-100 from-sidebar px-2 pt-2 pb-3 text-[.9rem] max-sm:bg-linear-to-t md:bg-linear-to-l dark:border-transparent"
>
	{#if codeAgentsEnabled && effectiveView === "agents"}
		<!-- While the sign-in is stale the tree draws no machines and no counts;
		     the card says why and offers the way back (as the main panel does).
		     Before /status has answered nothing is drawn: a card shown then would
		     flash for every signed-in user. The Chats | Agents switch above stays. -->
		{#if codeReauth.required}
			<!-- On /code the panel itself already shows the full card, right
			     beside this column: one prompt there, not two. -->
			{#if page.route.id !== "/code"}
				<CodeReauthCard compact />
			{/if}
		{:else if codeReauth.checked}
			<CodeNavTree />
		{/if}
	{:else}
		{#if signedIn}
			<ProjectsBranch />
		{/if}

		<TreeBranch
			label={m["app.nav.chats"]()}
			href="{base}/chats"
			badge={loose.length || undefined}
			bind:open={chatsOpen}
			acceptsChat={() => chatDrag.current?.projectId !== undefined}
			ondropchat={dropOut}
		>
			{#snippet icon()}
				<CarbonChat class="size-3.5 shrink-0" />
			{/snippet}
			{#each listRows as row (row.key)}
				{#if row.conv}
					<div class="pl-3">
						<NavConversationItem conv={row.conv} {oneditConversationTitle} {ondeleteConversation} />
					</div>
				{:else}
					<h4 class="mt-2 mb-1 pl-6 text-xs text-ink-faint first:mt-0.5">
						{titles[row.group]}
					</h4>
				{/if}
			{/each}
			{#if loose.length === 0}
				<TreeLeaf label={m["app.nav.no_chats"]()} depth={1} href="{base}/" />
			{/if}
			{#if hasMore}
				<InfiniteScroll onvisible={handleVisible} />
			{/if}
		</TreeBranch>
	{/if}
</div>

<div
	class="flex touch-none flex-col gap-px rounded-r-xl border border-l-0 border-gray-100 p-2 text-base sm:text-sm md:mt-3 md:bg-linear-to-l md:from-sidebar dark:border-transparent"
>
	<!-- Rows, not branches: each is one address and contains nothing to expand.
	     Schedules is one page for chats and agents; Workspace is the tabbed page
	     that hosts the managers (models, MCP servers, knowledge bases). -->
	{#if schedulesOn}
		<a
			href={schedulesHref}
			class="{schedulesActive ? ROW_ACTIVE : ROW} no-underline"
			data-testid="schedules-link"
			aria-label={scheduleAttention.count > 0
				? m["app.nav.schedules_attention"]({ count: scheduleAttention.count })
				: undefined}
		>
			<IconTime class="size-4 shrink-0" />
			<span class="min-w-0 flex-1 truncate">{m["app.nav.schedules"]()}</span>
			{#if scheduleAttention.count > 0}
				<span
					data-testid="schedules-attention"
					aria-hidden="true"
					class="min-w-4 rounded-full bg-amber-500 px-1 text-center text-[10px] leading-4 font-semibold text-white"
					>{scheduleAttention.count}</span
				>
			{/if}
		</a>
	{/if}
	<a
		href="{base}/workspace"
		class="{page.url.pathname === `${base}/workspace` ? ROW_ACTIVE : ROW} no-underline"
		data-testid="workspace-link"
	>
		<LucideLayoutDashboard class="size-4 shrink-0" />
		{m["app.nav.workspace"]()}
	</a>

	{#if signedIn}
		<div class="mt-1 border-t border-gray-200/60 pt-1 dark:border-gray-700/60">
			<NavFooter {user} {gatewayIsAdmin} />
		</div>
	{:else}
		<!-- No account, so no user menu: Settings stays one click away as a row. -->
		<a href="{base}/settings/application" class="{ROW} no-underline">
			<CarbonSettings class="size-4 shrink-0" />
			{m["app.nav.settings"]()}
		</a>
	{/if}
</div>

{#if newAgentOpen}
	<NewAgentSession onclose={() => (newAgentOpen = false)} />
{/if}
