<script lang="ts">
	import { fallbackBlocks, findClosedFences, type BlockToken } from "$lib/utils/markedLight";
	import {
		acquireMarkdownClientId,
		cancelMarkdownClient,
		renderMarkdownBlocks,
	} from "$lib/utils/markdownWorkerPool";
	import MarkdownBlock from "./MarkdownBlock.svelte";
	import { browser } from "$app/environment";
	import { getRunsStore } from "$lib/utils/execution/runs.svelte";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import { getMessageRunContext } from "$lib/utils/execution/messageContext";

	import { onDestroy } from "svelte";
	import { updateDebouncer } from "$lib/utils/updates";

	interface Props {
		content: string;
		sources?: { title?: string; link: string }[];
		loading?: boolean;
		/** Assistant-written blocks may auto-run in the execution sandbox. */
		autorun?: boolean;
	}

	let { content, sources = [], loading = false, autorun = false }: Props = $props();

	// Lightweight blocks used for SSR and the initial client render. Full markdown
	// rendering is deferred to the shared worker pool (or async processBlocks fallback)
	// on the client, so the heavy synchronous pipeline never runs on the server event
	// loop. See fallbackBlocks.
	let fallback = $derived(fallbackBlocks(content));
	let workerBlocks: BlockToken[] | null = $state(null);
	let blocks = $derived(workerBlocks ?? fallback);

	// Stable id so the pool can coalesce this instance's successive (streaming) renders.
	const clientId = acquireMarkdownClientId();
	let latestRequestId = 0;

	function handleBlocks(result: BlockToken[], requestId: number) {
		if (requestId !== latestRequestId) return;
		workerBlocks = result;
		updateDebouncer.endRender();
	}

	const runsStore = getRunsStore();
	const messageRun = getMessageRunContext();

	// Mark every closed fence in `content` as "seen live" right here, in the
	// same effect (so the same reactive tick) that captures `loading` for
	// this content — not in `handleBlocks`, which only fires once the async
	// pipeline above has actually tokenized it. See `findClosedFences` for
	// why that gap matters.
	function markLiveFences(): void {
		if (!loading || !runsStore) return;
		const conversationId = messageRun?.conversationId ?? "";
		for (const fence of findClosedFences(content)) {
			runsStore.markSeenStreaming(`${conversationId}|${chatRunKey(fence.rawCode)}`);
		}
	}

	$effect(() => {
		if (!browser) return;
		updateDebouncer.startRender();
		markLiveFences();
		latestRequestId = renderMarkdownBlocks(clientId, content, sources, loading, handleBlocks);
	});

	onDestroy(() => {
		cancelMarkdownClient(clientId);
	});
</script>

{#each blocks as block, index (loading && index === blocks.length - 1 ? `stream-${index}` : block.id)}
	<MarkdownBlock tokens={block.tokens} {loading} {autorun} />
{/each}
