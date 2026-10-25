<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import ConnectorsSection from "./ConnectorsSection.svelte";
	import { allMcpServers, refreshMcpServers, healthCheckServer } from "$lib/stores/mcpServers";
	import { connectors, totalDefaultMcpCount } from "$lib/stores/mcpConnectors";
	import IconRefresh from "~icons/carbon/renew";
	import IconMCP from "$lib/components/icons/IconMCP.svelte";
	import * as s from "$lib/components/overlay/styles";

	const publicConfig = usePublicConfig();

	let isRefreshing = $state(false);

	// Defaults, not the active chat: this tab edits what new chats start with.
	const enabledCount = $derived($totalDefaultMcpCount);
	const onMachines = $derived($connectors.filter((c) => c.local));
	const onMachinesReady = $derived(onMachines.filter((c) => c.local?.state === "ready").length);
	const serverCount = $derived($allMcpServers.length + onMachines.length);

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

<!-- The workspace tab's card, where the overlay shell used to be. -->
<div class={s.EMBEDDED}>
	<div class="p-6">
		<!-- Header -->
		<div class="mb-6">
			<h2 class="mb-1 text-xl font-semibold text-gray-900 dark:text-gray-200">
				{m["mcp.manager.title"]()}
			</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				{m["mcp.manager.intro"]({ name: publicConfig.PUBLIC_APP_NAME })}
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
						{m["mcp.manager.set_up"]({ count: serverCount })}
					</p>
					<p class="text-xs text-gray-600 dark:text-gray-400">
						{onMachines.length
							? m["mcp.manager.enabled_machines"]({
									count: enabledCount,
									ready: onMachinesReady,
									total: onMachines.length,
								})
							: m["mcp.manager.enabled"]({ count: enabledCount })}
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
					{isRefreshing ? m["mcp.manager.refreshing"]() : m["mcp.manager.refresh"]()}
				</button>
			</div>
		</div>
		<div class="space-y-5">
			<!-- Connectors: remote servers with OAuth or a server-side token
			     (ADR 0064). The way a person brings their own server — the
			     user-added custom-server form this dialog used to carry is gone,
			     because a second credential path beside connectors was the
			     redundancy. The deployment's own servers (the `.env` base list and
			     the administrator's connectors) sit in one group inside it. -->
			<ConnectorsSection />

			<!-- Help Text -->
			<div class="rounded-lg bg-gray-50 p-4 dark:bg-gray-700">
				<h4 class="mb-2 text-sm font-medium text-gray-900 dark:text-gray-100">
					{m["mcp.manager.tips_heading"]()}
				</h4>
				<ul class="space-y-1 text-xs text-gray-600 dark:text-gray-400">
					<li>{m["mcp.manager.tip_trust"]()}</li>
					<li>{m["mcp.manager.tip_enable"]()}</li>
					<li>{m["mcp.manager.tip_check"]()}</li>
				</ul>
			</div>
		</div>
	</div>
</div>
