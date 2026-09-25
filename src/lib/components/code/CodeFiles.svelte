<!--
	The /code explorer (ADR 0090, F1): the workspace's files, read-only,
	served by galopin from inside the workspace directory. A tree with git
	badges; picking a file opens it in place (a back link returns to the
	tree), as text in a read-only CodeMirror view with "Load more" past
	1 MiB, as an image, or as a note for binaries. Refreshed by hand and at
	every turn boundary, when an agent may have written.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import IconRenew from "~icons/carbon/renew";
	import IconArrowLeft from "~icons/carbon/arrow-left";
	import IconLocked from "~icons/carbon/locked";
	import CodeFileTree from "./CodeFileTree.svelte";
	import CodeFileViewer from "./CodeFileViewer.svelte";
	import { readWorkspaceFile, workspaceFileRawUrl, workspaceFileStatus } from "$lib/codeApi";
	import type { FileEntry, FilesReadResult } from "$lib/types/machineProtocol";
	import { gitBadges, humanSize, type GitBadge } from "$lib/utils/codeFiles";

	interface Props {
		deviceId: string;
		workspaceId: string;
		/** Bumped by the view at each turn boundary. */
		turnKey?: number;
	}

	let { deviceId, workspaceId, turnKey = 0 }: Props = $props();

	let refreshKey = $state(0);
	let badges = $state<Map<string, GitBadge>>(new Map());
	let branch = $state<string | null>(null);
	let open = $state<FileEntry | null>(null);
	let file = $state<FilesReadResult | null>(null);
	let text = $state("");
	let loading = $state(false);
	let failure = $state<string | null>(null);

	async function loadStatus() {
		try {
			const status = await workspaceFileStatus(deviceId, workspaceId);
			badges = gitBadges(status.entries);
			branch = status.branch ?? null;
		} catch {
			badges = new Map();
		}
	}

	async function loadFile(entry: FileEntry, append = false) {
		loading = true;
		failure = null;
		try {
			const res = await readWorkspaceFile(
				deviceId,
				workspaceId,
				entry.path,
				append && file ? file.offset + file.length : 0
			);
			if (!append) text = "";
			text += res.content ?? "";
			file = res;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not read this file.";
		} finally {
			loading = false;
		}
	}

	function select(entry: FileEntry) {
		open = entry;
		file = null;
		text = "";
		if (entry.redacted) return;
		void loadFile(entry);
	}

	function refresh() {
		refreshKey += 1;
		void loadStatus();
		if (open && !open.redacted) void loadFile(open);
	}

	// Only the turn key re-runs this: refresh() reads and bumps its own state.
	$effect(() => {
		void turnKey;
		untrack(refresh);
	});
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="code-files">
	<div
		class="flex h-9 shrink-0 items-center gap-2 border-b border-gray-200 px-3 dark:border-gray-700"
	>
		{#if open}
			<button
				type="button"
				class="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
				aria-label="Back to files"
				onclick={() => (open = null)}
			>
				<IconArrowLeft class="size-3.5" />
				Files
			</button>
			<span
				class="min-w-0 flex-1 truncate font-mono text-xs text-gray-600 dark:text-gray-300"
				title={open.path}>{open.path}</span
			>
		{:else}
			<span class="min-w-0 flex-1 truncate text-xs text-gray-500">
				{branch ? `On ${branch}` : "Workspace files"}
			</span>
		{/if}
		<button
			type="button"
			class="flex size-6 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
			title="Refresh"
			aria-label="Refresh files"
			onclick={refresh}
		>
			<IconRenew class="size-3.5 {loading ? 'animate-spin' : ''}" />
		</button>
	</div>

	<div class="min-h-0 flex-1 overflow-auto">
		<div class={open ? "hidden" : "p-1"}>
			<CodeFileTree
				{deviceId}
				{workspaceId}
				path="."
				depth={0}
				{badges}
				selected={open?.path ?? null}
				{refreshKey}
				onselect={select}
			/>
		</div>
		{#if open}
			{#if open.redacted}
				<p class="flex items-center gap-2 p-4 text-sm text-gray-500">
					<IconLocked class="size-4 shrink-0" />
					Hidden by this machine's policy. This keeps secrets off screens and out of logs; it is not a
					boundary: the agent can still read the file.
				</p>
			{:else if failure}
				<p class="p-4 text-sm text-red-600 dark:text-red-400">{failure}</p>
			{:else if !file}
				<p class="p-4 text-sm text-gray-400">Loading…</p>
			{:else if file.kind === "image"}
				<div class="flex justify-center p-4">
					<img
						src={workspaceFileRawUrl(deviceId, workspaceId, open.path)}
						alt={open.name}
						class="max-w-full rounded-sm border border-gray-200 dark:border-gray-700"
					/>
				</div>
			{:else if file.kind === "binary"}
				<p class="p-4 text-sm text-gray-500">Binary file · {humanSize(file.size)}</p>
			{:else}
				<CodeFileViewer path={open.path} content={text} />
				{#if !file.eof}
					<div
						class="flex items-center gap-2 border-t border-gray-200 p-2 text-xs dark:border-gray-700"
					>
						<span class="text-gray-500"
							>Showing {humanSize(file.offset + file.length)} of {humanSize(file.size)}</span
						>
						<button
							type="button"
							class="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
							disabled={loading}
							onclick={() => open && loadFile(open, true)}
						>
							Load more
						</button>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
</div>
