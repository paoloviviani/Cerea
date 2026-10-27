<!--
	What a connector card says about its tools, in the same words on every card
	(Workspace and Admin): how many there are, that they have not been listed
	yet, or that listing them failed (the reason is the card's own error line).
	Never a bare "Connected" with nothing about the tools.

	`list` shows the names instead, as an expandable "Available tools".
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import LucideHammer from "~icons/lucide/hammer";
	import type { McpConnectorView } from "$lib/types/McpConnector";

	interface Props {
		connector: Pick<McpConnectorView, "tools" | "checkedAt" | "lastError">;
		/** Show the tool names (an expandable list) rather than the one-line status. */
		list?: boolean;
	}

	let { connector, list = false }: Props = $props();

	const count = $derived(connector.tools?.length ?? 0);
</script>

{#if list}
	{#if connector.tools && count > 0}
		<details class="mt-3" data-testid="tools-list">
			<summary class="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
				{m["mcp.card.available_tools"]({ count })}
			</summary>
			<ul class="mt-2 space-y-1 text-xs wrap-break-word">
				{#each connector.tools as tool (tool.name)}
					<li class="text-gray-600 dark:text-gray-400">
						<span class="font-medium text-gray-900 dark:text-gray-100">{tool.name}</span>
						{#if tool.description}
							<span class="line-clamp-2 text-gray-500">- {tool.description}</span>
						{/if}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
{:else}
	<span
		data-testid="tools-status"
		class="inline-flex items-center gap-1 text-xs {connector.lastError && count === 0
			? 'text-red-700 dark:text-red-300'
			: 'text-gray-600 dark:text-gray-400'}"
	>
		<LucideHammer class="size-3" />
		{#if count > 0}
			{m["mcp.card.tools_count"]({ count })}
		{:else if connector.lastError}
			{m["mcp.card.tools_failed"]()}
		{:else if connector.checkedAt}
			{m["mcp.card.tools_none"]()}
		{:else}
			{m["mcp.card.tools_not_checked"]()}
		{/if}
	</span>
{/if}
