<!--
	One connector in full: what a card has no room for. The complete name and
	description, the machine for a local server, its state and the detail behind
	it, the transport, the machine's `allowedTools` when it sets one, and the
	tool names.

	Tools come from where each kind keeps them. A local server is listed through
	`GET /api/v2/local-connectors/tools` (the chat's own cached listing, owner
	checked on the server); a remote connector shows what its last check found,
	which the connector view already carries. Neither is fetched for a server
	that is not reachable: the sheet says why instead.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import { listLocalServerTools } from "$lib/localConnectorsApi";
	import type { McpConnectorView } from "$lib/types/McpConnector";
	import CarbonClose from "~icons/carbon/close";

	interface Props {
		connector: McpConnectorView;
		onclose: () => void;
	}

	let { connector, onclose }: Props = $props();

	const local = $derived(connector.local);
	const title = $derived(local ? local.server : connector.name);
	const titleId = `connector-detail-${Math.random().toString(36).slice(2, 8)}`;

	const STATES = {
		get ready() {
			return m["mcp.detail.state.ready"]();
		},
		get offline() {
			return m["mcp.detail.state.offline"]();
		},
		get "needs-login"() {
			return m["mcp.detail.state.needs_login"]();
		},
		get disabled() {
			return m["mcp.detail.state.disabled"]();
		},
		get invalid() {
			return m["mcp.detail.state.invalid"]();
		},
	};

	const stateLabel = $derived(
		local
			? STATES[local.state]
			: connector.connected
				? connector.auth === "none"
					? m["mcp.detail.state.ready_no_auth"]()
					: m["mcp.detail.state.connected"]()
				: m["mcp.detail.state.not_signed_in"]()
	);
	const stateDetail = $derived(local ? local.detail : connector.lastError);
	const transport = $derived(local ? local.transport : "http");
	const description = $derived(local ? local.description : undefined);

	type Listing =
		| { kind: "idle" }
		| { kind: "loading" }
		| { kind: "tools"; tools: { name: string; description?: string }[] }
		| { kind: "error"; reason: string };
	let listing = $state<Listing>({ kind: "idle" });

	onMount(() => {
		if (!local) {
			listing = connector.tools ? { kind: "tools", tools: connector.tools } : { kind: "idle" };
			return;
		}
		if (local.state !== "ready" || !connector.connected) return;
		listing = { kind: "loading" };
		let live = true;
		listLocalServerTools(connector.id).then(
			(answer) => {
				if (!live) return;
				listing = answer.error
					? { kind: "error", reason: answer.error }
					: { kind: "tools", tools: answer.tools ?? [] };
			},
			(err) => {
				if (live)
					listing = { kind: "error", reason: err instanceof Error ? err.message : String(err) };
			}
		);
		return () => {
			live = false;
		};
	});

	const row = "grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 text-sm";
	const term = "text-gray-500 dark:text-gray-400";
</script>

<Modal sheet width="sm:w-[28rem]" labelledBy={titleId} {onclose}>
	<div class="p-5 pb-6" data-testid="connector-detail">
		<div class="mb-4 flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h2 id={titleId} class="text-lg font-semibold break-words text-gray-900 dark:text-gray-100">
					{title}
				</h2>
				{#if local}
					<p class="text-sm text-gray-500 dark:text-gray-400">
						{m["mcp.detail.on_machine"]({ machine: local.machineName })}
					</p>
				{/if}
			</div>
			<button
				type="button"
				aria-label={m["app.close"]()}
				onclick={onclose}
				class="-m-1 shrink-0 rounded-lg p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
			>
				<CarbonClose class="size-5" />
			</button>
		</div>

		{#if description}
			<p class="mb-4 text-sm break-words text-gray-700 dark:text-gray-300">{description}</p>
		{/if}

		<dl class="flex flex-col gap-2">
			<div class={row}>
				<dt class={term}>{m["mcp.detail.status"]()}</dt>
				<dd class="break-words text-gray-900 dark:text-gray-100">
					{stateLabel}{#if stateDetail}<span class="block text-gray-600 dark:text-gray-400"
							>{stateDetail}</span
						>{/if}
				</dd>
			</div>
			<div class={row}>
				<dt class={term}>{m["mcp.detail.connection_type"]()}</dt>
				<dd class="text-gray-900 dark:text-gray-100">{transport}</dd>
			</div>
			{#if !local}
				<div class={row}>
					<dt class={term}>{m["mcp.detail.address"]()}</dt>
					<dd class="break-all text-gray-900 dark:text-gray-100">{connector.url}</dd>
				</div>
			{/if}
			{#if local?.allowedTools}
				<div class={row}>
					<dt class={term}>{m["mcp.detail.allowed_tools"]()}</dt>
					<dd class="break-words text-gray-900 dark:text-gray-100">
						{local.allowedTools.join(", ")}
					</dd>
				</div>
			{/if}
		</dl>

		<h3 class="mt-5 mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
			{m["mcp.detail.tools"]()}
		</h3>
		{#if listing.kind === "loading"}
			<p class="text-sm text-gray-600 dark:text-gray-400">{m["mcp.detail.loading_tools"]()}</p>
		{:else if listing.kind === "error"}
			<p
				class="rounded-sm bg-red-50 px-2 py-1 text-sm break-words text-red-800 dark:bg-red-900/20 dark:text-red-200"
			>
				{m["mcp.detail.tools_error"]({ reason: listing.reason })}
			</p>
		{:else if listing.kind === "tools"}
			{#if listing.tools.length === 0}
				<p class="text-sm text-gray-600 dark:text-gray-400">{m["mcp.detail.no_tools"]()}</p>
			{:else}
				<ul class="flex flex-col gap-1.5" aria-label={m["mcp.detail.tools"]()}>
					{#each listing.tools as tool (tool.name)}
						<li class="text-sm break-words">
							<span class="font-mono text-gray-900 dark:text-gray-100">{tool.name}</span>
							{#if tool.description}
								<span class="line-clamp-2 block text-xs text-gray-500 dark:text-gray-400"
									>{tool.description}</span
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<p class="text-sm text-gray-600 dark:text-gray-400">
				{local ? m["mcp.detail.tools_when_on"]() : m["mcp.detail.not_checked"]()}
			</p>
		{/if}
	</div>
</Modal>
