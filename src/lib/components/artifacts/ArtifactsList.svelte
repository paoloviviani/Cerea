<!--
	The Artifacts tab: everything the model made in your own chats, one row per
	artifact, newest first. It is the project page's tab (`project` is the
	project's id) and the chats page's tab (`project="none"`: the chats that
	are in no project).

	A row shows what the side panel shows for the artifact: its name, what kind
	it is, the latest version and how many there are, the chat it came from and
	when. The name and the chat open that chat with the artifact in the side
	panel (`?artifact=`), which is the preview; the download takes the latest
	version. Nothing here deletes: an artifact belongs to its chat and goes
	with it.

	The name filter narrows as you type (after a short pause); more rows load
	as the end of the list scrolls into view. Loads in `onMount`: this renders
	as part of a page, and a page body runs on the server, where a relative
	fetch has no origin.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";
	import { formatRelativeTime } from "$lib/utils/relativeTime";
	import { formatDateTime } from "$lib/i18n/format";
	import { FULL_DATE_TIME } from "$lib/i18n/dateOptions";
	import { fileKindLabel, fileKindOf, formatFileSize } from "$lib/utils/filePreview";
	import InfiniteScroll from "$lib/components/InfiniteScroll.svelte";
	import * as s from "$lib/components/overlay/styles";

	import CarbonCode from "~icons/carbon/code";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonImage from "~icons/carbon/image";
	import CarbonLogoReact from "~icons/carbon/logo-react";
	import CarbonTable from "~icons/carbon/table";
	import IconClose from "~icons/carbon/close";
	import IconSearch from "~icons/carbon/search";
	import LucideAppWindow from "~icons/lucide/app-window";
	import LucideShapes from "~icons/lucide/shapes";
	import LucideWorkflow from "~icons/lucide/workflow";

	interface Row {
		kind: "file" | "artifact";
		name: string;
		identifier: string;
		type: string;
		version: number;
		versionCount: number;
		conversationId: string;
		conversationTitle: string;
		at: string;
		sha256?: string;
		size?: number;
	}

	/** A project's id, or "none" for the chats that are in no project. */
	let { project }: { project: string } = $props();

	let input = $state("");
	let query = $state("");
	let rows = $state<Row[]>([]);
	let hasMore = $state(false);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let nextPage = 0;
	/** Bumped on every new filter, so a slow answer to an old one is dropped. */
	let generation = 0;
	let debounce: ReturnType<typeof setTimeout> | undefined;

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
			const params = new URLSearchParams({ project, p: String(asked) });
			if (query.trim()) params.set("q", query.trim());
			const response = await fetch(`${base}/api/v2/artifacts?${params}`);
			if (!response.ok) throw new Error(m["artifacts.list.load_failed"]());
			const result = (await response.json()) as { data: Row[]; hasMore: boolean };
			if (mine !== generation) return;
			rows = reset ? result.data : [...rows, ...result.data];
			hasMore = result.hasMore;
			nextPage = asked + 1;
			failure = null;
		} catch (err) {
			if (mine !== generation) return;
			failure = err instanceof Error ? err.message : m["artifacts.list.load_failed"]();
			hasMore = false;
		} finally {
			if (mine === generation) loading = false;
		}
	}

	function more() {
		if (hasMore && !loading) {
			loading = true;
			void load(false);
		}
	}

	function filter(value: string) {
		if (value.trim() === query.trim()) return;
		query = value;
		void load(true);
	}

	function onInput() {
		clearTimeout(debounce);
		debounce = setTimeout(() => filter(input), 250);
	}

	function clear() {
		clearTimeout(debounce);
		input = "";
		filter("");
	}

	onMount(() => {
		void load(true);
		return () => clearTimeout(debounce);
	});

	/** The chat, with the artifact open in its side panel. */
	const openHref = (row: Row) =>
		`${base}/conversation/${row.conversationId}?artifact=${encodeURIComponent(row.identifier)}`;

	/** A file is downloaded from the store; a text artifact is cut from its chat. */
	const downloadHref = (row: Row) =>
		row.kind === "file"
			? `${base}/conversation/${row.conversationId}/code-execution/output/${row.sha256}`
			: `${base}/api/v2/artifacts/download?conversation=${row.conversationId}&identifier=${encodeURIComponent(row.identifier)}`;

	const ARTIFACT_KINDS = ["code", "html", "markdown", "mermaid", "react", "svg", "table"] as const;
	type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
	const artifactKind = (type: string): ArtifactKind =>
		(ARTIFACT_KINDS as readonly string[]).includes(type) ? (type as ArtifactKind) : "code";

	function kindLabel(row: Row): string {
		return row.kind === "file"
			? fileKindLabel(row.name, row.type)
			: m[`chat.artifact.kind.${artifactKind(row.type)}`]();
	}

	function iconFor(row: Row) {
		if (row.kind === "artifact") {
			switch (artifactKind(row.type)) {
				case "html":
					return LucideAppWindow;
				case "react":
					return CarbonLogoReact;
				case "mermaid":
					return LucideWorkflow;
				case "table":
					return CarbonTable;
				case "svg":
					return CarbonImage;
				case "code":
					return CarbonCode;
				default:
					return CarbonDocument;
			}
		}
		switch (fileKindOf(row.name, row.type)) {
			case "spreadsheet":
				return CarbonTable;
			case "image":
				return CarbonImage;
			case "code":
			case "data":
				return CarbonCode;
			default:
				return CarbonDocument;
		}
	}
