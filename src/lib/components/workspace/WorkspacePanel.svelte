<!--
	The workspace: models, MCP servers and knowledge bases as tabs of one page.

	The three managers were overlays, each opened from a different corner of the
	app (sidebar rows, the composer, the models list) and each mounted wherever
	its opener lived. They are now tabs of this one panel: one address to link,
	one place to look for them, and the sidebar loses three rows to one. The
	managers are reused as they are — their inner cards keep the dialog language
	(`overlay/styles.ts`); only the overlay shell is gone, replaced by the card
	this panel draws around whichever tab is showing.

	**The tab and the item are the address.** `?tab=models|mcp|kb` picks the
	tab, an `?id=` opens one item's own view — so the programmatic openers that
	used to open an overlay navigate here instead, and old `/knowledge/…` links
	redirect to `?tab=kb&id=…`. `id` is read once by
	the manager it belongs to (`initialId`, see each manager), so the tab
	contents are keyed on `tab` + `id`: a new address remounts, exactly as a
	fresh dialog open used to.
-->
<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import type { LayoutData } from "../../../routes/$types";

	import ModelsManager from "$lib/components/models/ModelsManager.svelte";
	import MCPServerManager from "$lib/components/mcp/MCPServerManager.svelte";
	import KnowledgeManager from "$lib/components/knowledge/KnowledgeManager.svelte";
	import SkillsManager from "$lib/components/skills/SkillsManager.svelte";
	import LucideBoxes from "~icons/lucide/boxes";
	import LucideLibrary from "~icons/lucide/library";
	import IconMCP from "$lib/components/icons/IconMCP.svelte";
	import IconDocument from "~icons/carbon/document";

	interface Props {
		data: LayoutData;
	}

	let { data }: Props = $props();

	// The labels are the rows this page's tabs replace — the sidebar said
	// "Models", "MCP Servers" and "Knowledge" and nothing is gained by renaming
	// them under a new roof. "Skills" is new with this panel: the fourth
	// manager, and the first one that needed no sidebar row to replace.
	//
	// The Knowledge tab hides when the deployment switch says the pipeline is
	// off (FeatureFlags.knowledgeEnabled, on unless explicitly "false"): a
	// deployment without the chat's Postgres has no store behind it, and a tab
	// that only errors is worse than none. Anything else in the query — a bare
	// `/workspace`, a mistyped `?tab=...`, or `?tab=kb` while hidden — lands on
	// Models.
	const ALL_TABS = [
		{ key: "models", label: "Models" },
		{ key: "mcp", label: "MCP Servers" },
		{ key: "kb", label: "Knowledge" },
		{ key: "skills", label: "Skills" },
	] as const;
	const TABS = $derived(
		data.knowledgeEnabled !== false ? ALL_TABS : ALL_TABS.filter((t) => t.key !== "kb")
	);
	type TabKey = (typeof ALL_TABS)[number]["key"];

	// Anything else in the query means the default tab, so a bare `/workspace`
	// and a mistyped `?tab=...` both land on Models.
	const tab = $derived(
		TABS.find((candidate) => candidate.key === page.url.searchParams.get("tab"))?.key ??
			("models" satisfies TabKey)
	);
	const initialId = $derived(page.url.searchParams.get("id") ?? undefined);
	// MCP servers are a flat list with no per-item view, so an `id` beside
	// `?tab=mcp` has nothing to open and is ignored.
	const initialItemId = $derived(tab === "mcp" ? undefined : initialId);
</script>

<!--
	h-full and min-h-0 bound this frame to the row the root layout gives it,
	mirroring `routes/settings/+layout.svelte` and `routes/admin/+layout.svelte`:
	the root shell is `fixed h-dvh overflow-hidden` by design, so the page
	scrolls in its own pane, under the pinned tabs.
-->
<div class="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-6 p-6">
	<header class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">Workspace</h1>
		<p class="text-sm text-gray-500 dark:text-gray-400">
			{data.knowledgeEnabled !== false
				? "Models, MCP servers, knowledge bases and skills, in one place."
				: "Models, MCP servers and skills, in one place."}
		</p>
	</header>

	<nav
		aria-label="Workspace sections"
		class="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700"
	>
		{#each TABS as t (t.key)}
			{@const active = tab === t.key}
			<a
				href="{base}/workspace?tab={t.key}"
				aria-current={active ? "page" : undefined}
				class="flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium transition-colors {active
					? 'border-blue-600 text-blue-700 dark:text-blue-400'
					: 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'}"
			>
				{#if t.key === "models"}
					<LucideBoxes class="size-4" />
				{:else if t.key === "mcp"}
					<IconMCP classNames="size-4" />
				{:else if t.key === "kb"}
					<LucideLibrary class="size-4" />
				{:else}
					<IconDocument class="size-4" />
				{/if}
				{t.label}
			</a>
		{/each}
	</nav>

	<!--
		The page scrolls here, under the pinned tabs, not the window. A tab with
		no `id` shows the manager's list; with one, the manager opens straight
		onto that item, which is what the deep links and the programmatic
		openers rely on.
	-->
	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
		{#key `${tab}:${initialItemId ?? ""}`}
			{#if tab === "models"}
				<ModelsManager
					models={data.models}
					mlAssistantModels={data.mlAssistantModels ?? []}
					initialId={initialItemId}
				/>
			{:else if tab === "mcp"}
				<MCPServerManager />
			{:else if tab === "kb"}
				<KnowledgeManager initialId={initialItemId} />
			{:else}
				<SkillsManager initialId={initialItemId} />
			{/if}
		{/key}
	</div>
</div>
