<script lang="ts">
	import { MessageToolUpdateType, type MessageToolUpdate } from "$lib/types/MessageUpdate";
	import {
		isMessageToolCallUpdate,
		isMessageToolErrorUpdate,
		isMessageToolProgressUpdate,
		isMessageToolResultUpdate,
	} from "$lib/utils/messageUpdates";
	import { formatToolProgressCount, formatToolProgressLines } from "$lib/utils/toolProgress";
	import { ToolResultStatus, type ToolFront } from "$lib/types/Tool";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import LucideTriangleAlert from "~icons/lucide/triangle-alert";
	import LucideWrench from "~icons/lucide/wrench";
	import BlockWrapper from "./BlockWrapper.svelte";
	import { coordinationCall, getCodeSessionLinks } from "$lib/utils/codeSessionLinks";
	import ImageLightbox from "./ImageLightbox.svelte";

	interface Props {
		tool: MessageToolUpdate[];
		loading?: boolean;
	}

	let { tool, loading = false }: Props = $props();

	let isOpen = $state(false);

	// Between-session tools of a coding-agent transcript (`session_spawn`,
	// `session_send`) read as what they did, with a link to the other session.
	// Only where an agent view provides the lookup; a refused call keeps the
	// plain card.
	const sessionLinks = getCodeSessionLinks();
	let coordination = $derived.by(() => {
		if (!sessionLinks) return null;
		const call = tool.find(isMessageToolCallUpdate);
		const result = tool.find(isMessageToolResultUpdate);
		const error = tool.find(isMessageToolErrorUpdate);
		const read = coordinationCall(
			call?.call.name,
			call?.call.parameters as Record<string, unknown> | undefined,
			error
				? { text: undefined, failed: true }
				: result
					? {
							text:
								result.result.status === ToolResultStatus.Success
									? result.result.outputs.map((out) => getOutputText(out) ?? "").join("")
									: undefined,
							failed: result.result.status !== ToolResultStatus.Success,
						}
					: undefined
		);
		if (!read || read.state === "refused") return null;
		const known = read.sessionId ? sessionLinks.title(read.sessionId) : undefined;
		const title = read.title ?? known ?? "another session";
		const label = read.kind === "send" ? "Sent to" : read.state === "done" ? "Spawned" : "Spawning";
		return {
			label: read.kind === "send" && read.state === "pending" ? "Sending to" : label,
			title,
			href: read.sessionId ? sessionLinks.href(read.sessionId) : undefined,
			autoApproved: read.autoApproved === true,
		};
	});

	let toolFnName = $derived(tool.find(isMessageToolCallUpdate)?.call.name);
	let toolError = $derived(tool.some(isMessageToolErrorUpdate));
	let toolDone = $derived(tool.some(isMessageToolResultUpdate));
	let isExecuting = $derived(!toolDone && !toolError && loading);
	let toolProgress = $derived.by(() => {
		for (let i = tool.length - 1; i >= 0; i -= 1) {
			const update = tool[i];
			if (isMessageToolProgressUpdate(update)) return update;
		}
		return undefined;
	});
	let progressCount = $derived.by(() => formatToolProgressCount(toolProgress));
	let progressLines = $derived.by(() => formatToolProgressLines(toolProgress));

	// A training run that syncs to Trackio prints its dashboard URL into the job
	// output, so the tool group that ran it is also the natural place to get back
	// to the dashboard after closing the pane.

	const availableTools: ToolFront[] = $derived.by(
		() => (page.data as { tools?: ToolFront[] } | undefined)?.tools ?? []
	);

	type ToolOutput = Record<string, unknown>;
	// An MCP tool's image arrives inline as base64 `data`; a coding-agent
	// machine's arrives as a `url` into the forwarder's attachment route
	// (PROTOCOL.md §7), so the stream never carries the bytes.
	type McpImageContent =
		| { type: "image"; data: string; mimeType: string; size?: number }
		| { type: "image"; url: string; mimeType: string; size?: number };

	const formatValue = (value: unknown): string => {
		if (value == null) return "";
		if (typeof value === "object") {
			try {
				return JSON.stringify(value, null, 2);
			} catch {
				return String(value);
			}
		}
		return String(value);
	};

	const getOutputText = (output: ToolOutput): string | undefined => {
		const maybeText = output["text"];
		if (typeof maybeText !== "string") return undefined;
		return maybeText;
	};

	// A `url` is loaded only if it is EXACTLY what toolImageUrl builds: the
	// forwarder's attachment route for one 64-hex image of a device. Any other
	// path — same-origin or not — is refused, because a tool result from a
	// remote MCP connector is also rendered here and must not be able to make
	// the browser send a cookie-bearing request to an endpoint of its choosing.
	const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const attachmentUrl = new RegExp(
		`^${escapedBase}/api/v2/code/v1/agents/[A-Za-z0-9_.~%-]+/attachments/[0-9a-f]{64}\\?device=[0-9a-f]{24}$`
	);
	const isAttachmentUrl = (url: string): boolean => attachmentUrl.test(url);

	const isImageBlock = (value: unknown): value is McpImageContent => {
		if (typeof value !== "object" || value === null) return false;
		const obj = value as Record<string, unknown>;
		if (obj["type"] !== "image" || typeof obj["mimeType"] !== "string") return false;
		if (typeof obj["data"] === "string") return true;
		return typeof obj["url"] === "string" && isAttachmentUrl(obj["url"]);
	};

	const imageSrc = (image: McpImageContent): string =>
		"url" in image ? image.url : `data:${image.mimeType};base64,${image.data}`;

	const getImageBlocks = (output: ToolOutput): McpImageContent[] => {
		const blocks = output["content"];
		if (!Array.isArray(blocks)) return [];
		return blocks.filter(isImageBlock);
	};

	/** The images this side or the machine left out of a result, as counted by
	 * the timeline mapping (`imagesNotShown`), for the strip's "+N" chip. */
	const getImagesNotShown = (output: ToolOutput): number => {
		const count = output["imagesNotShown"];
		return typeof count === "number" && count > 0 ? count : 0;
	};

	const getMetadataEntries = (output: ToolOutput): Array<[string, unknown]> => {
		return Object.entries(output).filter(
			([key, value]) =>
				value != null && key !== "content" && key !== "text" && key !== "imagesNotShown"
		);
	};

	interface ParsedToolOutput {
		text?: string;
		images: McpImageContent[];
		metadata: Array<[string, unknown]>;
	}

	const parseToolOutputs = (outputs: ToolOutput[]): ParsedToolOutput[] =>
		outputs.map((output) => ({
			text: getOutputText(output),
			images: getImageBlocks(output),
			metadata: getMetadataEntries(output),
		}));

	// ── The collapsed card's thumbnail strip ──────────────────────────────
	//
	// Images are the point of some calls (a screenshot, a plot), so a folded
	// card shows the first few on their own line under the header. The
	// signal is the images themselves, never the tool's name. The bytes are
	// the ones the expanded card shows — scaled by CSS, never resized on the
	// server — so a large image waits for a tap instead of costing mobile
	// data, and every box is sized before its image arrives so the
	// transcript does not jump as they load.
	const STRIP_MAX = 3;
	/** Past this many bytes an image is not fetched until asked for. */
	const STRIP_LOAD_GATE_BYTES = 2 * 1024 * 1024;

	const imageKey = (image: McpImageContent): string => ("url" in image ? image.url : image.data);
	const formatMegabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

	// One entry per distinct image across the whole card: a browser tool
	// repeats the same screenshot, and the machine addresses it by its hash.
	let stripImages = $derived.by(() => {
		const seen = new Set<string>();
		const images: McpImageContent[] = [];
		for (const update of tool) {
			if (!isMessageToolResultUpdate(update) || update.result.status !== ToolResultStatus.Success)
				continue;
			for (const parsed of parseToolOutputs(update.result.outputs)) {
				for (const image of parsed.images) {
					const key = imageKey(image);
					if (seen.has(key)) continue;
					seen.add(key);
					images.push(image);
				}
			}
		}
		return images;
	});
	let stripNotShown = $derived(
		tool.reduce(
			(total, update) =>
				isMessageToolResultUpdate(update) && update.result.status === ToolResultStatus.Success
					? total + update.result.outputs.reduce((sum, out) => sum + getImagesNotShown(out), 0)
					: total,
			0
		)
	);
	let stripMore = $derived(Math.max(0, stripImages.length - STRIP_MAX) + stripNotShown);
	let stripVisible = $derived(stripImages.slice(0, STRIP_MAX));
	let stripLoaded = $state<Set<string>>(new Set());
	let lightboxSrc = $state<string | null>(null);
