<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";

	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { exportConversation } from "$lib/stores/exportConversation";
	import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";
	import { findFileVersionBySha } from "$lib/utils/fileArtifacts";
	import * as styles from "$lib/components/overlay/styles";

	import SidePane from "./SidePane.svelte";

	import CarbonCloseLarge from "~icons/carbon/close-large";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonLaunch from "~icons/carbon/launch";
	import CarbonRenew from "~icons/carbon/renew";

	/**
	 * The conversation's persisted `execute_code` deliverables, in the side
	 * pane — the one slot beside the chat, so the list coexists with the
	 * conversation rather than replacing it (a route) or covering it (a
	 * dialog). Also the chat export's new home: the toolbar button became the
	 * menu button that opens this pane, and the same store-driven action runs
	 * from here.
	 *
	 * Conversation-scoped by construction: the store keys rows by
	 * conversationId (no cross-conversation index exists), so this lists the
	 * open chat's files — persistent across reloads and devices for the
	 * 30-day retention window, not across conversations.
	 *
	 * Rows open the file artifact in the panel (registry entry with versions
	 * and preview) rather than a bare new-tab open, so the same file is never
	 * shown twice: this list and the pane nav are two doors into the same
	 * artifact view. The download stays per row. A row with no registry entry
	 * (bytes uploaded but the outcome never recorded) keeps the legacy links.
	 */
	interface Props {
		fileRegistry?: FileArtifactRegistry;
	}

	let { fileRegistry }: Props = $props();

	interface DeliverableFile {
		name: string;
		mime: string;
		size: number;
		sha256: string;
		createdAt: string;
	}

	let conversationId = $derived(page.params?.id);

	type LoadState = "idle" | "loading" | "ready" | "failed";
	let loadState = $state<LoadState>("idle");
	let files = $state<DeliverableFile[]>([]);
	let loadError = $state<string | null>(null);

	async function load(id: string): Promise<void> {
		loadState = "loading";
		loadError = null;
		try {
			const res = await fetch(`${base}/conversation/${id}/code-execution/output`);
			if (!res.ok) throw new Error(`the list request failed (${res.status})`);
			const data = (await res.json()) as { files?: DeliverableFile[] };
			files = Array.isArray(data.files) ? data.files : [];
			loadState = "ready";
		} catch (err) {
			loadError = err instanceof Error ? err.message : "the list failed to load";
			loadState = "failed";
		}
	}

	function refresh() {
		if (conversationId) void load(conversationId);
	}

	// Load on mount (tests render it already open) and whenever the pane opens
	// onto this view afterwards — files uploaded mid-conversation appear.
	onMount(refresh);
	$effect(() => {
		if (sidePane.open && sidePane.view === "library" && conversationId) {
			const id = conversationId;
			// A fresh conversation switch resets the pane, so a re-open always
			// re-reads rather than showing the previous chat's list.
			void load(id);
		}
	});

	function downloadUrl(sha256: string): string {
		return `${base}/conversation/${conversationId}/code-execution/output/${sha256}`;
	}

	/**
	 * Where a row opens: the file artifact at this row's version (following
	 * latest when it already is), or null when the row has no registry entry.
	 */
	function artifactTarget(file: DeliverableFile): { name: string; version: number | null } | null {
		if (!fileRegistry) return null;
		const found = findFileVersionBySha(fileRegistry, file.sha256);
		if (!found) return null;
		const total = fileRegistry.artifacts.get(found.name)?.versions.length ?? found.version;
		return { name: found.name, version: found.version >= total ? null : found.version };
	}

	function kindLabel(file: DeliverableFile): string {
		const extension = file.name.includes(".")
			? (file.name.split(".").pop()?.toLowerCase() ?? "")
			: "";
		switch (extension) {
			case "pdf":
				return "PDF";
			case "csv":
			case "tsv":
				return "Spreadsheet";
			case "md":
			case "markdown":
				return "Markdown";
			case "json":
			case "jsonl":
			case "yaml":
			case "yml":
			case "toml":
				return "Data";
			case "png":
			case "jpg":
			case "jpeg":
			case "gif":
			case "webp":
			case "svg":
			case "bmp":
			case "avif":
				return "Image";
			case "py":
			case "js":
			case "ts":
			case "html":
			case "xml":
			case "tex":
				return "Code";
			case "docx":
				return "Word";
			case "txt":
			case "log":
				return "Text";
			default:
				return file.mime.split("/")[0] === "text" ? "Text" : "File";
		}
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function formatWhen(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return iso;
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}
</script>

{#if sidePane.open && sidePane.view === "library"}
	<SidePane label="Artifacts panel">
		{#snippet children()}
			<header
				class="relative z-10 flex h-12 flex-none items-center gap-2 border-b border-line bg-surface px-3"
			>
				<div class="flex min-w-0 flex-1 items-center gap-2">
					<h2 class="truncate text-sm font-semibold text-ink">Artifacts</h2>
					{#if loadState === "ready"}
						<span
							class="flex-none rounded-sm bg-sunken px-1 py-px font-mono text-xxs text-ink-muted"
						>
							{files.length}
						</span>
					{/if}
				</div>
				<div class="flex flex-none items-center gap-0.5 text-ink-muted">
					<button
						type="button"
						class="btn rounded-md p-1.5 text-xs hover:bg-sunken hover:text-ink"
						title="Reload the list"
						aria-label="Reload artifacts"
						disabled={loadState === "loading"}
						onclick={refresh}
					>
						<CarbonRenew />
					</button>
					<button
						type="button"
						class="ml-0.5 btn rounded-md p-1 text-base hover:bg-sunken hover:text-ink"
						title="Close panel (Esc)"
						onclick={() => sidePane.close()}
					>
						<CarbonCloseLarge />
					</button>
				</div>
			</header>

			<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto bg-surface p-4">
				<p class="{styles.SECTION_TITLE} flex items-center gap-1.5">
					Files this chat generated
					<span class="font-normal">· kept 30 days</span>
				</p>

				{#if loadState === "loading" && files.length === 0}
					<p class="py-8 text-center text-sm text-ink-muted">Loading artifacts…</p>
				{:else if loadState === "failed" && files.length === 0}
					<div class={styles.EMPTY}>
						<CarbonDocument class={styles.EMPTY_ICON} />
						<p class={styles.EMPTY_TITLE}>Couldn't load artifacts</p>
						<p class={styles.EMPTY_DETAIL}>{loadError}</p>
						<button type="button" class={styles.PRIMARY} onclick={refresh}>
							<CarbonRenew /> Try again
						</button>
					</div>
				{:else if files.length === 0}
					<div class={styles.EMPTY}>
						<CarbonDocument class={styles.EMPTY_ICON} />
						<p class={styles.EMPTY_TITLE}>No artifacts yet</p>
						<p class={styles.EMPTY_DETAIL}>
							Files the model generates for this chat — reports, tables, images — land here and stay
							available for 30 days, across reloads and devices.
						</p>
					</div>
				{:else}
					<ul class="space-y-2">
						{#each files as file (file.sha256)}
							{@const target = artifactTarget(file)}
							<li
								class="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs"
							>
								<CarbonDocument class="size-3.5 shrink-0 text-ink-faint" />
								<span class="min-w-0 flex-1">
									<span class="block truncate font-mono text-ink" title={file.name}>
										{file.name}
									</span>
									<span class="block truncate text-ink-muted">
										{kindLabel(file)} · {formatSize(file.size)} ·
										<time datetime={file.createdAt} title={file.createdAt}>
											{formatWhen(file.createdAt)}
										</time>
									</span>
								</span>
								{#if target}
									<button
										type="button"
										class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-subtle"
										aria-label={`Open ${file.name} in panel`}
										title={`Open ${file.name} in panel`}
										onclick={() => sidePane.openArtifact(target.name, target.version)}
									>
										<CarbonLaunch class="size-3.5" /> Open
									</button>
								{:else}
									<a
										href={downloadUrl(file.sha256)}
										target="_blank"
										rel="noopener"
										class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-subtle"
										aria-label={`Open ${file.name}`}
										title={`Open ${file.name}`}
									>
										<CarbonLaunch class="size-3.5" /> Open
									</a>
								{/if}
								<a
									href={downloadUrl(file.sha256)}
									download={file.name}
									class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-accent hover:bg-accent-subtle"
									aria-label={`Download ${file.name}`}
									title={`Download ${file.name}`}
								>
									<CarbonDownload class="size-3.5" /> Download
								</a>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="mt-6 border-t border-line pt-4">
					<p class={styles.SECTION_TITLE}>Export this chat</p>
					<p class="mb-3 text-xs text-ink-muted">
						Download the visible conversation as Markdown, with reasoning included.
					</p>
					<button
						type="button"
						class={styles.SECONDARY}
						disabled={!$exportConversation.canExport || $exportConversation.loading}
						aria-label="Export conversation as Markdown"
						title="Export conversation as Markdown"
						onclick={() => $exportConversation.run()}
					>
						<CarbonDownload /> Export conversation
					</button>
				</div>
			</div>
		{/snippet}
	</SidePane>
{/if}
