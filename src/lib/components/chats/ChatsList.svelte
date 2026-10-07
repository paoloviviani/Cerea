<!--
	All of the signed-in person's chats, as the `/chats` page, in the same shape
	as the projects list: a header, a tinted strip, then cards.

	The sidebar's Chats branch is the recent ones, grouped by day, and a chat
	inside a project is shown under the project instead. This is the "find
	anything" list: **every** chat, project chats included (marked with their
	project), newest first, filtered by **title** on the server —
	`GET /api/v2/conversations?q=` — so a chat from last year is found without
	scrolling to it. Message text is not searched.

	The search box has focus when the page opens, filters as you type (after a
	short pause, so a word is one request and not five), and ignores case and
	accents. More rows load as the end of the list scrolls into view.

	Loads in `onMount`: this renders as a page, and a page body runs on the
	server, where a relative fetch has no origin.
-->
<script lang="ts">
	import { onMount, tick } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import { MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";
	import { formatRelativeTime } from "$lib/utils/relativeTime";
	import type { ProjectView } from "$lib/types/Project";
	import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
	import * as s from "$lib/components/overlay/styles";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconChat from "~icons/carbon/chat";
	import IconClose from "~icons/carbon/close";
	import IconSearch from "~icons/carbon/search";
	import LucideFolderOpen from "~icons/lucide/folder-open";

	interface ChatRow {
		id: { toString(): string } | string;
		title: string;
		model?: string;
		updatedAt: Date;
		projectId?: string;
	}

	const client = useAPIClient();

	let input = $state("");
	/** What the list is currently filtered by: `input`, after the pause. */
	let query = $state("");
	let rows = $state<ChatRow[]>([]);
	let hasMore = $state(false);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let projectNames = $state<Record<string, string>>({});
	let searchEl: HTMLInputElement | undefined = $state();

	let nextPage = 0;
	/** Bumped on every new search, so a slow answer to an old one is dropped. */
	let generation = 0;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	const models = $derived(
		new Map<string, string>(
			((page.data.models ?? []) as { id: string; displayName?: string; name?: string }[]).map(
				(model) => [model.id, model.displayName ?? model.name ?? model.id]
			)
		)
	);
	const modelName = (id?: string) => (id ? (models.get(id) ?? id) : "");

	const searching = $derived(query.trim() !== "");

	async function load(reset: boolean) {
		if (reset) {
			generation++;
			nextPage = 0;
			loading = true;
		}
		const mine = generation;
		const asked = nextPage;
		try {
			const result = await client.conversations
				.get({ query: { p: asked, ...(query.trim() ? { q: query.trim() } : {}) } })
				.then(handleResponse);
			if (mine !== generation) return;
			rows = reset ? result.conversations : [...rows, ...result.conversations];
			hasMore = result.hasMore;
			nextPage = asked + 1;
			failure = null;
		} catch (err) {
			if (mine !== generation) return;
			failure = err instanceof Error ? err.message : "Could not load chats.";
			hasMore = false;
		} finally {
			if (mine === generation) loading = false;
		}
	}

	/** The end of the list came into view; the observer repeats until it leaves. */
	function more() {
		if (hasMore && !loading) {
			loading = true;
			void load(false);
		}
	}

	function onInput() {
		clearTimeout(debounce);
		debounce = setTimeout(() => {
			if (input.trim() === query.trim()) return;
			query = input;
			void load(true);
		}, 250);
	}

	async function clear() {
		clearTimeout(debounce);
		input = "";
		if (query !== "") {
			query = "";
			void load(true);
		}
		await tick();
		searchEl?.focus();
	}

	onMount(() => {
		searchEl?.focus();
		void load(true);
		// Names for the project badge. A project that is not in the answer (or a
		// failed request) is badged as just "Project" rather than blocking the list.
		fetch(`${base}/api/v2/projects`)
			.then((response) => (response.ok ? response.json() : { data: [] }))
			.then(({ data }: { data: ProjectView[] }) => {
				projectNames = Object.fromEntries(data.map((project) => [project.id, project.name]));
			})
			.catch(() => undefined);
		return () => clearTimeout(debounce);
	});
</script>

<div class="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
	<header>
		<h1 class="text-xl font-semibold text-ink">Chats</h1>
		<p class={s.SUBTITLE}>Every conversation you have had, newest first, project chats included.</p>
	</header>

	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
		<div class="{s.STRIP} {rows.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
			<div class="flex items-center gap-3">
				<div class={s.STRIP_TILE} class:grayscale={rows.length === 0}>
					<IconChat class="size-5 text-accent" />
				</div>
				<div>
					<p class={s.STRIP_HEADLINE}>
						{#if searching}Matching “{query.trim()}”{:else}All chats{/if}
					</p>
					<p class={s.STRIP_DETAIL} role="status" aria-live="polite">
						{#if loading && rows.length === 0}
							Loading…
						{:else}
							{rows.length}{hasMore ? "+" : ""}
							{rows.length === 1 ? "chat" : "chats"}{searching ? " found" : ""}
						{/if}
					</p>
				</div>
			</div>
			<a href="{base}/" class={s.PRIMARY}>
				<IconAddLarge class="size-4" />
				New chat
			</a>
		</div>

		<div class="relative mb-5">
			<IconSearch
				class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
			/>
			<input
				bind:this={searchEl}
				bind:value={input}
				oninput={onInput}
				onkeydown={(event) => {
					if (event.key === "Escape" && input) {
						event.preventDefault();
						void clear();
					}
				}}
				type="search"
				name="chat-search"
				data-testid="chats-search"
				aria-label="Search chats by title"
				placeholder="Search chats by title"
				maxlength={MAX_TITLE_QUERY_LENGTH}
				autocomplete="off"
				spellcheck="false"
				class="{s.SEARCH} pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
			/>
			{#if input}
				<button
					type="button"
					onclick={clear}
					aria-label="Clear search"
					class="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint hover:bg-sunken hover:text-ink"
				>
					<IconClose class="size-4" />
				</button>
			{/if}
		</div>

		{#if failure}
			<p class="{s.ERROR} mb-4">{failure}</p>
		{/if}

		{#if rows.length > 0}
			<ul class="flex flex-col gap-2" data-testid="chats-list">
				{#each rows as row (String(row.id))}
					<li>
						<a
							href="{base}/conversation/{row.id}"
							data-testid="chats-row"
							class="{s.card(false)} block no-underline hover:border-line-strong"
						>
							<div class="px-4 py-3">
								<h2 class="{s.CARD_TITLE} font-medium">{row.title}</h2>
								<div
									class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted"
								>
									<time
										datetime={new Date(row.updatedAt).toISOString()}
										title={new Date(row.updatedAt).toLocaleString()}
									>
										{formatRelativeTime(row.updatedAt)}
									</time>
									{#if row.model}
										<span class="min-w-0 truncate">{modelName(row.model)}</span>
									{/if}
									{#if row.projectId}
										<span class="{s.PILL} {s.PILL_TONES.busy} max-w-full min-w-0">
											<LucideFolderOpen class="size-3 shrink-0" />
											<span class="truncate">{projectNames[row.projectId] ?? "Project"}</span>
										</span>
									{/if}
								</div>
							</div>
						</a>
					</li>
				{/each}
			</ul>
			{#if hasMore}
				<InfiniteScroll onvisible={more} />
			{/if}
		{:else if loading}
			<p class={s.SUBTITLE}>Loading…</p>
		{:else if !failure}
			<div class={s.EMPTY} data-testid={searching ? "chats-no-results" : "chats-empty"}>
				<IconChat class={s.EMPTY_ICON} />
				{#if searching}
					<p class={s.EMPTY_TITLE}>No chats match “{query.trim()}”</p>
					<p class={s.EMPTY_DETAIL}>
						Only titles are searched, and capitals and accents do not matter.
					</p>
					<button type="button" onclick={clear} class={s.SECONDARY}>Show all chats</button>
				{:else}
					<p class={s.EMPTY_TITLE}>No chats yet</p>
					<p class={s.EMPTY_DETAIL}>Your conversations will be listed here, newest first</p>
					<a href="{base}/" class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						Start a chat
					</a>
				{/if}
			</div>
		{/if}
	</div>
</div>
