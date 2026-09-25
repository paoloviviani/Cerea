<!--
	One directory of the /code explorer's tree, loaded when it is first shown
	(directories expand lazily, one listing per expand). Our own small tree
	(ADR 0090 D10): directories first, git badges rolled up to folders,
	ignored entries dimmed and never auto-expanded, redacted secrets locked.
-->
<script lang="ts">
	import Self from "./CodeFileTree.svelte";
	import IconFolder from "~icons/carbon/folder";
	import IconFolderOpen from "~icons/carbon/folder-open";
	import IconDocument from "~icons/carbon/document";
	import IconLink from "~icons/carbon/link";
	import IconLocked from "~icons/carbon/locked";
	import { listWorkspaceFiles } from "$lib/codeApi";
	import type { FileEntry } from "$lib/types/machineProtocol";
	import type { GitBadge } from "$lib/utils/codeFiles";

	interface Props {
		deviceId: string;
		workspaceId: string;
		/** The directory this node lists ("." for the root). */
		path: string;
		depth: number;
		badges: Map<string, GitBadge>;
		selected: string | null;
		/** Bumped by the pane to re-read every open directory. */
		refreshKey: number;
		onselect: (entry: FileEntry) => void;
	}

	let { deviceId, workspaceId, path, depth, badges, selected, refreshKey, onselect }: Props =
		$props();

	let entries = $state<FileEntry[] | null>(null);
	let truncated = $state(false);
	let failure = $state<string | null>(null);
	let expanded = $state<Record<string, boolean>>({});

	$effect(() => {
		void refreshKey;
		const dir = path;
		failure = null;
		void listWorkspaceFiles(deviceId, workspaceId, dir)
			.then((res) => {
				entries = res.entries;
				truncated = res.truncated;
			})
			.catch((err) => {
				failure = err instanceof Error ? err.message : "Could not list this folder.";
			});
	});

	const badgeClass: Record<GitBadge, string> = {
		M: "text-amber-600 dark:text-amber-400",
		A: "text-green-600 dark:text-green-400",
		D: "text-red-600 dark:text-red-400",
		R: "text-blue-600 dark:text-blue-400",
		U: "text-red-700 dark:text-red-300",
		"?": "text-green-700 dark:text-green-500",
	};

	function toggle(entry: FileEntry) {
		expanded = { ...expanded, [entry.path]: !expanded[entry.path] };
	}
</script>

{#if failure}
	<p class="py-1 text-xs text-red-600 dark:text-red-400" style="padding-left: {depth * 12 + 8}px">
		{failure}
	</p>
{:else if entries === null}
	<p class="py-1 text-xs text-gray-400" style="padding-left: {depth * 12 + 8}px">Loading…</p>
{:else}
	<ul
		role={depth === 0 ? "tree" : "group"}
		aria-label={depth === 0 ? "Workspace files" : undefined}
	>
		{#each entries as entry (entry.path)}
			{@const badge = badges.get(entry.path)}
			{@const isDir = entry.type === "dir"}
			{@const open = isDir && expanded[entry.path] === true}
			<li
				role="treeitem"
				aria-expanded={isDir ? open : undefined}
				aria-selected={selected === entry.path}
			>
				<button
					type="button"
					class="flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs hover:bg-gray-100 dark:hover:bg-gray-700/60 {selected ===
					entry.path
						? 'bg-gray-100 dark:bg-gray-700/60'
						: ''} {entry.ignored ? 'opacity-50' : ''}"
					style="padding-left: {depth * 12 + 8}px"
					title={entry.redacted
						? "Hidden by this machine's policy"
						: entry.symlink?.escapes
							? `Points outside the workspace: ${entry.symlink.target}`
							: entry.path}
					onclick={() => (isDir ? toggle(entry) : onselect(entry))}
				>
					{#if isDir}
						{#if open}<IconFolderOpen class="size-3.5 shrink-0 text-gray-500" />{:else}<IconFolder
								class="size-3.5 shrink-0 text-gray-500"
							/>{/if}
					{:else if entry.type === "symlink"}
						<IconLink class="size-3.5 shrink-0 text-gray-500" />
					{:else}
						<IconDocument class="size-3.5 shrink-0 text-gray-400" />
					{/if}
					<span class="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">{entry.name}</span>
					{#if entry.redacted}
						<IconLocked
							class="size-3 shrink-0 text-gray-500"
							aria-label="Hidden by this machine's policy"
						/>
					{/if}
					{#if badge}
						<span
							class="shrink-0 font-mono text-[10px] font-semibold {badgeClass[badge]}"
							data-testid="git-badge">{badge === "?" ? "U" : badge === "U" ? "!" : badge}</span
						>
					{/if}
				</button>
				{#if open}
					<Self
						{deviceId}
						{workspaceId}
						path={entry.path}
						depth={depth + 1}
						{badges}
						{selected}
						{refreshKey}
						{onselect}
					/>
				{/if}
			</li>
		{:else}
			<li class="py-1 text-xs text-gray-400" style="padding-left: {depth * 12 + 8}px">
				Empty folder
			</li>
		{/each}
		{#if truncated}
			<li class="py-1 text-xs text-gray-400" style="padding-left: {depth * 12 + 8}px">
				Only the first 5 000 entries are shown.
			</li>
		{/if}
	</ul>
{/if}
