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
	import { m } from "$lib/paraglide/messages";
	import { onMount, tick } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import { handleResponse, useAPIClient } from "$lib/APIClient";
	import { MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";
	import { formatRelativeTime } from "$lib/utils/relativeTime";
	import { formatDateTime } from "$lib/i18n/format";
	import { FULL_DATE_TIME } from "$lib/i18n/dateOptions";
	import type { ProjectView } from "$lib/types/Project";
	import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
	import * as s from "$lib/components/overlay/styles";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconChat from "~icons/carbon/chat";
	import IconClose from "~icons/carbon/close";
	import IconSearch from "~icons/carbon/search";
	import LucideFolderOpen from "~icons/lucide/folder-open";
	import MoveMenu from "$lib/components/MoveMenu.svelte";
	import MoveToProjectModal from "$lib/components/MoveToProjectModal.svelte";
	import { useMoveConversation } from "$lib/utils/useMoveConversation";

	interface ChatRow {
		id: { toString(): string } | string;
		title: string;
		model?: string;
		updatedAt: Date;
		projectId?: string;
	}

	const client = useAPIClient();
	const moveConversation = useMoveConversation();
	let moving = $state<ChatRow | null>(null);

	/** Keep the row's project badge true after a move, without a reload. */
	function moved(row: ChatRow, to: { id: string; name: string } | null) {
		rows = rows.map((entry) =>
			String(entry.id) === String(row.id) ? { ...entry, projectId: to?.id } : entry
		);
		if (to) projectNames = { ...projectNames, [to.id]: to.name };
	}

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
			failure = err instanceof Error ? err.message : m["chat.list.load_failed"]();
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

{#if moving}
	<MoveToProjectModal
		chat={{
			id: String(moving.id),
			title: moving.title,
			model: moving.model,
			updatedAt: moving.updatedAt,
			projectId: moving.projectId,
		}}
		onclose={() => (moving = null)}
		onmoved={(to) => moving && moved(moving, to)}
	/>
{/if}

<div class="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
	<header>
		<h1 class="text-xl font-semibold text-ink">{m["chat.list.title"]()}</h1>
		<p class={s.SUBTITLE}>{m["chat.list.subtitle"]()}</p>
	</header>

	<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto">
		<div class="{s.STRIP} {rows.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
			<div class="flex items-center gap-3">
				<div class={s.STRIP_TILE} class:grayscale={rows.length === 0}>
					<IconChat class="size-5 text-accent" />
				</div>
				<div>
					<p class={s.STRIP_HEADLINE}>
						{#if searching}{m["chat.list.matching"]({ query: query.trim() })}{:else}{m[
								"chat.list.all"
							]()}{/if}
					</p>
					<p class={s.STRIP_DETAIL} role="status" aria-live="polite">
						{#if loading && rows.length === 0}
							{m["chat.list.loading"]()}
						{:else if searching}
							{m["chat.list.count_found"]({ count: rows.length, more: hasMore ? "+" : "" })}
						{:else}
							{m["chat.list.count"]({ count: rows.length, more: hasMore ? "+" : "" })}
						{/if}
					</p>
				</div>
			</div>
			<a href="{base}/" class={s.PRIMARY}>
				<IconAddLarge class="size-4" />
				{m["chat.list.new_chat"]()}
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
				aria-label={m["chat.list.search"]()}
				placeholder={m["chat.list.search"]()}
				maxlength={MAX_TITLE_QUERY_LENGTH}
				autocomplete="off"
				spellcheck="false"
				class="{s.SEARCH} pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
			/>
			{#if input}
				<button
					type="button"
					onclick={clear}
					aria-label={m["chat.list.clear_search"]()}
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
					<li class="relative">
						<a
							href="{base}/conversation/{row.id}"
							data-testid="chats-row"
							class="{s.card(false)} block no-underline hover:border-line-strong"
						>
							<div class="py-3 pr-12 pl-4">
								<h2 class="{s.CARD_TITLE} font-medium">{row.title}</h2>
								<div
									class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted"
								>
									<time
										datetime={new Date(row.updatedAt).toISOString()}
										title={formatDateTime(row.updatedAt, FULL_DATE_TIME)}
									>
										{formatRelativeTime(row.updatedAt)}
									</time>
									{#if row.model}
										<span class="min-w-0 truncate">{modelName(row.model)}</span>
									{/if}
									{#if row.projectId}
										<span class="{s.PILL} {s.PILL_TONES.busy} max-w-full min-w-0">
											<LucideFolderOpen class="size-3 shrink-0" />
											<span class="truncate"
												>{projectNames[row.projectId] ?? m["chat.list.project_fallback"]()}</span
											>
										</span>
									{/if}
								</div>
							</div>
						</a>
						<div class="absolute top-2 right-2">
							<MoveMenu
								label={row.title}
								onmove={() => (moving = row)}
								onremove={row.projectId
									? () =>
											moveConversation(
												{
													id: String(row.id),
													title: row.title,
													model: row.model,
													updatedAt: row.updatedAt,
												},
												null,
												projectNames[row.projectId as string]
											).then((ok) => ok && moved(row, null))
									: undefined}
							/>
						</div>
					</li>
				{/each}
			</ul>
			{#if hasMore}
				<InfiniteScroll onvisible={more} />
			{/if}
		{:else if loading}
			<p class={s.SUBTITLE}>{m["chat.list.loading"]()}</p>
		{:else if !failure}
			<div class={s.EMPTY} data-testid={searching ? "chats-no-results" : "chats-empty"}>
				<IconChat class={s.EMPTY_ICON} />
				{#if searching}
					<p class={s.EMPTY_TITLE}>{m["chat.list.no_match"]({ query: query.trim() })}</p>
					<p class={s.EMPTY_DETAIL}>
						{m["chat.list.no_match_detail"]()}
					</p>
					<button type="button" onclick={clear} class={s.SECONDARY}
						>{m["chat.list.show_all"]()}</button
					>
				{:else}
					<p class={s.EMPTY_TITLE}>{m["chat.list.empty"]()}</p>
					<p class={s.EMPTY_DETAIL}>{m["chat.list.empty_detail"]()}</p>
					<a href="{base}/" class={s.PRIMARY}>
						<IconAddLarge class="size-4" />
						{m["chat.list.start"]()}
					</a>
				{/if}
			</div>
		{/if}
	</div>
</div>
