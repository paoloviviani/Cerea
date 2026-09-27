<script lang="ts">
	import type { Token } from "$lib/utils/markedLight";
	import CodeBlock from "../CodeBlock.svelte";

	interface Props {
		tokens: Token[];
		/** Whether the message these tokens belong to is currently generating. */
		loading?: boolean;
		/** Assistant-written blocks may auto-run (see CodeBlock). */
		autorun?: boolean;
	}

	let { tokens, loading = false, autorun = false }: Props = $props();

	// Derive rendered tokens for memoization
	const renderedTokens = $derived(tokens);
</script>

{#each renderedTokens as token}
	{#if token.type === "text"}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html token.html}
	{:else if token.type === "code"}
		<CodeBlock
			code={token.code}
			rawCode={token.rawCode}
			loading={loading && !token.isClosed}
			messageLoading={loading}
			language={token.lang}
			{autorun}
		/>
	{/if}
{/each}
