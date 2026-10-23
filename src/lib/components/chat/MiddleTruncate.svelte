<script lang="ts">
	/**
	 * A name that gives up its middle, never its end: `preview_Overview…pptx`
	 * keeps the extension readable where plain truncation (or a mid-word wrap)
	 * would cut it. The full name is the tooltip. Short names render whole.
	 */
	interface Props {
		text: string;
		class?: string;
		/** How many trailing characters stay visible. */
		tail?: number;
	}

	let { text, class: className = "", tail = 9 }: Props = $props();

	let head = $derived(text.length > tail + 4 ? text.slice(0, text.length - tail) : text);
	let rest = $derived(text.length > tail + 4 ? text.slice(text.length - tail) : "");
</script>

<span class="flex min-w-0 {className}" title={text} data-testid="file-name">
	<span class="min-w-0 truncate">{head}</span>{#if rest}<span class="shrink-0 whitespace-pre"
			>{rest}</span
		>{/if}
</span>
