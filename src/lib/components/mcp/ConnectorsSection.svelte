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
	import IconAddLarge from "~icons/carbon/add-large";
	import IconCheckmark from "~icons/carbon/checkmark-filled";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconTrash from "~icons/carbon/trash-can";
	import IconRefresh from "~icons/carbon/renew";
	import IconLogin from "~icons/carbon/login";
	import IconEdit from "~icons/carbon/edit";
	import LucidePlug from "~icons/lucide/plug";
	import LucideLaptop from "~icons/lucide/laptop";
	import { startLocalSignIn } from "$lib/localConnectorsApi";
	import Switch from "$lib/components/Switch.svelte";
	import ServerCardFrame from "./ServerCardFrame.svelte";
	import ServerCard from "./ServerCard.svelte";
	import { getMcpServerFaviconUrl } from "$lib/utils/favicon";
	import { allMcpServers, selectedServerIds } from "$lib/stores/mcpServers";
	import type { MCPServer } from "$lib/types/Tool";
	import ConnectorDetailSheet from "./ConnectorDetailSheet.svelte";
	import type { McpConnectorView, McpLocalView } from "$lib/types/McpConnector";
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
	let failure = $state<string | null>(null);
	let busy = $state(false);
	/** Which connector an in-flight row action belongs to, so only its icon spins. */
	let busyConnector = $state<string | null>(null);
	let adding = $state(false);
	/** The connector whose detail sheet is open. */
	let detail = $state<McpConnectorView | null>(null);

	// Two sections, because the two kinds of connector are not the same thing
	// to the person reading the list: their own are theirs to edit and remove,
	// and the deployment's are somebody else's decision that they may use.
	// One mixed grid made an administrator's Remove button work on rows they
	// were only looking at because they administer the place (the backend
	// now refuses that regardless).
	const own = $derived($connectors.filter((c) => c.scope === "user" && !c.local));
	// One group for everything the deployment provides: the `.env` base servers and the
	// administrator's connectors read the same to a person, so they are listed together,
	// by name. Presentation only: ids and selection stay each kind's own.
	type Provided =
		| { kind: "base"; name: string; id: string; server: MCPServer }
		| { kind: "connector"; name: string; id: string; connector: McpConnectorView };
	const provided = $derived<Provided[]>(
		[
			...$allMcpServers
				.filter((s) => s.type === "base")
				.map((server): Provided => ({ kind: "base", name: server.name, id: server.id, server })),
			...$connectors
				.filter((c) => c.scope === "deployment")
				.map((connector): Provided => ({
					kind: "connector",
					name: connector.name,
					id: connector.id,
					connector,
				})),
		].sort((a, b) => a.name.localeCompare(b.name))
	);
	const isAdmin = $derived(page.data.gatewayIsAdmin === true);
	// A third kind (ADR 0102): servers on the person's own machines. Not theirs to add or edit
	// here (the machine's `mcp.json` defines them), only to use and, for an http one that asks,
	// to sign in to; the tokens stay on the machine.
	const onMachines = $derived($connectors.filter((c) => c.local));

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

	/**
	 * Sign in to a local http connector: the machine starts the OAuth flow and keeps the tokens;
	 * this only carries the browser to the provider and back, the same way a remote connector's
	 * sign-in does (a full navigation to the consent screen).
	 */
	async function signInLocal(connector: McpConnectorView) {
		busy = true;
		busyConnector = connector.id;
		failure = null;
		try {
			// Back to this very page, minus the previous outcome, so the result shows here.
			const back = new URL(page.url);
			for (const key of ["mcp", "mcpDetail", "mcpConnector"]) back.searchParams.delete(key);
			window.location.href = await startLocalSignIn(connector.id, `${back.pathname}${back.search}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start the sign-in.";
			busy = false;
			busyConnector = null;
		}
	}

	/** What a failed callback tells the person, by the short code it came back with. */
	function outcomeMessage(detail: string | null): string {
		switch (detail) {
			case "declined":
				return "The sign-in was declined.";
			case "expired":
				return "That sign-in expired, was already used, or was started somewhere else. Try again.";
			case "offline":
				return "The machine went offline before the sign-in finished. Start galopin there and try again.";
			case "machine":
				return "The machine could not finish the sign-in. Its log says why.";
			case "refused":
				return "That server does not need a sign-in, or cannot be signed in to from here.";
			default:
				return `The sign-in did not complete${detail ? ` (${detail})` : ""}.`;
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
		busyConnector = connector.id;
		failure = null;
		try {
			await api(`/connectors/${connector.id}`, json({ action }));
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : "That did not work.";
		} finally {
			busy = false;
			busyConnector = null;
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
		<ServerCardFrame
			active={connector.connected}
			name={connector.name}
			iconSrc={getMcpServerFaviconUrl(connector.url)}
			description={connector.url}
			toggleLabel={connector.connected ? "On by default in new chats" : "Sign in first"}
			toggleLabelShort={connector.connected ? "Default in new chats" : "Sign in first"}
			toggleTitle={connector.connected ? "On for new chats" : "Sign in first"}
			onopen={() => (detail = connector)}
		>
			{#snippet pills()}
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
					{connector.auth === "oauth" ? "OAuth" : connector.auth === "token" ? "token" : "no auth"}
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
			{/snippet}
			{#snippet toggle()}
				<Switch
					name={`use-connector-${connector.id}`}
					disabled={!connector.connected}
					bind:checked={
						() => $defaultConnectorIds.has(connector.id), () => toggleDefaultConnector(connector.id)
					}
				/>
			{/snippet}

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
						<IconRefresh class="size-3 {busyConnector === connector.id ? 'animate-spin' : ''}" />
						{busyConnector === connector.id ? "Checking…" : "Check"}
					</button>
				{/if}
				{#if connector.scope === "user" && !connector.local}
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
		</ServerCardFrame>
	{/snippet}

	{#snippet localCard(connector: McpConnectorView, local: McpLocalView)}
		<ServerCardFrame
			active={connector.connected}
			name={local.server}
			machine={local.machineName}
			description={local.description ?? `${local.transport} server`}
			toggleLabel={connector.connected ? "On by default in new chats" : "Unavailable"}
			toggleLabelShort={connector.connected ? "Default in new chats" : "Unavailable"}
			toggleTitle={connector.connected ? "On for new chats" : "Not available right now"}
			testid="local-connector"
			onopen={() => (detail = connector)}
		>
			{#snippet pills()}
				{#if local.state === "ready"}
					<span
						data-testid="local-pill"
						class="inline-flex items-center gap-1 rounded-full bg-green-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-green-600 dark:bg-green-900/20 dark:text-green-400"
					>
						<IconCheckmark class="size-3" />
						on
					</span>
				{:else}
					<span
						data-testid="local-pill"
						class="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
					>
						<IconWarning class="size-3" />
						{local.state === "offline"
							? "Offline"
							: local.state === "needs-login"
								? "Needs sign-in"
								: local.state === "disabled"
									? "Disabled"
									: "Invalid"}
					</span>
				{/if}
				<span class="text-xs text-gray-600 dark:text-gray-400">{local.transport}</span>
				{#if local.allowedTools}
					<span
						class="text-xs text-gray-500 dark:text-gray-500"
						title={`The machine allows only: ${local.allowedTools.join(", ")}`}
					>
						{local.allowedTools.length} tool{local.allowedTools.length === 1 ? "" : "s"} allowed
					</span>
				{/if}
			{/snippet}
			{#snippet toggle()}
				<Switch
					name={`use-connector-${connector.id}`}
					disabled={!connector.connected}
					bind:checked={
						() => $defaultConnectorIds.has(connector.id), () => toggleDefaultConnector(connector.id)
					}
				/>
			{/snippet}

			{#if local.state === "needs-login" && local.transport === "http"}
				<p
					class="mb-2 rounded-sm bg-gray-50 px-2 py-1 text-xs wrap-break-word text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
				>
					Needs a sign-in; the tokens stay on {local.machineName}.
					<span class="text-gray-500 dark:text-gray-400">
						If the provider refuses the redirect, run
						<code class="font-mono">galopin connectors login {local.server}</code> on the machine.
					</span>
				</p>
			{:else if local.state !== "ready" && local.detail}
				<p
					class="mb-2 line-clamp-3 rounded-sm bg-gray-50 px-2 py-1 text-xs wrap-break-word text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
				>
					{local.detail}
				</p>
			{/if}

			{#if local.state === "needs-login" && local.transport === "http"}
				<div class="flex flex-wrap gap-1">
					<button
						onclick={() => signInLocal(connector)}
						disabled={busy}
						title="Sign in to this server; the tokens stay on {local.machineName}"
						class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-[.29rem] text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
					>
						<IconLogin class="size-3" />
						Sign in
					</button>
				</div>
			{/if}
		</ServerCardFrame>
	{/snippet}

	{#if detail}
		<ConnectorDetailSheet connector={detail} onclose={() => (detail = null)} />
	{/if}

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
					{outcomeMessage(outcomeDetail)}
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
			<!-- Whose decision these are is the first thing to know when one
			     misbehaves, so they are a group of their own, apart from the person's
			     connectors. Rows are here to be turned on and signed in to; editing
			     and removal are the admin screen's job (the server refuses this
			     dialog's delete on a connector regardless of who calls it), and a
			     `.env` server is edited in `.env`. -->
			<div data-testid="provided-section">
				<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
					Provided by this deployment ({provided.length})
				</h3>
				<p class="text-xs text-gray-600 dark:text-gray-400">
					Offered to every account. Turn one on and, where it asks, sign in to it as yourself; they
					are managed by whoever runs this deployment, not from here.
				</p>
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each provided as item (item.id)}
						{#if item.kind === "base"}
							<ServerCard
								server={item.server}
								isSelected={$selectedServerIds.has(item.server.id)}
								fromEnv={isAdmin}
							/>
						{:else}
							{@render connectorCard(item.connector)}
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		{#if page.data.localConnectorsDenied}
			<p class="text-xs text-gray-600 dark:text-gray-400" data-testid="local-denied-note">
				{page.data.localConnectorsDenied === "not_configured"
					? "This gateway is not configured for the chat, so local connectors are unavailable."
					: "Your administrator has not enabled local connectors for your groups."}
			</p>
		{/if}

		{#if onMachines.length > 0}
			<!-- Servers on the person's own machines (ADR 0102): defined in each machine's
			     mcp.json, so nothing here is added or edited. Only the person's own are ever
			     listed. -->
			<div data-testid="local-section">
				<h3 class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
					<LucideLaptop class="size-4" />
					On your machines ({onMachines.length})
				</h3>
				<p class="text-xs text-gray-600 dark:text-gray-400">
					MCP servers running on machines you connected. Used while the machine is connected;
					managed in the machine's <code class="font-mono">mcp.json</code> and under Local connectors.
				</p>
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each onMachines as connector (connector.id)}
						{#if connector.local}
							{@render localCard(connector, connector.local)}
						{/if}
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
