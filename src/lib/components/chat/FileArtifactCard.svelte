<script lang="ts">
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import { getArtifactsContext } from "$lib/utils/artifactsContext";
	import { findFileVersionBySha } from "$lib/utils/fileArtifacts";
	import { fileKindLabel, formatFileSize, isInlineRasterImage } from "$lib/utils/filePreview";
	import { readFileBytes, triggerBrowserDownload } from "$lib/utils/fileBytes";
	import {
		cachedFileBytes,
		fileBaseName,
		fileDirName,
		runFileName,
	} from "$lib/utils/execution/fileIdentity";
	import { retryFileUpload } from "$lib/utils/execution/runFiles";
	import InlineRasterImage from "./InlineRasterImage.svelte";
	import MiddleTruncate from "./MiddleTruncate.svelte";

	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonLaunch from "~icons/carbon/launch";
	import CarbonRenew from "~icons/carbon/renew";

	/**
	 * One produced file: the single card every file gets, live and after a
	 * reload, on the surfaces that show it (a run's file rows, a tool's files,
	 * a fence's output). The file's identity is its sha256, computed in the
	 * browser when the run listed it, so nothing here depends on whether an
	 * upload has answered; the join to the file-artifact registry (by sha256
	 * and name, never by name alone) only decides whether the file can open in
	 * the panel and which version it is.
	 *
	 * `variant="row"` is a row inside a surface that already frames it (the
	 * run card), separated by dividers; `"card"` is a standalone surface for a
	 * file shown outside a run.
	 *
	 * A file whose upload failed is shown as "not saved": it can still be
	 * downloaded while this tab holds its bytes (and saved again), and after a
	 * reload the card says it is gone rather than vanishing.
	 */
	interface Props {
		/** `path` is the sandbox path of a live file or the stored name. */
		file: { path: string; size: number };
		/** sha256 of these exact bytes. */
		sha256?: string;
		/** Direct-emission mode: the file's own text. */
		inlineContent?: string;
		/** The output store's URL; derived from the conversation and sha256 when absent. */
		downloadUrl?: string;
		/** Whether the stored reference says the bytes are in the store. */
		uploaded?: boolean;
		/** Rendered inside the artifact panel: omit the "Open in panel" action. */
		inPanel?: boolean;
		/** Show a raster image under the row without a click (a chat figure). */
		autoExpand?: boolean;
		variant?: "row" | "card";
	}

	let {
		file,
		sha256,
		inlineContent,
		downloadUrl,
		uploaded,
		inPanel = false,
		autoExpand = false,
		variant = "card",
	}: Props = $props();

	const ctx = getArtifactsContext();

	/** Full name: relative path under the working directory. */
	let fullName = $derived(runFileName(file.path));
	let baseName = $derived(fileBaseName(fullName));
	let dirName = $derived(fileDirName(fullName));

	let resolved = $derived.by(() => {
		const registry = ctx?.fileRegistry;
		if (!registry || !sha256) return undefined;
		const found = findFileVersionBySha(registry, sha256, fullName);
		if (!found) return undefined;
		const artifact = registry.artifacts.get(found.name);
		const version = artifact?.versions[found.version - 1];
		if (!artifact || !version) return undefined;
		return {
			name: found.name,
			version: found.version,
			total: artifact.versions.length,
			size: version.size,
			uploaded: version.uploaded,
			messageId: version.messageId,
			runKey: version.runKey,
		};
	});

	let size = $derived(inlineContent !== undefined ? file.size : (resolved?.size ?? file.size));
	let kindLabel = $derived(fileKindLabel(baseName));
	let versionLabel = $derived(resolved && resolved.total > 1 ? ` · v${resolved.version}` : "");
	/** "dir/ · Kind · size · v2": short, the directory only when there is one. */
	let meta = $derived(
		[dirName ? `${dirName}/` : "", kindLabel, `${formatFileSize(size)}${versionLabel}`]
			.filter(Boolean)
			.join(" · ")
	);

	// What the reference says wins over the prop: a retried upload upgrades it.
	let storedFlag = $derived(resolved?.uploaded ?? uploaded);
	let kept = $derived(sha256 !== undefined && cachedFileBytes(sha256) !== undefined);
	let notSaved = $derived(storedFlag === false);
	let gone = $derived(notSaved && !kept && inlineContent === undefined);

	let conversationId = $derived(page.params?.id);
	let storeUrl = $derived(
		notSaved
			? undefined
			: (downloadUrl ??
					(sha256 && conversationId
						? `${base}/conversation/${conversationId}/code-execution/output/${sha256}`
						: undefined))
	);

	let isActive = $derived.by(() => {
		if (!ctx || !resolved) return false;
		if (!ctx.panel.open || ctx.panel.identifier !== resolved.name) return false;
		const displayed = Math.min(ctx.panel.version ?? resolved.total, resolved.total);
		return displayed === resolved.version;
	});

	function openInPanel(): void {
		if (!resolved) return;
		// Follow the latest version when this card points at it.
		ctx?.panel.openArtifact(
			resolved.name,
			resolved.version >= resolved.total ? null : resolved.version
		);
	}

	const load = () => readFileBytes({ file, sha256, inlineContent, downloadUrl: storeUrl });

	let downloading = $state(false);
	let downloadError = $state<string | null>(null);
	async function downloadFile(): Promise<void> {
		downloading = true;
		downloadError = null;
		try {
			triggerBrowserDownload(baseName, await load());
		} catch (err) {
			downloadError =
				err instanceof Error
					? err.message
					: "that file is no longer in the runtime; run the code again to recreate it";
		} finally {
			downloading = false;
		}
	}

	let retrying = $state(false);
	let retryFailed = $state(false);
	let canRetry = $derived(
		notSaved && kept && !!resolved && !!conversationId && !!sha256 && !inPanel
	);
	async function retry(): Promise<void> {
		if (!resolved || !conversationId || !sha256) return;
		retrying = true;
		retryFailed = false;
		try {
			const ok = await retryFileUpload({
				conversationId,
				messageId: resolved.messageId,
				runKey: resolved.runKey ?? `chat:retry-${sha256.slice(0, 12)}`,
				file: { name: resolved.name, size, sha256 },
			});
			retryFailed = !ok;
		} finally {
			retrying = false;
		}
	}

	const showsImage = $derived(autoExpand && isInlineRasterImage(baseName) && !gone);

	const ACTION =
		"flex items-center justify-center gap-1 rounded-md px-1.5 py-1.5 @[520px]:px-2 text-xs text-blue-600 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:text-blue-400 dark:hover:bg-blue-500/10";
