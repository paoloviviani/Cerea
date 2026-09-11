<!--
	Connectors: remote MCP servers, and signing in to them (ADR 0064).

	This is the half of the MCP dialog that replaces "paste a URL and an
	Authorization header". Adding one **probes the server** — a remote MCP
	server says how it authenticates, so nobody has to declare it — and a
	connector that wants OAuth gets a Sign in button rather than a headers
	editor.

	The credential never comes back here. A row knows only whether *this*
	person is connected, which is all a button needs to decide what to say.

	Sign-in leaves the page on purpose: it is a consent screen on somebody
	else's origin, and the callback lands back in the chat with `?mcp=`
	saying how it went.
-->
<script lang="ts">
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconTrash from "~icons/carbon/trash-can";
	import IconRefresh from "~icons/carbon/renew";
	import IconLogin from "~icons/carbon/login";
	import LucidePlug from "~icons/lucide/plug";
	import Switch from "$lib/components/Switch.svelte";
	import type { McpConnectorView } from "$lib/types/McpConnector";
	import {
		connectors,
		connectorsLoaded,
		refreshConnectors,
		selectedConnectorIds,
		toggleConnector,
		selectConnector,
	} from "$lib/stores/mcpConnectors";

	// The list lives in a store rather than here, because the composer's MCP
	// badge and the conversation POST both need to know which connectors are
	// on, and a copy held by a dialog that is destroyed when it closes cannot
	// tell them.
	const loading = $derived(!$connectorsLoaded);
	let failure = $state<string | null>(null);
	let busy = $state(false);
	let adding = $state(false);

	let name = $state("");
	let url = $state("");
	let token = $state("");

	// The callback comes back with `?mcp=connected|failed`, so a person who has
	// just approved a consent screen is told it worked rather than having to
	// infer it from a pill.
	const outcome = $derived(page.url.searchParams.get("mcp"));
	const outcomeDetail = $derived(page.url.searchParams.get("mcpDetail"));

	async function api<T>(
		path: string,
		init?: { method?: string; headers?: Record<string, string>; body?: string }
	): Promise<T> {
		const response = await fetch(`${base}/api/v2/mcp${path}`, init);
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
		}
		return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
	}

	function json(body: unknown, method = "POST") {
		return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	}

	async function load() {
		failure = null;
		await refreshConnectors();
	}

	load();

	// Somebody who has just approved a consent screen meant to use that
	// connector, so it is switched on rather than left for them to find. Ids
	// are compared against the loaded list first: a stale `?mcpConnector=` in
	// a bookmarked URL should select nothing.
	$effect(() => {
		const justConnected = page.url.searchParams.get("mcpConnector");
		if (outcome !== "connected" || !justConnected) return;
		if ($connectors.some((c) => c.id === justConnected && c.connected)) {
			selectConnector(justConnected);
		}
	});

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (!name.trim() || !url.trim()) return;
		busy = true;
		failure = null;
		try {
			await api<McpConnectorView>(
				"/connectors",
				json({
					name: name.trim(),
					url: url.trim(),
					...(token.trim() ? { token: token.trim() } : {}),
				})
			);
			name = "";
			url = "";
			token = "";
			adding = false;
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not add it.";
		} finally {
			busy = false;
		}
	}

	async function signIn(connector: McpConnectorView) {
		busy = true;
		failure = null;
		try {
			const { authorizeUrl } = await api<{ authorizeUrl: string }>(
				`/connectors/${connector.id}`,
				json({ action: "authorize", next: page.url.pathname })
			);
			// A full navigation, not a fetch: this is a consent screen on
			// another origin and it has to be the browser that goes there.
			window.location.href = authorizeUrl;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start the sign-in.";
			busy = false;
		}
	}

	async function act(connector: McpConnectorView, action: "reprobe" | "disconnect") {
		busy = true;
		failure = null;
		try {
			await api(`/connectors/${connector.id}`, json({ action }));
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "That did not work.";
		} finally {
			busy = false;
		}
	}

	async function remove(connector: McpConnectorView) {
		if (!confirm(`Remove “${connector.name}”? Its sign-in goes with it.`)) return;
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

<div class="space-y-3">
	<div class="flex items-start justify-between gap-3">
		<div>
			<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
				Connectors ({$connectors.length})
			</h3>
			<p class="text-xs text-gray-600 dark:text-gray-400">
				Remote MCP servers. The credential is kept on the server, never in this browser.
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

	{#if outcome === "connected"}
		<p
			class="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300"
		>
			Connected.
		</p>
	{:else if outcome === "failed"}
		<p
			class="rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300"
		>
			{outcomeDetail === "declined"
				? "The sign-in was declined."
				: `The sign-in did not complete${outcomeDetail ? ` (${outcomeDetail})` : ""}.`}
		</p>
	{/if}

	{#if failure}
		<p
			class="rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300"
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
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Name</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						placeholder="Notion"
						bind:value={name}
						required
						disabled={busy}
					/>
				</label>
				<label class="flex flex-2 flex-col gap-1" style="flex-grow:2">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300">URL</span>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						placeholder="https://mcp.notion.com/mcp"
						bind:value={url}
						required
						disabled={busy}
					/>
				</label>
			</div>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">
					Token <span class="font-normal text-gray-500"
						>(only if it takes one instead of OAuth)</span
					>
				</span>
				<input
					type="password"
					autocomplete="off"
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
					bind:value={token}
					disabled={busy}
				/>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					Leave it empty and the server is asked how it authenticates. If it wants OAuth, a Sign in
					button appears.
				</span>
			</label>
			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (adding = false)}
					class="btn rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={busy || !name.trim() || !url.trim()}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				>
					{busy ? "Adding…" : "Add connector"}
				</button>
			</div>
		</form>
	{/if}

	{#if loading}
		<p class="text-sm text-gray-600 dark:text-gray-400">Loading…</p>
	{:else if $connectors.length === 0}
		<div
			class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-6 dark:border-gray-700"
		>
			<LucidePlug class="mb-3 size-10 text-gray-400" />
			<p class="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">No connectors yet</p>
			<p class="mb-3 text-xs text-gray-600 dark:text-gray-400">
				Add a remote MCP server and sign in to it
			</p>
			<button
				type="button"
				onclick={() => (adding = true)}
				class="btn flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
			>
				<IconAddLarge class="size-4" />
				Add Your First Connector
			</button>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
			{#each $connectors as connector (connector.id)}
				<div
					class="rounded-lg border bg-linear-to-br transition-colors {connector.connected
						? 'border-blue-600/20 bg-blue-50 from-blue-500/5 to-transparent dark:border-blue-700/60 dark:bg-blue-900/10 dark:from-blue-900/20'
						: 'border-gray-200 bg-white from-black/5 dark:border-gray-700 dark:bg-gray-800 dark:from-white/5'}"
				>
					<div class="px-4 py-3.5">
						<div class="mb-2 flex items-start justify-between gap-2">
							<div class="min-w-0">
								<h4 class="truncate font-semibold text-gray-900 dark:text-gray-100">
									{connector.name}
								</h4>
								<p class="truncate text-sm text-gray-600 dark:text-gray-400">{connector.url}</p>
							</div>
							<!-- On for the next message. Disabled until it is connected,
							     because an unauthorised connector contributes no tools and
							     would fail the handshake mid-generation. -->
							<div
								class="shrink-0 pt-0.5"
								title={connector.connected ? "Use in chat" : "Sign in first"}
							>
								<Switch
									name={`use-connector-${connector.id}`}
									disabled={!connector.connected}
									bind:checked={
										() => $selectedConnectorIds.has(connector.id),
										() => toggleConnector(connector.id)
									}
								/>
							</div>
						</div>

						<div class="mb-3 flex flex-wrap items-center gap-2">
							{#if connector.connected}
								<span
									class="inline-flex items-center gap-1 rounded-full bg-green-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-green-600 dark:bg-green-900/20 dark:text-green-400"
								>
									<IconCheckmark class="size-3" />
									{connector.auth === "none" ? "Open" : "Connected"}
								</span>
							{:else}
								<span
									class="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
								>
									<IconWarning class="size-3" />
									Not signed in
								</span>
							{/if}
							<span class="text-xs text-gray-600 dark:text-gray-400">
								{connector.auth === "oauth"
									? "OAuth"
									: connector.auth === "token"
										? "token"
										: "no auth"}
							</span>
						</div>

						{#if connector.lastError}
							<p
								class="mb-2 line-clamp-3 rounded-sm bg-red-50 px-2 py-1 text-xs wrap-break-word text-red-800 dark:bg-red-900/20 dark:text-red-200"
							>
								{connector.lastError}
							</p>
						{/if}

						<div class="flex flex-wrap gap-1">
							{#if connector.auth === "oauth" && !connector.connected}
								<button
									onclick={() => signIn(connector)}
									disabled={busy || !connector.canAuthorize}
									title={connector.canAuthorize
										? "Sign in to this connector"
										: "This server offers no way to register a client automatically"}
									class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-[.29rem] text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
								>
									<IconLogin class="size-3" />
									Sign in
								</button>
							{:else if connector.auth === "oauth"}
								<button
									onclick={() => act(connector, "disconnect")}
									disabled={busy}
									class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
								>
									Disconnect
								</button>
							{/if}
							<button
								onclick={() => act(connector, "reprobe")}
								disabled={busy}
								title="Ask the server again how it authenticates"
								class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
							>
								<IconRefresh class="size-3" />
								Re-check
							</button>
							<button
								onclick={() => remove(connector)}
								disabled={busy}
								class="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-[.29rem] text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400"
							>
								<IconTrash class="size-3" />
								Remove
							</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>
