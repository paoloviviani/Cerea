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
	import IconTrash from "~icons/carbon/trash-can";
	import IconAddLarge from "~icons/carbon/add-large";
	import type { McpConnectorView } from "$lib/types/McpConnector";

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
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	async function load() {
		failure = null;
		try {
			connectors = (await api<{ data: McpConnectorView[] }>("/connectors")).data;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not load connectors.";
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
			failure = err instanceof Error ? err.message : "Could not add it.";
		} finally {
			busy = false;
		}
	}

	async function remove(connector: McpConnectorView) {
		if (
			!confirm(
				`Remove “${connector.name}” for everyone? Anybody who signed in to it loses that connection.`
			)
		) {
			return;
		}
		busy = true;
		try {
			await api(`/connectors/${connector.id}`, { method: "DELETE" });
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not remove it.";
		} finally {
			busy = false;
		}
	}
</script>

<section class="flex flex-col gap-5 rounded-lg border border-gray-200 p-5 dark:border-gray-700">
	<div class="flex items-start justify-between gap-3">
		<div class="flex flex-col gap-1">
			<h2 class="font-medium">Connectors for everyone</h2>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				Remote MCP servers offered to every account. Each person signs in to an OAuth connector
				themselves, so their tools reach their own data — you are sharing the server, not an
				identity.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (adding = !adding)}
			class="btn flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 py-1.5 pr-3 pl-2 text-sm font-medium text-white hover:bg-blue-600"
		>
			<IconAddLarge class="size-4" />
			Add
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
					<span class="text-xs font-medium">Name</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						placeholder="Notion"
						bind:value={name}
						required
						disabled={busy}
					/>
				</label>
				<label class="flex flex-col gap-1" style="flex:2">
					<span class="text-xs font-medium">URL</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
						placeholder="https://mcp.notion.com/mcp"
						bind:value={url}
						required
						disabled={busy}
					/>
				</label>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium">Authentication</span>
				<select
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					bind:value={authMode}
					disabled={busy}
				>
					<option value="auto">Detect automatically</option>
					<option value="none">None</option>
					<option value="token">Shared token</option>
				</select>
			</label>

			{#if authMode === "token"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-col gap-1" style="flex:2">
						<span class="text-xs font-medium">Token</span>
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
							>Header <span class="font-normal text-gray-500">(optional)</span></span
						>
						<input
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
							placeholder="Authorization"
							bind:value={tokenHeader}
							disabled={busy}
						/>
					</label>
				</div>
				<p
					class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
				>
					<strong>This key is shared.</strong> Unlike an OAuth connector, where each person signs in as
					themselves, a static token belongs to the connector — every account here will use this one credential
					and the server cannot tell them apart. Use it for an API key the organisation holds, not for
					anything personal.
				</p>
			{:else}
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Each person signs in individually and their token is stored against their own account.
					Nobody inherits anybody else's access, including yours.
				</p>
			{/if}

			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (adding = false)}
					class="btn rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={busy || !name.trim() || !url.trim()}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "Adding…" : "Add for everyone"}
				</button>
			</div>
		</form>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-500">Loading…</p>
	{:else if shared.length === 0}
		<p class="text-sm text-gray-600 dark:text-gray-400">
			None yet. Anything added here appears in everybody's MCP dialog, switched off until they turn
			it on.
		</p>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each shared as connector (connector.id)}
				<li
					class="flex items-center justify-between gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
				>
					<div class="min-w-0">
						<p class="truncate text-sm font-medium">{connector.name}</p>
						<p class="truncate text-xs text-gray-500 dark:text-gray-400">{connector.url}</p>
						{#if connector.lastError}
							<p class="mt-1 text-xs text-red-600 dark:text-red-400">{connector.lastError}</p>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<span class="text-xs text-gray-500">
							{connector.auth === "oauth"
								? "OAuth — each person signs in"
								: connector.auth === "token"
									? "shared token"
									: "no auth"}
						</span>
						<button
							onclick={() => remove(connector)}
							disabled={busy}
							class="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400"
						>
							<IconTrash class="size-3" />
							Remove
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
