<script lang="ts">
	import { m } from "$lib/paraglide/messages";

	interface Props {
		/** What was typed: scopes separated by spaces or new lines. */
		value: string;
		disabled?: boolean;
	}

	let { value = $bindable(), disabled = false }: Props = $props();
</script>

<label class="flex flex-1 flex-col gap-1">
	<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
		>{m["mcp.connectors.scopes"]()}
		<span class="font-normal text-gray-500">{m["mcp.connectors.scopes_optional"]()}</span></span
	>
	<textarea
		rows="3"
		autocomplete="off"
		spellcheck="false"
		maxlength="4000"
		class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
		bind:value
		{disabled}
	></textarea>
	<span class="text-xs text-gray-500 dark:text-gray-400">{m["mcp.connectors.scopes_hint"]()}</span>
</label>
