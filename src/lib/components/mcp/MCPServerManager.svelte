<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import Modal from "$lib/components/Modal.svelte";
	import ServerCard from "./ServerCard.svelte";
	import ConnectorsSection from "./ConnectorsSection.svelte";
	import {
		allMcpServers,
		selectedServerIds,
		refreshMcpServers,
		healthCheckServer,
	} from "$lib/stores/mcpServers";
	import { totalEnabledMcpCount } from "$lib/stores/mcpConnectors";
	import IconRefresh from "~icons/carbon/renew";
	import IconMCP from "$lib/components/icons/IconMCP.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	let isRefreshing = $state(false);

	const baseServers = $derived($allMcpServers.filter((s) => s.type === "base"));
	const enabledCount = $derived($totalEnabledMcpCount);

	async function handleRefresh() {
		if (isRefreshing) return;
		isRefreshing = true;
		try {
			await refreshMcpServers();
			// After refreshing the list, re-run health checks for all known servers
			const servers = $allMcpServers;
			await Promise.allSettled(servers.map((s) => healthCheckServer(s)));
		} finally {
			isRefreshing = false;
		}
	}
</script>

<Modal width="w-[800px]" {onclose} closeButton>
	<div class="p-6">
		<!-- Header -->
		<div class="mb-6">
			<h2 class="mb-1 text-xl font-semibold text-gray-900 dark:text-gray-200">MCP Servers</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				Manage MCP servers to extend {publicConfig.PUBLIC_APP_NAME} with external tools.
			</p>
		</div>

		<!-- Content -->
		<div
			class="mb-6 flex justify-between rounded-lg p-4 max-sm:flex-col max-sm:gap-4 sm:items-center {!enabledCount
				? 'bg-gray-100 dark:bg-white/5'
				: 'bg-blue-50 dark:bg-blue-900/10'}"
		>
			<div class="flex items-center gap-3">
				<div
					class="flex size-10 items-center justify-center rounded-xl bg-blue-500/10"
					class:grayscale={!enabledCount}
				>
					<IconMCP classNames="size-8 text-blue-600 dark:text-blue-500" />
				</div>
				<div>
					<p class="text-sm font-semibold text-gray-900 dark:text-gray-100">
						{$allMcpServers.length}
						{$allMcpServers.length === 1 ? "server" : "servers"} configured
					</p>
					<p class="text-xs text-gray-600 dark:text-gray-400">
						{enabledCount} enabled
					</p>
				</div>
			</div>

			<div class="flex gap-2">
				<button
					onclick={handleRefresh}
					disabled={isRefreshing}
					class="btn gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
				>
					<IconRefresh class="size-4 {isRefreshing ? 'animate-spin' : ''}" />
					{isRefreshing ? "Refreshing…" : "Refresh"}
				</button>
			</div>
		</div>
		<div class="space-y-5">
			<!-- Connectors: remote servers with OAuth or a server-side token
			     (ADR 0064). The way a person brings their own server — the
			     user-added custom-server form this dialog used to carry is gone,
			     because a second credential path beside connectors was the
			     redundancy, and the deployment-configured base list below is not
			     the user's to extend. -->
			<ConnectorsSection />

			<!-- Base Servers -->
			{#if baseServers.length > 0}
				<div>
					<h3 class="mb-3 text-sm font-medium text-gray-700 dark:text-gray-300">
						Base Servers ({baseServers.length})
					</h3>
					<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
						{#each baseServers as server (server.id)}
							<ServerCard {server} isSelected={$selectedServerIds.has(server.id)} />
						{/each}
					</div>
				</div>
			{/if}

			<!-- Help Text -->
			<div class="rounded-lg bg-gray-50 p-4 dark:bg-gray-700">
				<h4 class="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">💡 Quick Tips</h4>
				<ul class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
					<li>• Only connect to servers you trust</li>
					<li>• Enable servers to make their tools available in chat</li>
					<li>• Use the Health Check button to verify server connectivity</li>
				</ul>
			</div>
		</div>
	</div>
</Modal>