</script>

<li
	class="@container list-none {variant === 'row'
		? 'py-3 first:pt-1 last:pb-1 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-gray-300/50 dark:[&:not(:first-child)]:border-gray-600/40'
		: `my-1 w-full max-w-md min-w-[min(26rem,calc(100vw-3rem))] rounded-xl border bg-gray-500/[0.06] px-3 py-3 ${isActive ? 'border-blue-300 ring-1 ring-blue-300 dark:border-blue-500/30 dark:ring-blue-500/30' : 'border-gray-300/60 dark:border-gray-600/50'}`}"
	data-exclude-from-copy
	data-testid="file-artifact-card"
>
	<div class="flex items-center gap-2.5 @[520px]:gap-3">
		<div
			class="flex size-9 flex-none items-center justify-center rounded-lg bg-gray-500/10 text-gray-500 @max-[380px]:hidden dark:text-gray-300"
		>
			<CarbonDocument class="text-base" />
		</div>
		<div class="min-w-[8ch] flex-1">
			<MiddleTruncate
				text={baseName}
				class="text-sm font-medium text-gray-800 dark:text-gray-200"
			/>
			<p class="truncate text-xs text-gray-500 dark:text-gray-400">
				{meta}
			</p>
		</div>
		<div class="flex flex-none items-center gap-0.5">
			{#if resolved && !inPanel && !gone}
				<button
					type="button"
					class={ACTION}
					aria-label="Open {baseName} in panel"
					title="Open {baseName} in panel"
					onclick={openInPanel}
				>
					<CarbonLaunch class="size-4 @[520px]:size-3.5" />
					<span class="hidden @[520px]:inline">Open</span>
				</button>
			{/if}
			{#if !gone}
				<button
					type="button"
					class={ACTION}
					aria-label="Download {baseName}"
					title="Download {baseName}"
					disabled={downloading}
					onclick={downloadFile}
				>
					<CarbonDownload class="size-4 @[520px]:size-3.5" />
					<span class="hidden @[520px]:inline">Download</span>
				</button>
			{/if}
		</div>
	</div>
	{#if notSaved}
		<p
			class="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-amber-600 dark:text-amber-400"
			data-testid="file-not-saved"
		>
			{#if gone}
				<span>Not saved, and no longer available. Run the code again to recreate it.</span>
			{:else}
				<span>Not saved: download it while this tab is open.</span>
				{#if canRetry}
					<button
						type="button"
						class="inline-flex items-center gap-1 underline"
						disabled={retrying}
						onclick={retry}
					>
						<CarbonRenew class="size-3" />
						{retrying ? "Saving…" : "Retry saving"}
					</button>
				{/if}
				{#if retryFailed}<span>The save failed again.</span>{/if}
			{/if}
		</p>
	{/if}
	{#if showsImage}
		<div class="pt-3">
			<InlineRasterImage name={baseName} {load} />
		</div>
	{/if}
	{#if downloadError}
		<p class="pt-1 text-xs text-amber-600 dark:text-amber-400">{downloadError}</p>
	{/if}
</li>
