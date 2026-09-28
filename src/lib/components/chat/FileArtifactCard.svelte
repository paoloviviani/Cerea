<script lang="ts">
	import { getArtifactsContext } from "$lib/utils/artifactsContext";
	import { findFileVersionBySha } from "$lib/utils/fileArtifacts";
	import { fileKindLabel, formatFileSize, isInlineRasterImage } from "$lib/utils/filePreview";
	import FileCard, { readFileBytes, triggerBrowserDownload } from "./FileCard.svelte";
	import InlineRasterImage from "./InlineRasterImage.svelte";

	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonLaunch from "~icons/carbon/launch";

	/**
	 * One produced file presented as an artifact: the same card the text
	 * artifacts get, wherever a run's file renders inline (RunOutput, the
	 * `execute_code` card's file box).
	 *
	 * The join to the file-artifact registry is BY SHA256, never by filename —
	 * a filename-only match could resolve to a stale or wrong version. The
	 * sha travels with the persisted file references; while it is unresolved
	 * (no registry entry yet — a live run's file before its upload is
	 * recorded) the plain FileCard stands in, so nothing is invented and the
	 * download keeps working.
	 *
	 * "Open in panel" opens the exact version the sha resolves to, following
	 * the latest only when this IS the latest — the same rule
	 * DeliverablesPanel's artifactTarget applies. `inPanel` drops that action
	 * for cards rendered inside the artifact panel itself, which must not
	 * navigate away from the cell being edited.
	 */
	interface Props {
		file: { path: string; size: number };
		/** sha256 of these exact bytes, when the surrounding code knows it. */
		sha256?: string;
		/** Direct-emission mode, forwarded to the fallback FileCard. */
		inlineContent?: string;
		/** Persisted-deliverable mode, forwarded to the fallback FileCard. */
		downloadUrl?: string;
		/** Rendered inside the artifact panel: omit the "Open in panel" action. */
		inPanel?: boolean;
		/**
		 * Show a raster image under the card header without waiting for a
		 * click (the chat figure capture). Forwarded to the fallback FileCard
		 * for unresolved files; a resolved raster artifact renders its bytes
		 * the same way. Raster png/jpeg/gif/webp only — every other type,
		 * SVG included, ignores the flag.
		 */
		autoExpand?: boolean;
	}

	let {
		file,
		sha256,
		inlineContent,
		downloadUrl,
		inPanel = false,
		autoExpand = false,
	}: Props = $props();

	const ctx = getArtifactsContext();

	let name = $derived(file.path.split("/").pop() || "download");

	/**
	 * The registry entry these bytes are, or undefined while they are not in
	 * the registry yet (and then the plain FileCard renders instead).
	 */
	let resolved = $derived.by(() => {
		if (!ctx || !sha256) return undefined;
		const found = findFileVersionBySha(ctx.fileRegistry, sha256);
		if (!found) return undefined;
		const artifact = ctx.fileRegistry.artifacts.get(found.name);
		const version = artifact?.versions[found.version - 1];
		if (!artifact || !version) return undefined;
		return {
			name: found.name,
			version: found.version,
			total: artifact.versions.length,
			size: version.size,
		};
	});

	let kindLabel = $derived(fileKindLabel(resolved?.name ?? name));
	let versionLabel = $derived(resolved && resolved.total > 1 ? ` · v${resolved.version}` : "");
	let size = $derived(resolved ? resolved.size : file.size);

	// Highlight only the card whose version the panel is currently displaying
	let isActive = $derived.by(() => {
		if (!ctx || !resolved) return false;
		if (!ctx.panel.open || ctx.panel.identifier !== resolved.name) return false;
		const displayed = Math.min(ctx.panel.version ?? resolved.total, resolved.total);
		return displayed === resolved.version;
	});

	function openInPanel(): void {
		if (!resolved) return;
		// Follow the latest version when this card points at it, so a re-run's
		// new version keeps flowing into the panel; otherwise pin the version.
		ctx?.panel.openArtifact(
			resolved.name,
			resolved.version >= resolved.total ? null : resolved.version
		);
	}

	let downloading = $state(false);
	let downloadError = $state<string | null>(null);

	/**
	 * The resolved card's own image: a registry-matched raster file shows its
	 * bytes under the header, so a figure still renders as an image after a
	 * reload (when only the persisted references survive). The bytes come from
	 * the sha-keyed store URL, so they are the exact version this card names.
	 * Without a byte source there is nothing to show and the header renders
	 * alone as before.
	 */
	const showsResolvedImage = $derived(
		autoExpand &&
			resolved !== undefined &&
			isInlineRasterImage(resolved.name) &&
			(downloadUrl !== undefined || inlineContent !== undefined)
	);

	async function downloadFile(): Promise<void> {
		downloading = true;
		downloadError = null;
		try {
			const data = await readFileBytes({ file, inlineContent, downloadUrl });
			triggerBrowserDownload(name, data);
		} catch (err) {
			downloadError = err instanceof Error ? err.message : "the download failed";
		} finally {
			downloading = false;
		}
	}
</script>

{#if !resolved}
	<!-- Unresolved sha: the file may not be an artifact yet at all — show the
	     plain card, exactly as before. -->
	<FileCard {file} {inlineContent} {downloadUrl} {autoExpand} />
{:else}
	<li class="list-none">
		<div
			data-exclude-from-copy
			class="w-full max-w-md rounded-xl border bg-white text-left shadow-xs
				{isActive
				? 'border-blue-300 ring-1 ring-blue-300 dark:border-blue-500/30 dark:ring-blue-500/30'
				: 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'}
				dark:bg-gray-800/80"
		>
			<div class="flex items-center gap-3 py-3 pr-3 pl-3.5">
				<div
					class="flex size-9 flex-none items-center justify-center rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700/70 dark:text-gray-300"
				>
					<CarbonDocument class="text-base" />
				</div>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">
						{resolved.name}
					</p>
					<p class="truncate text-xs text-gray-500 dark:text-gray-400">
						{kindLabel} · {formatFileSize(size)}{versionLabel}
					</p>
				</div>
				<div class="flex flex-none items-center gap-1">
					{#if !inPanel}
						<button
							type="button"
							class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/10"
							aria-label="Open {resolved.name} in panel"
							title="Open {resolved.name} in panel"
							onclick={openInPanel}
						>
							<CarbonLaunch class="size-3.5" /> Open
						</button>
					{/if}
					<button
						type="button"
						class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:text-blue-400 dark:hover:bg-blue-500/10"
						aria-label="Download {resolved.name}"
						title="Download {resolved.name}"
						disabled={downloading}
						onclick={downloadFile}
					>
						<CarbonDownload class="size-3.5" /> Download
					</button>
				</div>
			</div>
			{#if showsResolvedImage}
				<div class="px-3 pb-3">
					<InlineRasterImage
						name={resolved.name}
						load={() => readFileBytes({ file, inlineContent, downloadUrl })}
					/>
				</div>
			{/if}
		</div>
		{#if downloadError}
			<p class="pt-1 text-xs text-amber-600 dark:text-amber-400">{downloadError}</p>
		{/if}
	</li>
{/if}
