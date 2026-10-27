<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import type { MCPServer } from "$lib/types/Tool";
	import { healthCheckServer } from "$lib/stores/mcpServers";
	import { setConnectorEnabled } from "$lib/stores/mcpConnectors";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconPending from "~icons/carbon/pending-filled";
	import IconRefresh from "~icons/carbon/renew";
	import LucideHammer from "~icons/lucide/hammer";
	import IconSettings from "~icons/carbon/settings";
	import Switch from "$lib/components/Switch.svelte";
	import * as s from "$lib/components/overlay/styles";
	import type { PillTone } from "$lib/components/overlay/styles";
	import ServerCardFrame from "./ServerCardFrame.svelte";
	import { getMcpServerFaviconUrl } from "$lib/utils/favicon";

	interface Props {
		server: MCPServer;
		/** Marks a server the deployment's `.env` defines (shown to administrators). */
		fromEnv?: boolean;
	}

	let { server, fromEnv = false }: Props = $props();

	const locked = $derived(server.mode === "locked");
	const isOn = $derived(server.enabled !== false);
	let switchError = $state<string | null>(null);

	let isLoadingHealth = $state(false);

	// Show a quick-access link ONLY for the exact HF MCP login endpoint
	import { isStrictHfMcpLogin as isStrictHfMcpLoginUrl } from "$lib/utils/hf";
	const isHfMcp = $derived.by(() => isStrictHfMcpLoginUrl(server.url));

	const statusInfo = $derived.by(() => {
		switch (server.status) {
			case "connected":
				return {
					label: m["mcp.card.status.connected"](),
					tone: "good" as PillTone,
					icon: IconCheckmark,
				};
			case "connecting":
				return {
					label: m["mcp.card.status.connecting"](),
					tone: "busy" as PillTone,
					icon: IconPending,
				};
			case "error":
				return {
					label: m["mcp.card.status.problem"](),
					tone: "bad" as PillTone,
					icon: IconWarning,
				};
			case "disconnected":
			default:
				return {
					label: m["mcp.card.status.not_checked"](),
					tone: "neutral" as PillTone,
					icon: IconPending,
				};
		}
	});

	// Switch setter: the server keeps the choice (ADR 0104); shown at once, put back if refused.
	function setEnabled(v: boolean) {
		if (v === isOn || !server.key) return;
		switchError = null;
		setConnectorEnabled(server.key, v).catch((err: unknown) => {
			switchError = err instanceof Error ? err.message : m["mcp.connectors.switch_failed"]();
		});
	}

	async function handleHealthCheck() {
		isLoadingHealth = true;
		try {
			await healthCheckServer(server);
		} finally {
			isLoadingHealth = false;
		}
	}
</script>

{#snippet statusPills()}
	{#if fromEnv}
		<span
			data-testid="from-env"
			title={m["mcp.card.from_env_title"]()}
			class="{s.PILL} {s.PILL_TONES.neutral}"
		>
			{m["mcp.card.from_env"]()}
		</span>
	{/if}
	{#if server.status}
		<span class="{s.PILL} {s.PILL_TONES[statusInfo.tone]}">
			{#if server.status === "connected"}
				<IconCheckmark class="size-3" />
			{:else if server.status === "connecting"}
				<IconPending class="size-3" />
			{:else if server.status === "error"}
				<IconWarning class="size-3" />
			{:else}
				<IconPending class="size-3" />
			{/if}
			{statusInfo.label}
		</span>
	{/if}

	{#if server.tools && server.tools.length > 0}
		<span class="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
			<LucideHammer class="size-3" />
			{m["mcp.card.tools_count"]({ count: server.tools.length })}
		</span>
	{/if}
{/snippet}

{#snippet enableSwitch()}
	<!-- Enable Switch (function binding per Svelte 5 docs) -->
	<Switch name={`enable-${server.id}`} bind:checked={() => isOn, setEnabled} />
{/snippet}

<ServerCardFrame
	pills={server.status || fromEnv ? statusPills : undefined}
	name={server.name}
	iconSrc={getMcpServerFaviconUrl(server.url)}
	description={server.url}
	toggleLabel={m["mcp.card.toggle_label"]()}
	toggleLabelShort={m["mcp.card.toggle_label_short"]()}
	toggle={locked ? undefined : enableSwitch}
	fixedLabel={locked ? m["mcp.card.locked"]() : undefined}
	toggleTitle={locked ? m["mcp.card.locked_title"]() : undefined}
>
	{#if switchError}
		<p class="mb-2 text-xs text-red-700 dark:text-red-300">{switchError}</p>
	{/if}

	<!-- Error Message -->
	{#if server.errorMessage}
		<div class="mb-2 flex items-center gap-2">
			<div
				class="line-clamp-6 rounded-sm bg-red-50 px-2 py-1 text-xs wrap-break-word text-red-800 dark:bg-red-900/20 dark:text-red-200"
			>
				{server.errorMessage}
			</div>
		</div>
	{/if}

	<!-- Actions -->
	<div class="flex flex-wrap gap-1">
		<button
			onclick={handleHealthCheck}
			disabled={isLoadingHealth}
			class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
		>
			<IconRefresh class="size-3 {isLoadingHealth ? 'animate-spin' : ''}" />
			{m["mcp.card.check"]()}
		</button>

		{#if isHfMcp}
			<a
				href="https://huggingface.co/settings/mcp"
				target="_blank"
				rel="noopener noreferrer"
				class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
				aria-label={m["mcp.card.hf_settings_label"]()}
			>
				<IconSettings class="size-3" />
				{m["mcp.card.settings"]()}
			</a>
		{/if}
	</div>

	<!-- Tools List (Expandable) -->
	{#if server.tools && server.tools.length > 0}
		<details class="mt-3">
			<summary class="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
				{m["mcp.card.available_tools"]({ count: server.tools.length })}
			</summary>
			<ul class="mt-2 space-y-1 text-xs wrap-break-word">
				{#each server.tools as tool}
					<li class="text-gray-600 dark:text-gray-400">
						<span class="font-medium text-gray-900 dark:text-gray-100">{tool.name}</span>
						{#if tool.description}
							<span class="text-gray-500 dark:text-gray-500">- {tool.description}</span>
						{/if}
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</ServerCardFrame>
