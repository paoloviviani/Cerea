<script lang="ts">
	/**
	 * A name that gives up its middle, never its end: `preview_Overview…pptx`
	 * keeps the extension readable where plain truncation (or a mid-word wrap)
	 * would cut it. The full name is the tooltip. Short names render whole.
	 */
	interface Props {
		text: string;
		class?: string;
		/** How many trailing characters stay visible; default is the extension plus two. */
		tail?: number;
	}

	let { text, class: className = "", tail }: Props = $props();

	// The head fills whatever width the row has (CSS truncation), so a name
	// that fits is never cut. What stays pinned is the extension plus two
	// characters before it, so as little as possible is given up to the tail.
	let keep = $derived(
		tail ?? (text.lastIndexOf(".") > 0 ? text.length - text.lastIndexOf(".") + 2 : 6)
	);
	let head = $derived(text.length > keep + 4 ? text.slice(0, text.length - keep) : text);
	let rest = $derived(text.length > keep + 4 ? text.slice(text.length - keep) : "");
</script>

<span class="flex min-w-0 {className}" title={text} data-testid="file-name">
	<span class="min-w-0 truncate">{head}</span>{#if rest}<span class="shrink-0 whitespace-pre"
			>{rest}</span
		>{/if}
</span>