</script>

<div class="flex flex-col gap-4 pb-6" data-testid="artifacts-list">
	<div class="{s.STRIP} {rows.length > 0 ? s.STRIP_ACTIVE : s.STRIP_IDLE}">
		<div class="flex items-center gap-3">
			<div class={s.STRIP_TILE} class:grayscale={rows.length === 0}>
				<LucideShapes class="size-5 text-accent" />
			</div>
			<div>
				<p class={s.STRIP_HEADLINE}>
					{#if searching}{m["chat.list.matching"]({ query: query.trim() })}{:else}{m[
							"artifacts.list.headline"
						]()}{/if}
				</p>
				<p class={s.STRIP_DETAIL} role="status" aria-live="polite">
					{#if loading && rows.length === 0}
						{m["artifacts.list.loading"]()}
					{:else if searching}
						{m["artifacts.list.count_found"]({ count: rows.length, more: hasMore ? "+" : "" })}
					{:else}
						{m["artifacts.list.count"]({ count: rows.length, more: hasMore ? "+" : "" })}
					{/if}
				</p>
			</div>
		</div>
		<p class="hidden max-w-xs text-xs text-ink-muted sm:block">
			{project === "none" ? m["artifacts.list.scope_chats"]() : m["artifacts.list.scope_project"]()}
		</p>
	</div>

	<div class="relative">
		<IconSearch
			class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
		/>
		<input
			bind:value={input}
			oninput={onInput}
			onkeydown={(event) => {
				if (event.key === "Enter") {
					clearTimeout(debounce);
					filter(input);
				}
				if (event.key === "Escape" && input) {
					event.preventDefault();
					clear();
				}
			}}
			type="search"
			name="artifact-search"
			data-testid="artifacts-search"
			aria-label={m["artifacts.list.search"]()}
			placeholder={m["artifacts.list.search"]()}
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
		<p class={s.ERROR} role="alert">{failure}</p>
	{/if}

	{#if rows.length > 0}
		<ul class="flex flex-col gap-2" data-testid="artifacts-rows">
			{#each rows as row (`${row.conversationId}:${row.kind}:${row.identifier}`)}
				{@const Icon = iconFor(row)}
				<li
					class="{s.card(false)} flex items-start gap-3 py-3 pr-3 pl-4"
					data-testid="artifacts-row"
				>
					<Icon class="mt-0.5 size-5 shrink-0 text-ink-faint" />
					<div class="min-w-0 flex-1">
						<a
							href={openHref(row)}
							aria-label={m["artifacts.list.open"]({ name: row.name })}
							class="{s.CARD_TITLE} block font-medium no-underline hover:underline"
						>
							{row.name}
						</a>
						<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
							<span class="{s.PILL} {s.PILL_TONES.busy}">{kindLabel(row)}</span>
							<span>
								{m["chat.panel.version"]({ number: row.version })} ·
								{m["artifacts.list.versions"]({ count: row.versionCount })}
							</span>
							{#if row.size !== undefined}<span>{formatFileSize(row.size)}</span>{/if}
							<time datetime={row.at} title={formatDateTime(row.at, FULL_DATE_TIME)}>
								{formatRelativeTime(row.at)}
							</time>
						</div>
						<a
							href={openHref(row)}
							class="mt-1 block max-w-full truncate text-xs text-accent no-underline hover:underline"
						>
							{m["artifacts.list.from_chat"]({ title: row.conversationTitle })}
						</a>
					</div>
					<a
						href={downloadHref(row)}
						download
						data-sveltekit-reload
						aria-label={m["artifacts.list.download"]({ name: row.name })}
						title={m["artifacts.list.download"]({ name: row.name })}
						class="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-muted hover:bg-sunken hover:text-ink"
					>
						<CarbonDownload class="size-4" />
					</a>
				</li>
			{/each}
		</ul>
		{#if hasMore}
			<InfiniteScroll onvisible={more} />
		{/if}
	{:else if loading}
		<p class={s.SUBTITLE}>{m["artifacts.list.loading"]()}</p>
	{:else if !failure}
		<div class={s.EMPTY} data-testid={searching ? "artifacts-no-results" : "artifacts-empty"}>
			<LucideShapes class={s.EMPTY_ICON} />
			{#if searching}
				<p class={s.EMPTY_TITLE}>{m["artifacts.list.no_match"]({ query: query.trim() })}</p>
				<p class={s.EMPTY_DETAIL}>{m["artifacts.list.no_match_detail"]()}</p>
				<button type="button" onclick={clear} class={s.SECONDARY}>
					{m["artifacts.list.show_all"]()}
				</button>
			{:else}
				<p class={s.EMPTY_TITLE}>{m["artifacts.list.empty"]()}</p>
				<p class={s.EMPTY_DETAIL}>
					{project === "none"
						? m["artifacts.list.empty_chats"]()
						: m["artifacts.list.empty_project"]()}
				</p>
			{/if}
		</div>
	{/if}
</div>
