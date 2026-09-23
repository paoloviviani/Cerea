<!--
	What one agent changed, file by file, through the shared diff machinery —
	housed in the chat's shared side pane (the same frame artifacts open in;
	the view mounts only while `sidePane.view` is "diff").

	The before/after pairs come from the daemon (`GET v1/agents/{id}/diff`
	through the forwarder); alignment and HTML rendering are `artifactDiff`'s
	`diffLines`/`renderDiffHtml`, the same pure util the artifact panel uses.
	The `<style>` block below is that panel's diff-view CSS, copied rather
	than imported — Svelte scopes styles per component, and these classes only
	mean anything on `renderDiffHtml` output.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import IconDocument from "~icons/carbon/document";
	import IconRenew from "~icons/carbon/renew";
	import IconWarning from "~icons/carbon/warning-filled";
	import CarbonCloseLarge from "~icons/carbon/close-large";
	import { getAgentDiff } from "$lib/codeApi";
	import type { CodeFileChange } from "$lib/types/CodeAgent";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { diffLines, diffStats, renderDiffHtml } from "$lib/utils/artifactDiff";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
	}

	let { deviceId, agentId }: Props = $props();

	let files = $state<CodeFileChange[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);

	async function load() {
		loading = true;
		failure = null;
		try {
			files = (await getAgentDiff(deviceId, agentId)).files;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load the agent's changes.";
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	function html(file: CodeFileChange): string {
		return renderDiffHtml(diffLines(file.oldText, file.newText));
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<div
		class="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 px-4 dark:border-gray-800"
	>
		<IconDocument class="size-4 shrink-0 text-ink-muted" />
		<h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">Changes</h2>
		<button
			type="button"
			class="btn rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
			onclick={() => void load()}
			disabled={loading}
			aria-label="Refresh changes"
			title="Refresh from the daemon"
		>
			<IconRenew class="size-4 {loading ? 'animate-spin' : ''}" />
		</button>
		<button
			type="button"
			class="btn rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
			onclick={() => sidePane.close()}
			aria-label="Close changes panel"
		>
			<CarbonCloseLarge class="size-4" />
		</button>
	</div>

	<div class="scrollbar-custom flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
		{#if loading}
			<div class={s.EMPTY}>
				<IconRenew class="{s.EMPTY_ICON} animate-spin" />
				<p class={s.EMPTY_TITLE}>Loading changes…</p>
			</div>
		{:else if failure}
			<div class={s.ERROR}>
				<p class="flex items-center gap-1.5 font-medium">
					<IconWarning class="size-4" />
					Could not load changes
				</p>
				<p class="mt-1">{failure}</p>
			</div>
		{:else if files.length === 0}
			<div class={s.EMPTY}>
				<IconDocument class={s.EMPTY_ICON} />
				<p class={s.EMPTY_TITLE}>No changes yet</p>
				<p class={s.EMPTY_DETAIL}>Files this agent edits will appear here as diffs.</p>
			</div>
		{:else}
			{#each files as file (file.path)}
				{@const stats = diffStats(diffLines(file.oldText, file.newText))}
				<div class={s.card(false)}>
					<div class="flex items-center gap-2 border-b border-line px-4 py-2.5 font-mono text-xs">
						<IconDocument class="size-4 shrink-0 text-ink-muted" />
						<span class="min-w-0 flex-1 truncate text-ink">{file.path}</span>
						<span class="shrink-0 text-green-700">+{stats.added}</span>
						<span class="shrink-0 text-red-700">−{stats.removed}</span>
					</div>
					<!-- eslint-disable svelte/no-at-html-tags -->
					<!-- Safe by construction: `renderDiffHtml` escapes both sides (its
					     default highlighter is `escapeHtml`), so the only markup here is
					     the diff's own spans — the same contract the artifact panel relies on. -->
					<pre
						class="diff-view scrollbar-custom max-h-96 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">{@html html(
							file
						)}</pre>
				</div>
			{/each}
		{/if}
	</div>
</div>

<style>
	/* Diff view: background-only tint bands behind changed lines, so token
	   colors stay intact; the changed segment of a replaced line gets a
	   stronger emphasis chip. Copied from the artifact panel, which owns this
	   rendering — see `components/chat/ArtifactPanel.svelte`. */
	pre.diff-view :global(.diff-line) {
		display: inline-block;
		min-width: 100%;
		border-radius: 0.125rem;
	}
	pre.diff-view :global(.diff-add) {
		background: rgba(80, 161, 79, 0.09);
	}
	pre.diff-view :global(.diff-del) {
		background: rgba(228, 86, 73, 0.08);
	}
	pre.diff-view :global(.diff-add > .diff-sign) {
		color: #50a14f;
	}
	pre.diff-view :global(.diff-del > .diff-sign) {
		color: #e45649;
	}
	pre.diff-view :global(.diff-add .diff-emph) {
		background: rgba(80, 161, 79, 0.22);
		border-radius: 0.1875rem;
	}
	pre.diff-view :global(.diff-del .diff-emph) {
		background: rgba(228, 86, 73, 0.2);
		border-radius: 0.1875rem;
	}
	:global(.dark) pre.diff-view :global(.diff-add) {
		background: rgba(152, 195, 121, 0.1);
	}
	:global(.dark) pre.diff-view :global(.diff-del) {
		background: rgba(224, 108, 117, 0.1);
	}
	:global(.dark) pre.diff-view :global(.diff-add > .diff-sign) {
		color: #98c379;
	}
	:global(.dark) pre.diff-view :global(.diff-del > .diff-sign) {
		color: #e06c75;
	}
	:global(.dark) pre.diff-view :global(.diff-add .diff-emph) {
		background: rgba(224, 108, 117, 0.24);
	}
	:global(.dark) pre.diff-view :global(.diff-del .diff-emph) {
		background: rgba(224, 108, 117, 0.24);
	}
</style>
