<!--
	MCP connectors the deployment offers to everybody.

	The definition is shared; the credential is not. Each person signs in to an
	OAuth connector themselves and their token stays keyed on
	`(userId, connectorId)`, so a shared Notion connector means everybody
	reading *their own* workspace as themselves — not one identity shared
	between them. ADR 0064 anticipated exactly this ("a connector's definition
	is worth sharing; a token never is").

	The exception is a static token: that belongs to the connector rather than
	to a person, so publishing one shares the key. The screen says so, because
	it is a decision rather than an accident.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { base } from "$app/paths";
	import { m } from "$lib/paraglide/messages";
	import Rich from "$lib/i18n/Rich.svelte";
	import IconTrash from "~icons/carbon/trash-can";
	import IconAddLarge from "~icons/carbon/add-large";
	import type { McpConnectorView } from "$lib/types/McpConnector";
	import { allMcpServers, healthCheckServer } from "$lib/stores/mcpServers";

	// Example values and an HTTP header name, not words. i18n: literal
	const EXAMPLE_URL = "https://mcp.notion.com/mcp";
	// i18n: literal
	const EXAMPLE_HEADER = "Authorization";

	let connectors = $state<McpConnectorView[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let failure = $state<string | null>(null);
	let adding = $state(false);

	let name = $state("");
	let url = $state("");
	let authMode = $state<"auto" | "none" | "token">("auto");
	let token = $state("");
	let tokenHeader = $state("");

	// The servers `.env` (`MCP_SERVERS`) defines: the same store the chat reads, so their
	// state is whatever the health route last said, with no probe loop of its own. Read-only.
	const envServers = $derived(
		$allMcpServers.filter((s) => s.type === "base").sort((a, b) => a.name.localeCompare(b.name))
	);

	const shared = $derived(connectors.filter((c) => c.scope === "deployment"));

	// A local shape rather than `RequestInit`: eslint's environment for
	// component files does not define the DOM lib's globals, and importing one
	// for a three-field object is not worth it.
	interface Call {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	}

	async function api<T>(path: string, init?: Call): Promise<T> {
		const response = await fetch(`${base}/api/v2/mcp${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["admin.common.error_status"]({ status: response.status })
			);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	async function load() {
		failure = null;
		try {
			connectors = (await api<{ data: McpConnectorView[] }>("/connectors")).data;
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.load_failed"]();
		} finally {
			loading = false;
		}
	}

	onMount(load);

	async function add(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = null;
		try {
			await api("/connectors", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					url: url.trim(),
					scope: "deployment",
					authMode,
					...(authMode === "token"
						? {
								token: token.trim(),
								...(tokenHeader.trim()
									? {
											tokenHeader: tokenHeader.trim(),
											tokenPrefix: /^authorization$/i.test(tokenHeader.trim()) ? "Bearer " : "",
										}
									: {}),
							}
						: {}),
				}),
			});
			name = "";
			url = "";
			token = "";
			tokenHeader = "";
			authMode = "auto";
			adding = false;
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.add_failed"]();
		} finally {
			busy = false;
		}
	}

	async function remove(connector: McpConnectorView) {
		if (!confirm(m["admin.connectors.remove_confirm"]({ name: connector.name }))) {
			return;
		}
		busy = true;
		try {
			// `?scope=deployment` is the request saying it is the administrative
			// remove — the same DELETE route also serves the MCP overlay, where
			// a deployment connector is nobody's to delete, whatever their role.
			await api(`/connectors/${connector.id}?scope=deployment`, { method: "DELETE" });
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.remove_failed"]();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet code(text: string)}<code class="font-mono">{text}</code>{/snippet}

{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h2 class="font-medium">{m["admin.connectors.title"]()}</h2>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{m["admin.connectors.description"]()}
			</p>
		</div>
		<button
			type="button"
			onclick={() => (adding = !adding)}
			class="btn flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 py-1.5 pr-3 pl-2 text-sm font-medium text-white hover:bg-blue-600"
		>
			<IconAddLarge class="size-4" />
			{m["admin.connectors.add"]()}
		</button>
	</div>

	{#if failure}
		<p
			class="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
		>
			{failure}
		</p>
	{/if}

	{#if adding}
		<form
			class="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
			onsubmit={add}
		>
			<div class="flex flex-wrap gap-2">
				<label class="flex flex-1 flex-col gap-1">
					<span class="text-xs font-medium">{m["admin.connectors.form.name"]()}</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						placeholder={m["admin.connectors.form.name_placeholder"]()}
						bind:value={name}
						required
						disabled={busy}
					/>
				</label>
				<label class="flex flex-col gap-1" style="flex:2">
					<span class="text-xs font-medium">{m["admin.connectors.form.url"]()}</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						placeholder={EXAMPLE_URL}
						bind:value={url}
						required
						disabled={busy}
					/>
				</label>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium">{m["admin.connectors.form.auth"]()}</span>
				<select
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={authMode}
					disabled={busy}
				>
					<option value="auto">{m["admin.connectors.form.auth_auto"]()}</option>
					<option value="none">{m["admin.connectors.form.auth_none"]()}</option>
					<option value="token">{m["admin.connectors.form.auth_token"]()}</option>
				</select>
			</label>

			{#if authMode === "token"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1" style="flex:2">
						<span class="text-xs font-medium">{m["admin.connectors.form.token"]()}</span>
						<input
							type="password"
							autocomplete="off"
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
							bind:value={token}
							required
							disabled={busy}
						/>
					</label>
					<label class="flex flex-1 flex-col gap-1">
						<span class="text-xs font-medium"
							>{m["admin.connectors.form.header"]()}
							<span class="font-normal text-gray-500">{m["admin.connectors.form.optional"]()}</span
							></span
						>
						<input
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
							placeholder={EXAMPLE_HEADER}
							bind:value={tokenHeader}
							disabled={busy}
						/>
					</label>
				</div>
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				>
					<Rich parts={m["admin.connectors.form.shared_warning"].parts({})} tags={{ strong }} />
				</p>
			{:else}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{m["admin.connectors.form.individual"]()}
				</p>
			{/if}

			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (adding = false)}
					class="btn rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
				>
					{m["admin.connectors.form.cancel"]()}
				</button>
				<button
					type="submit"
					disabled={busy || !name.trim() || !url.trim()}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? m["admin.connectors.form.adding"]() : m["admin.connectors.form.submit"]()}
				</button>
			</div>
		</form>
	{/if}

	{#if envServers.length > 0}
		<div class="flex flex-col gap-2" data-testid="env-servers">
			<p class="text-xs text-gray-500 dark:text-gray-400">
				<Rich
					parts={m["admin.connectors.env.description"].parts({
						file: ".env",
						variable: "MCP_SERVERS",
					})}
					tags={{ code }}
				/>
			</p>
			<ul class="flex flex-col gap-2">
				{#each envServers as server (server.id)}
					<li
						data-testid="env-server"
						class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 max-sm:flex-col max-sm:items-stretch dark:border-gray-700"
					>
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{server.name}</p>
							<p class="truncate text-xs text-gray-500 dark:text-gray-400" title={server.url}>
								{server.url}
							</p>
							{#if server.errorMessage}
								<p class="mt-1 text-xs text-red-600 dark:text-red-400">{server.errorMessage}</p>
							{/if}
						</div>
						<div class="flex shrink-0 flex-wrap items-center gap-2">
							<span
								class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300"
							>
								{m["admin.connectors.env.badge"]()}
							</span>
							<span class="text-xs text-gray-500">
								{server.status === "connected"
									? server.tools
										? m["admin.connectors.env.status.reachable_tools"]({
												count: server.tools.length,
											})
										: m["admin.connectors.env.status.reachable"]()
									: server.status === "error"
										? m["admin.connectors.env.status.unreachable"]()
										: server.status === "connecting"
											? m["admin.connectors.env.status.checking"]()
											: m["admin.connectors.env.status.not_checked"]()}
							</span>
							<button
								type="button"
								onclick={() => healthCheckServer(server)}
								disabled={server.status === "connecting"}
								class="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
							>
								{m["admin.connectors.env.check"]()}
							</button>
						</div>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-500">{m["admin.common.loading"]()}</p>
	{:else if shared.length === 0 && envServers.length === 0}
		<p class="text-sm text-gray-600 dark:text-gray-400">
			{m["admin.connectors.none"]()}
		</p>
	{:else if shared.length > 0}
		<ul class="flex flex-col gap-2">
			{#each shared as connector (connector.id)}
				<li
					class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 max-sm:flex-col max-sm:items-stretch dark:border-gray-700"
				>
					<div class="min-w-0">
						<p class="truncate text-sm font-medium">{connector.name}</p>
						<p class="truncate text-xs text-gray-500 dark:text-gray-400" title={connector.url}>
							{connector.url}
						</p>
						{#if connector.lastError}
							<p class="mt-1 text-xs text-red-600 dark:text-red-400">{connector.lastError}</p>
						{/if}
					</div>
					<div class="flex shrink-0 flex-wrap items-center gap-2">
						<span class="text-xs text-gray-500">
							{connector.auth === "oauth"
								? m["admin.connectors.auth.oauth"]()
								: connector.auth === "token"
									? m["admin.connectors.auth.token"]()
									: m["admin.connectors.auth.none"]()}
						</span>
						<button
							onclick={() => remove(connector)}
							disabled={busy}
							class="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400"
						>
							<IconTrash class="size-3" />
							{m["admin.connectors.remove"]()}
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