</script>

{#if toolFnName}
	<BlockWrapper>
		<!-- Header row -->
		<div class="flex max-w-full flex-col items-start gap-1 select-none">
			<div class="flex max-w-full items-center gap-1">
				<button
					type="button"
					class="group/header flex max-w-full cursor-pointer items-center gap-1 text-left whitespace-nowrap focus:outline-hidden"
					onclick={() => (isOpen = !isOpen)}
					aria-label={isOpen ? "Collapse" : "Expand"}
				>
					<!-- Errors here are often recoverable (the model retries or works around
				     them), so the header stays in the same muted gray as every other
				     state; the amber icon is the only signal until the row is expanded. -->
					<!-- One leading glyph, which says either what the row is or what
				     happened to it: a wrench for an ordinary call, the amber
				     triangle when it failed. Not both — the text beside it already
				     reads "Error calling tool", so nothing is lost by the swap, and
				     a second icon in a row that also carries a label, a name and a
				     chevron is where this stops being scannable. -->
					{#if toolError}
						<LucideTriangleAlert class="size-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
					{:else}
						<LucideWrench
							class="size-3.5 shrink-0 text-gray-400 transition-colors group-hover/header:text-gray-600 dark:text-gray-500 dark:group-hover/header:text-gray-300"
						/>
					{/if}
					<span
						class="shrink-0 text-sm font-medium transition-colors group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {isOpen
							? 'text-gray-600 dark:text-gray-300'
							: 'text-gray-500 dark:text-gray-400'}"
						class:router-shimmer={isExecuting}
					>
						{#if coordination}{coordination.label}{:else}{toolError
								? "Error calling"
								: toolDone
									? "Called"
									: "Calling"} tool{/if}
					</span>
					{#if !coordination}
						<code
							class="min-w-0 truncate rounded-sm bg-blue-50 px-1 py-px font-mono text-xs text-blue-700 opacity-90 dark:bg-blue-900/30 dark:text-blue-300"
						>
							{availableTools.find((entry) => entry.name === toolFnName)?.displayName ?? toolFnName}
						</code>
					{/if}
					{#if isExecuting && progressCount}
						<span class="shrink-0 text-xs text-gray-500 tabular-nums dark:text-gray-400"
							>({progressCount})</span
						>
					{/if}
					{#if !coordination}
						<CarbonChevronRight
							class="size-3.5 shrink-0 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {isOpen
								? 'rotate-90 text-gray-600 dark:text-gray-300'
								: 'text-gray-400'}"
						/>
					{/if}
				</button>
				{#if coordination}
					{#if coordination.href}
						<a
							href={coordination.href}
							class="min-w-0 truncate rounded-sm bg-blue-50 px-1 py-px text-xs text-blue-700 underline-offset-2 hover:underline dark:bg-blue-900/30 dark:text-blue-300"
							data-testid="session-link">{coordination.title}</a
						>
					{:else}
						<span
							class="min-w-0 truncate rounded-sm bg-blue-50 px-1 py-px text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
							>{coordination.title}</span
						>
					{/if}
					{#if coordination.autoApproved}
						<span
							class="shrink-0 rounded-sm bg-gray-100 px-1 py-px text-xs text-gray-600 dark:bg-gray-700/50 dark:text-gray-300"
							title="Auto-accept was on, so no approval was asked for this"
							data-testid="auto-approved-badge">auto-approved</span
						>
					{/if}
					<button
						type="button"
						class="group/chevron shrink-0 cursor-pointer focus:outline-hidden"
						onclick={() => (isOpen = !isOpen)}
						aria-label={isOpen ? "Collapse" : "Expand"}
					>
						<CarbonChevronRight
							class="size-3.5 transition-all duration-200 group-hover/chevron:text-gray-600 dark:group-hover/chevron:text-gray-300 {isOpen
								? 'rotate-90 text-gray-600 dark:text-gray-300'
								: 'text-gray-400'}"
						/>
					</button>
				{/if}
			</div>
			{#if isExecuting && progressLines.length}
				<div class="flex min-w-0 flex-col gap-0.5">
					{#each progressLines as line (line)}
						<span class="truncate text-xs text-gray-500 dark:text-gray-400">{line}</span>
					{/each}
				</div>
			{/if}
		</div>

		{#if !isOpen && (stripImages.length > 0 || stripNotShown > 0)}
			<!-- Its own line under the header, which stays one line on a narrow
			     screen. Every box is size-12 whether or not its image has loaded
			     (or is waiting for a tap), so nothing moves when one does. -->
			<div class="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="tool-image-strip">
				{#each stripVisible as image, index (imageKey(image))}
					{@const key = imageKey(image)}
					{@const label = `Tool result image ${index + 1} of ${stripImages.length}`}
					{#if typeof image.size === "number" && image.size > STRIP_LOAD_GATE_BYTES && !stripLoaded.has(key)}
						<button
							type="button"
							class="flex h-12 items-center rounded-md border border-gray-200 bg-gray-50 px-2 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
							data-testid="tool-image-gated"
							aria-label={`Load image ${index + 1} of ${stripImages.length} (${formatMegabytes(image.size)})`}
							onclick={() => (stripLoaded = new Set(stripLoaded).add(key))}
						>
							image · {formatMegabytes(image.size)} — tap to load
						</button>
					{:else}
						<button
							type="button"
							class="size-12 shrink-0 overflow-hidden rounded-md border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800"
							aria-label={`View ${label.toLowerCase()}`}
							onclick={() => (lightboxSrc = imageSrc(image))}
						>
							<img
								alt={label}
								class="size-full object-cover"
								loading="lazy"
								decoding="async"
								src={imageSrc(image)}
							/>
						</button>
					{/if}
				{/each}
				{#if stripMore > 0}
					<button
						type="button"
						class="flex h-12 min-w-12 items-center justify-center rounded-md bg-gray-100 px-2 text-xs font-medium text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
						title={`${stripMore} more ${stripMore === 1 ? "image" : "images"}`}
						aria-label={`${stripMore} more ${stripMore === 1 ? "image" : "images"} — expand`}
						data-testid="tool-image-more"
						onclick={() => (isOpen = true)}
					>
						+{stripMore}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Expandable content -->
		{#if isOpen}
			<div class="mt-2 mb-4 space-y-3 text-gray-500 dark:text-gray-400">
				{#each tool as update, i (`${update.subtype}-${i}`)}
					{#if update.subtype === MessageToolUpdateType.Call}
						<div class="space-y-1">
							<div class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
								Input
							</div>
							<pre
								class="rounded-lg bg-gray-100 p-2 font-mono text-xs break-all whitespace-pre-wrap dark:bg-gray-800/70">{formatValue(
									update.call.parameters
								)}</pre>
						</div>
					{:else if update.subtype === MessageToolUpdateType.Error}
						<div class="space-y-1">
							<div class="text-[10px] font-semibold text-amber-600 uppercase dark:text-amber-400">
								Error
							</div>
							<pre
								class="rounded-lg bg-amber-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{update.message}</pre>
						</div>
					{:else if isMessageToolResultUpdate(update) && update.result.status === ToolResultStatus.Success && update.result.display}
						<div class="space-y-1">
							<div class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
								Output
							</div>
							{#each parseToolOutputs(update.result.outputs) as parsedOutput}
								<div class="space-y-2">
									{#if parsedOutput.text}
										<pre
											class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg bg-gray-100 p-2 font-mono text-xs break-all whitespace-pre-wrap dark:bg-gray-800/70">{parsedOutput.text}</pre>
									{/if}

									{#if parsedOutput.images.length > 0}
										<div class="flex flex-wrap gap-2">
											{#each parsedOutput.images as image, imageIndex}
												<img
													alt={`Tool result image ${imageIndex + 1}`}
													class="max-h-60 cursor-pointer rounded-sm border border-gray-200 dark:border-gray-700"
													src={imageSrc(image)}
												/>
											{/each}
										</div>
									{/if}

									{#if parsedOutput.metadata.length > 0}
										<pre
											class="rounded-lg bg-gray-100 p-2 font-mono text-xs break-all whitespace-pre-wrap dark:bg-gray-800/70">{formatValue(
												Object.fromEntries(parsedOutput.metadata)
											)}</pre>
									{/if}
								</div>
							{/each}
						</div>
					{:else if isMessageToolResultUpdate(update) && update.result.status === ToolResultStatus.Error && update.result.display}
						<div class="space-y-1">
							<div class="text-[10px] font-semibold text-amber-600 uppercase dark:text-amber-400">
								Error
							</div>
							<pre
								class="rounded-lg bg-amber-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{update
									.result.message}</pre>
						</div>
					{/if}
				{/each}
			</div>
		{/if}
	</BlockWrapper>
{/if}

{#if lightboxSrc}
	<ImageLightbox src={lightboxSrc} onclose={() => (lightboxSrc = null)} />
{/if}
