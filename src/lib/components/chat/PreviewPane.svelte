<script lang="ts">
	import { browser } from "$app/environment";
	import { onMount, onDestroy } from "svelte";
	import CarbonClose from "~icons/carbon/close";
	import SidePane from "./SidePane.svelte";
	import ExternalLinkModal from "../ExternalLinkModal.svelte";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import {
		buildArtifactSrcdoc,
		capturePreviewError,
		composeFixRequest,
		normalizePreviewError,
		PREVIEW_ALLOW,
		PREVIEW_SANDBOX,
		type CapturedPreviewError,
	} from "$lib/utils/previewSrcdoc";
	import { parseExternalUrl } from "$lib/utils/externalLink";

	/**
	 * One-shot rendered view of a single fence or file, opened from a Preview
	 * button in the chat. Unlike artifacts this carries no registry entry, no
	 * versions and no persistence: the content lives in the message, the store
	 * only holds what is showing. The iframe runs the same sandboxed builders
	 * as every other preview, so the security posture is identical — only the
	 * surface moved, from the fullscreen modal to this pane.
	 */
	interface Props {
		/**
		 * Sends an ask-to-fix message directly to the chat, returning whether it
		 * was dispatched. Absent when sending isn't possible, which hides the
		 * error button.
		 */
		onsend?: (text: string) => boolean;
	}

	let { onsend }: Props = $props();

	let iframeEl: HTMLIFrameElement | undefined = $state();
	let channel = $state(`preview_${Math.random().toString(36).slice(2)}`);
	let errors: CapturedPreviewError[] = $state([]);
	let externalLinkUrl = $state<URL | null>(null);

	// A new payload means a new document: fresh channel (so a stale error
	// can't accuse the new content) and a cleared error list.
	let lastPayload: unknown = undefined;
	const payload = $derived(sidePane.preview);
	$effect(() => {
		if (payload !== lastPayload) {
			lastPayload = payload;
			channel = `preview_${Math.random().toString(36).slice(2)}`;
			errors = [];
			externalLinkUrl = null;
		}
	});

	let srcdoc = $derived(
		payload && payload.kind !== "pdf"
			? buildArtifactSrcdoc(payload.kind, payload.content, channel)
			: ""
	);

	type PreviewMessage = {
		type: string;
		channel: string;
		detail?: { message?: unknown; stack?: unknown; href?: unknown };
	};

	function onMessage(ev: MessageEvent) {
		if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
		const raw = ev.data as unknown;
		if (!raw || typeof raw !== "object") return;
		const data = raw as Partial<PreviewMessage>;
		if (data.channel !== channel) return;
		if (data.type === "chatui.preview.openLink") {
			// Only honor link messages backed by a real user gesture (clicks inside
			// the iframe propagate activation to ancestor frames); generated code
			// must not be able to pop the confirm without one.
			if (navigator.userActivation && !navigator.userActivation.isActive) return;
			// The iframe runs untrusted generated code, so re-validate its href here
			// rather than trusting what it claims.
			externalLinkUrl = parseExternalUrl(data.detail?.href) ?? null;
			return;
		}
		if (data.type !== "chatui.preview.error") return;
		errors = capturePreviewError(errors, normalizePreviewError(data.detail));
	}

	onMount(() => {
		window.addEventListener("message", onMessage);
	});
	onDestroy(() => {
		// onDestroy (unlike onMount) also runs after server rendering, where
		// there is no window to unsubscribe from — the listener above is only
		// ever attached client-side.
		if (!browser) return;
		window.removeEventListener("message", onMessage);
	});
</script>

{#if sidePane.open && sidePane.view === "preview" && payload}
	<SidePane label="Preview">
		{#snippet children(resizing)}
			<div class="flex h-full flex-col">
				<div
					class="flex shrink-0 items-center gap-2 border-b border-gray-200/70 px-4 py-2 dark:border-gray-700/70"
				>
					<span
						class="min-w-0 flex-1 truncate font-mono text-xs text-gray-600 dark:text-gray-300"
						title={payload.title}
					>
						{payload.title}
					</span>
					<button
						class="btn flex size-7 shrink-0 items-center justify-center rounded-lg border text-sm shadow-xs transition-none hover:border-gray-500 active:shadow-inner dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
						title="Close preview"
						aria-label="Close preview pane"
						onclick={() => sidePane.close()}
					>
						<CarbonClose class="size-3.5" />
					</button>
				</div>
				<div class="relative min-h-0 flex-1">
					{#if payload.kind === "pdf"}
						<!-- A document the browser renders natively: the payload
						     content IS the data: URL, framed directly instead of
						     through a srcdoc builder (there is no HTML to build). -->
						<iframe
							title={`Preview of ${payload.title}`}
							class="h-full w-full bg-white dark:bg-gray-900 {resizing
								? 'pointer-events-none'
								: ''}"
							sandbox={PREVIEW_SANDBOX}
							allow={PREVIEW_ALLOW}
							allowfullscreen
							referrerpolicy="no-referrer"
							src={payload.content}
						></iframe>
					{:else}
						<iframe
							bind:this={iframeEl}
							title={`Preview of ${payload.title}`}
							class="h-full w-full bg-white dark:bg-gray-900 {resizing
								? 'pointer-events-none'
								: ''}"
							sandbox={PREVIEW_SANDBOX}
							allow={PREVIEW_ALLOW}
							allowfullscreen
							referrerpolicy="no-referrer"
							{srcdoc}
						></iframe>
					{/if}
					{#if errors.length > 0 && onsend}
						<button
							class="absolute right-4 bottom-4 z-10 btn flex items-center gap-2 rounded-full border-2 border-red-500/60 bg-red-800/90 px-4 py-1.5 text-sm text-white shadow-lg"
							title="Send the errors and ask for a fix"
							onclick={() => {
								// Close only once the message is actually on its way, so the
								// preview (and the errors backing the request) stays up otherwise
								if (onsend?.(composeFixRequest(errors))) sidePane.close();
							}}
						>
							<span>Error caught ({errors.length}) — ask to fix</span>
						</button>
					{/if}
				</div>
			</div>
		{/snippet}
	</SidePane>
{/if}

{#if externalLinkUrl}
	<ExternalLinkModal url={externalLinkUrl} onclose={() => (externalLinkUrl = null)} />
{/if}
