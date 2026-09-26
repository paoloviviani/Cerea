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
	import { onMount } from "svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import IconAddLarge from "~icons/carbon/add-large";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconTrash from "~icons/carbon/trash-can";
	import IconRefresh from "~icons/carbon/renew";
	import IconLogin from "~icons/carbon/login";
	import IconEdit from "~icons/carbon/edit";
	import LucidePlug from "~icons/lucide/plug";
	import Switch from "$lib/components/Switch.svelte";
	import type { McpConnectorView } from "$lib/types/McpConnector";
	import {
		connectors,
		connectorsLoaded,
		refreshConnectors,
		defaultConnectorIds,
		toggleDefaultConnector,
		selectDefaultConnector,
	} from "$lib/stores/mcpConnectors";

	// The list lives in a store rather than here, because the composer's MCP
	// badge and the conversation POST both need to know which connectors are
	// on, and a copy held by a dialog that is destroyed when it closes cannot
	// tell them.
	const loading = $derived(!$connectorsLoaded);
	const publicConfig = usePublicConfig();
	let failure = $state<string | null>(null);
	let busy = $state(false);
	let adding = $state(false);

	// Two sections, because the two kinds of connector are not the same thing
	// to the person reading the list: their own are theirs to edit and remove,
	// and the deployment's are somebody else's decision that they may use.
	// One mixed grid made an administrator's Remove button work on rows they
	// were only looking at because they administer the place (the backend
	// now refuses that regardless).
	const own = $derived($connectors.filter((c) => c.scope === "user"));
	const provided = $derived($connectors.filter((c) => c.scope === "deployment"));

	let name = $state("");
	let url = $state("");
	let token = $state("");
	let tokenHeader = $state("");
	let authMode = $state<"auto" | "none" | "token" | "oauth_static">("auto");
	let clientId = $state("");
	let clientSecret = $state("");
	/** One existing connector can be changed without losing its id or sign-in. */
	let editing = $state<McpConnectorView | null>(null);
	let editName = $state("");
	let editUrl = $state("");
	let editToken = $state("");
	let editTokenHeader = $state("");
	let clearEditToken = $state(false);

	/** Which row has its credentials form open, and what is in it. */
	let credentialsFor = $state<string | null>(null);
	let rowClientId = $state("");
	let rowClientSecret = $state("");

	// Shown so somebody registering a client by hand can copy it. Built here
	// rather than fetched: it is the same value the server derives from
	// PUBLIC_ORIGIN, and a round trip to display a constant is silly.
	const redirectUri = $derived(
		typeof window === "undefined" ? "" : `${window.location.origin}${base}/mcp/callback`
	);

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

	// In `onMount`, not the component body: the body also runs during server
	// rendering, where the relative URL cannot be fetched and the page logged
	// "Failed to load MCP connectors: Failed to parse URL".
	onMount(() => {
		void load();
	});

	// Somebody who has just approved a consent screen meant to use that
	// connector, so it is switched on in the defaults for new chats rather
	// than left for them to find. Ids are compared against the loaded list
	// first: a stale `?mcpConnector=` in a bookmarked URL should select
	// nothing.
	$effect(() => {
		const justConnected = page.url.searchParams.get("mcpConnector");
		if (outcome !== "connected" || !justConnected) return;
		if ($connectors.some((c) => c.id === justConnected && c.connected)) {
			selectDefaultConnector(justConnected);
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
					authMode,
					...(authMode === "token"
						? {
								token: token.trim(),
								...(tokenHeader.trim()
									? {
											tokenHeader: tokenHeader.trim(),
											// An `X-API-Key` takes the value bare; only
											// `Authorization` conventionally wants a scheme.
											tokenPrefix: /^authorization$/i.test(tokenHeader.trim()) ? "Bearer " : "",
										}
									: {}),
							}
						: {}),
					...(authMode === "oauth_static"
						? {
								clientId: clientId.trim(),
								...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
							}
						: {}),
				})
			);
			name = "";
			url = "";
			token = "";
			tokenHeader = "";
			clientId = "";
			clientSecret = "";
			authMode = "auto";
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

	function beginEdit(connector: McpConnectorView) {
		editing = connector;
		editName = connector.name;
		editUrl = connector.url;
		editToken = "";
		editTokenHeader = "";
		clearEditToken = false;
		failure = null;
	}

	function cancelEdit() {
		editing = null;
		editToken = "";
		clearEditToken = false;
	}

	async function saveEdit(event: SubmitEvent) {
		event.preventDefault();
		if (!editing || !editName.trim() || !editUrl.trim()) return;
		busy = true;
		failure = null;
		try {
			await api(
				`/connectors/${editing.id}`,
				json({
					action: "update",
					name: editName.trim(),
					url: editUrl.trim(),
					...(editToken.trim()
						? {
								token: editToken.trim(),
								...(editTokenHeader.trim()
									? {
											tokenHeader: editTokenHeader.trim(),
											tokenPrefix: /^authorization$/i.test(editTokenHeader.trim()) ? "Bearer " : "",
										}
									: {}),
							}
						: {}),
					...(clearEditToken ? { clearToken: true } : {}),
				})
			);
			cancelEdit();
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save the connector.";
		} finally {
			busy = false;
		}
	}

	async function saveCredentials(event: SubmitEvent, connector: McpConnectorView) {
		event.preventDefault();
		if (!rowClientId.trim()) return;
		busy = true;
		failure = null;
		try {
			await api(
				`/connectors/${connector.id}`,
				json({
					action: "update",
					clientId: rowClientId.trim(),
					...(rowClientSecret.trim() ? { clientSecret: rowClientSecret.trim() } : {}),
				})
			);
			rowClientId = "";
			rowClientSecret = "";
			credentialsFor = null;
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not save those credentials.";
		} finally {
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
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Authentication</span>
				<select
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
					bind:value={authMode}
					disabled={busy}
				>
					<option value="auto">Detect automatically</option>
					<option value="none">None</option>
					<option value="token">Token</option>
					<option value="oauth_static">OAuth — credentials I already have</option>
				</select>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{#if authMode === "auto"}
						The server is asked how it authenticates. If it wants OAuth and can register a client
						itself, a Sign in button appears.
					{:else if authMode === "oauth_static"}
						For a provider that will not register a client automatically. Create one in its
						developer settings with this redirect URI, then paste its credentials here.
					{:else if authMode === "token"}
						A static key or token. It is sealed on the server — it never returns to this browser.
					{:else}
						No credential is sent.
					{/if}
				</span>
			</label>

			{#if authMode === "token"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-2 flex-col gap-1" style="flex-grow:2">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Token</span>
						<input
							type="password"
							autocomplete="off"
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={token}
							required
							disabled={busy}
						/>
					</label>
					<label class="flex flex-1 flex-col gap-1">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">
							Header <span class="font-normal text-gray-500">(optional)</span>
						</span>
						<input
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							placeholder="Authorization"
							bind:value={tokenHeader}
							disabled={busy}
						/>
					</label>
				</div>
			{:else if authMode === "oauth_static"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-1 flex-col gap-1">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Client ID</span>
						<input
							autocomplete="off"
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={clientId}
							required
							disabled={busy}
						/>
					</label>
					<label class="flex flex-1 flex-col gap-1">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300">
							Client secret <span class="font-normal text-gray-500">(if it has one)</span>
						</span>
						<input
							type="password"
							autocomplete="off"
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={clientSecret}
							disabled={busy}
						/>
					</label>
				</div>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					Redirect URI to register with the provider:
					<code class="rounded-sm bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{redirectUri}</code>
				</p>
			{/if}
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

	{#snippet connectorCard(connector: McpConnectorView)}
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
					<!-- On by default for new chats. Disabled until it is
					     connected, because an unauthorised connector contributes
					     no tools and would fail the handshake mid-generation.
					     Per-chat toggles live in the composer, not here:
					     settings hold *defaults*, a chat holds *per-chat
					     state*. -->
					<div
						class="flex shrink-0 items-center gap-2 pt-0.5"
						title={connector.connected ? "On for new chats" : "Sign in first"}
					>
						<span class="text-xs text-gray-600 dark:text-gray-400">
							{connector.connected ? "On by default in new chats" : "Sign in first"}
						</span>
						<Switch
							name={`use-connector-${connector.id}`}
							disabled={!connector.connected}
							bind:checked={
								() => $defaultConnectorIds.has(connector.id),
								() => toggleDefaultConnector(connector.id)
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
					{#if connector.registrationSource === "static"}
						<!-- Worth saying: it explains why Sign in works on a server
						     that refuses to register clients, and why a re-check
						     will not replace these credentials. -->
						<span
							class="text-xs text-gray-500 dark:text-gray-500"
							title={`Client ID ${connector.clientId}`}
						>
							own client
						</span>
					{/if}
				</div>

				{#if connector.lastError}
					<p
						class="mb-2 line-clamp-3 rounded-sm bg-red-50 px-2 py-1 text-xs wrap-break-word text-red-800 dark:bg-red-900/20 dark:text-red-200"
					>
						{connector.lastError}
					</p>
				{/if}

				<div class="flex flex-wrap gap-1">
					<!-- Changing a connector — its URL, its credentials, the shared
					     record of how it authenticates — is `manageable`'s whole
					     question, computed server-side per caller. A deployment
					     connector renders these only for an administrator: for
					     everybody else they were buttons whose requests the server
					     was already refusing. -->
					{#if connector.manageable}
						<button
							onclick={() => beginEdit(connector)}
							disabled={busy}
							class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
						>
							<IconEdit class="size-3" />
							Edit
						</button>
					{/if}
					{#if connector.auth === "oauth" && !connector.connected}
						<button
							onclick={() => signIn(connector)}
							disabled={busy || !connector.canAuthorize}
							title={connector.canAuthorize
								? "Sign in to this connector"
								: "This server will not register a client automatically — add credentials instead"}
							class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-[.29rem] text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
						>
							<IconLogin class="size-3" />
							Sign in
						</button>
						{#if connector.manageable && !connector.canAuthorize}
							<!-- The way out of a dead end. A provider that does not
							     offer RFC 7591 leaves Sign in disabled for good, and
							     pasting a client id is what makes it usable. -->
							<button
								onclick={() =>
									(credentialsFor = credentialsFor === connector.id ? null : connector.id)}
								disabled={busy}
								class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
							>
								Add credentials
							</button>
						{/if}
					{:else if connector.auth === "oauth"}
						<button
							onclick={() => act(connector, "disconnect")}
							disabled={busy}
							class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
						>
							Disconnect
						</button>
					{/if}
					{#if connector.manageable}
						<button
							onclick={() => act(connector, "reprobe")}
							disabled={busy}
							title={connector.auth === "token"
								? "Try the token and list the server's tools"
								: "Ask the server again how it authenticates"}
							class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
						>
							<IconRefresh class="size-3" />
							Re-check
						</button>
					{/if}
					{#if connector.scope === "user"}
						<!-- Removing a connector you own ends here, whoever you are.
						     A deployment connector is not on this dialog to be
						     deleted — even by the administrator who added it, whose
						     remove lives on the admin screen where "for everyone" is
					     the sentence being confirmed. -->
						<button
							onclick={() => remove(connector)}
							disabled={busy}
							class="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-[.29rem] text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400"
						>
							<IconTrash class="size-3" />
							Remove
						</button>
					{/if}
				</div>

				{#if credentialsFor === connector.id}
					<form
						class="mt-3 space-y-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700"
						onsubmit={(event) => saveCredentials(event, connector)}
					>
						<input
							autocomplete="off"
							placeholder="Client ID"
							class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={rowClientId}
							required
							disabled={busy}
						/>
						<input
							type="password"
							autocomplete="off"
							placeholder="Client secret (if it has one)"
							class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={rowClientSecret}
							disabled={busy}
						/>
						<p class="text-xs text-gray-500 dark:text-gray-400">
							Register this redirect URI with the provider:
							<code class="rounded-sm bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{redirectUri}</code>
						</p>
						<div class="flex justify-end">
							<button
								type="submit"
								disabled={busy || !rowClientId.trim()}
								class="btn rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
							>
								Save
							</button>
						</div>
					</form>
				{/if}

				{#if editing?.id === connector.id}
					<form
						class="mt-3 space-y-2 rounded-lg border border-gray-200 p-2 dark:border-gray-700"
						onsubmit={saveEdit}
					>
						<label class="flex flex-col gap-1">
							<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Name</span>
							<input
								class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
								bind:value={editName}
								required
								disabled={busy}
							/>
						</label>
						<label class="flex flex-col gap-1">
							<span class="text-xs font-medium text-gray-700 dark:text-gray-300">URL</span>
							<input
								type="url"
								class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
								bind:value={editUrl}
								required
								disabled={busy}
							/>
						</label>
						<!-- Offered on a "no auth" connector too: that is where auto mode
						     leaves a server that answered 401 with no OAuth metadata, and
						     its row tells the person to add a token here. -->
						{#if connector.auth === "token" || connector.auth === "none"}
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
									>{connector.auth === "token" ? "Replacement token" : "Token"}
									<span class="font-normal text-gray-500"
										>{connector.auth === "token"
											? "(leave blank to keep)"
											: "(if the server takes an API key or token)"}</span
									></span
								>
								<input
									type="password"
									autocomplete="off"
									class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
									bind:value={editToken}
									disabled={busy}
								/>
							</label>
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium text-gray-700 dark:text-gray-300">Header</span>
								<input
									placeholder="Authorization"
									class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
									bind:value={editTokenHeader}
									disabled={busy || !editToken.trim()}
								/>
							</label>
							{#if connector.auth === "token"}
								<label class="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
									<input
										type="checkbox"
										bind:checked={clearEditToken}
										disabled={busy || !!editToken.trim()}
									/>
									Remove the stored token
								</label>
							{/if}
						{/if}
						<p class="text-xs text-gray-500 dark:text-gray-400">
							Changing the URL clears cached server details; re-check it, then sign in again if
							needed.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onclick={cancelEdit}
								disabled={busy}
								class="btn rounded-lg border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={busy || !editName.trim() || !editUrl.trim()}
								class="btn rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
							>
								{busy ? "Saving…" : "Save changes"}
							</button>
						</div>
					</form>
				{/if}
			</div>
		</div>
	{/snippet}

	{#if loading}
		<p class="text-sm text-gray-600 dark:text-gray-400">Loading…</p>
	{:else}
		<div>
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
						Your connectors ({own.length})
					</h3>
					<p class="text-xs text-gray-600 dark:text-gray-400">
						Remote MCP servers you added. The credential is kept on the server, never in this
						browser.
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
					class="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300"
				>
					Connected.
				</p>
			{:else if outcome === "failed"}
				<p
					class="mt-3 rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300"
				>
					{outcomeDetail === "declined"
						? "The sign-in was declined."
						: `The sign-in did not complete${outcomeDetail ? ` (${outcomeDetail})` : ""}.`}
				</p>
			{/if}

			{#if failure}
				<p
					class="mt-3 rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300"
				>
					{failure}
				</p>
			{/if}

			{#if own.length === 0}
				<div
					class="mt-3 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-6 dark:border-gray-700"
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
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each own as connector (connector.id)}
						{@render connectorCard(connector)}
					{/each}
				</div>
			{/if}
		</div>

		{#if provided.length > 0}
			<!-- A different section on purpose: whose decision a connector was
			     is the first thing to know when it misbehaves, and the one
			     thing a mixed grid could not say. These rows are here to be
			     turned on and signed in to; their editing and their removal
			     are the admin screen's job, for administrators — the server
			     refuses this dialog's delete on them regardless of who calls
			     it. -->
			<div>
				<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
					Provided by your administrator ({provided.length})
				</h3>
				<p class="text-xs text-gray-600 dark:text-gray-400">
					Offered to every account. Turn one on and sign in to it as yourself; it is managed —
					changed or removed — by whoever runs {publicConfig.PUBLIC_APP_NAME}, not from here.
				</p>
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each provided as connector (connector.id)}
						{@render connectorCard(connector)}
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
