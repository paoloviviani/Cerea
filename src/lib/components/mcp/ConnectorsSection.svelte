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
	import { m } from "$lib/paraglide/messages";
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
	import Rich from "$lib/i18n/Rich.svelte";
	import ServerCardFrame from "./ServerCardFrame.svelte";
	import ServerCard from "./ServerCard.svelte";
	import { getMcpServerFaviconUrl } from "$lib/utils/favicon";
	import { allMcpServers } from "$lib/stores/mcpServers";
	import type { MCPServer } from "$lib/types/Tool";
	import ConnectorDetailSheet from "./ConnectorDetailSheet.svelte";
	import type { McpConnectorView, McpLocalView } from "$lib/types/McpConnector";
	import {
		connectors,
		connectorsLoaded,
		refreshConnectors,
		setConnectorEnabled,
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
			throw new Error(
				parsed?.message ?? m["mcp.connectors.error.generic"]({ status: response.status })
			);
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

	/** Why the last switch was refused (a connector the administrator keeps on), shown under the group. */
	let switchError = $state<string | null>(null);
	function setOn(connector: McpConnectorView, on: boolean) {
		if (connector.enabled === on) return;
		switchError = null;
		setConnectorEnabled(connector.key, on).catch((err: unknown) => {
			switchError = err instanceof Error ? err.message : m["mcp.connectors.switch_failed"]();
		});
	}

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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.add"]();
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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.sign_in_start"]();
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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.sign_in_start"]();
			busy = false;
			busyConnector = null;
		}
	}

	/** What a failed callback tells the person, by the short code it came back with. */
	function outcomeMessage(detail: string | null): string {
		switch (detail) {
			case "declined":
				return m["mcp.connectors.outcome.declined"]();
			case "expired":
				return m["mcp.connectors.outcome.expired"]();
			case "offline":
				return m["mcp.connectors.outcome.offline"]();
			case "machine":
				return m["mcp.connectors.outcome.machine"]();
			case "refused":
				return m["mcp.connectors.outcome.refused"]();
			default:
				return detail
					? m["mcp.connectors.outcome.incomplete_detail"]({ detail })
					: m["mcp.connectors.outcome.incomplete"]();
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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.save"]();
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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.save_details"]();
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
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.act"]();
		} finally {
			busy = false;
			busyConnector = null;
		}
	}

	async function remove(connector: McpConnectorView) {
		if (!confirm(m["mcp.connectors.confirm_remove"]({ name: connector.name }))) return;
		busy = true;
		try {
			await api(`/connectors/${connector.id}`, { method: "DELETE" });
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["mcp.connectors.error.remove"]();
		} finally {
			busy = false;
		}
	}
</script>

{#snippet hint(text: string)}<span class="font-normal text-gray-500">{text}</span>{/snippet}
{#snippet code(text: string)}<code class="font-mono">{text}</code>{/snippet}

<div class="space-y-3">
	{#if adding}
		<form
			class="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
			onsubmit={add}
		>
			<div class="flex flex-wrap gap-2">
				<label class="flex flex-1 flex-col gap-1">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
						>{m["mcp.connectors.name"]()}</span
					>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						placeholder={m["mcp.connectors.name_placeholder"]()}
						bind:value={name}
						required
						disabled={busy}
					/>
				</label>
				<label class="flex flex-2 flex-col gap-1" style="flex-grow:2">
					<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
						>{m["mcp.connectors.url"]()}</span
					>
					<input
						class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						placeholder={"https://mcp.notion.com/mcp"}
						bind:value={url}
						required
						disabled={busy}
					/>
				</label>
			</div>
			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
					>{m["mcp.connectors.how_to_sign_in"]()}</span
				>
				<select
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
					bind:value={authMode}
					disabled={busy}
				>
					<option value="auto">{m["mcp.connectors.mode.auto"]()}</option>
					<option value="none">{m["mcp.connectors.mode.none"]()}</option>
					<option value="token">{m["mcp.connectors.mode.token"]()}</option>
					<option value="oauth_static">{m["mcp.connectors.mode.oauth_static"]()}</option>
				</select>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{#if authMode === "auto"}
						{m["mcp.connectors.mode_hint.auto"]()}
					{:else if authMode === "oauth_static"}
						{m["mcp.connectors.mode_hint.oauth_static"]()}
					{:else if authMode === "token"}
						{m["mcp.connectors.mode_hint.token"]()}
					{:else}
						{m["mcp.connectors.mode_hint.none"]()}
					{/if}
				</span>
			</label>

			{#if authMode === "token"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-2 flex-col gap-1" style="flex-grow:2">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
							>{m["mcp.connectors.access_key"]()}</span
						>
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
							<Rich parts={m["mcp.connectors.header_optional"].parts()} tags={{ hint }} />
						</span>
						<input
							class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							placeholder={"Authorization"}
							bind:value={tokenHeader}
							disabled={busy}
						/>
					</label>
				</div>
			{:else if authMode === "oauth_static"}
				<div class="flex flex-wrap gap-2">
					<label class="flex flex-1 flex-col gap-1">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
							>{m["mcp.connectors.client_id"]()}</span
						>
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
							<Rich parts={m["mcp.connectors.client_secret_optional"].parts()} tags={{ hint }} />
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
					{m["mcp.connectors.redirect_uri_add"]()}
					<code class="rounded-sm bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{redirectUri}</code>
				</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button
					type="button"
					onclick={() => (adding = false)}
					class="btn rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
				>
					{m["mcp.connectors.cancel"]()}
				</button>
				<button
					type="submit"
					disabled={busy || !name.trim() || !url.trim()}
					class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
				>
					{busy ? m["mcp.connectors.adding"]() : m["mcp.connectors.add"]()}
				</button>
			</div>
		</form>
	{/if}

	{#snippet connectorCard(connector: McpConnectorView)}
		{#snippet connectorSwitch()}
			<Switch
				name={`use-connector-${connector.id}`}
				disabled={!connector.connected}
				bind:checked={() => connector.enabled && connector.connected, (on) => setOn(connector, on)}
			/>
		{/snippet}
		<!-- A connector the administrator keeps on has no switch: it stays on for everyone. -->
		<ServerCardFrame
			toggle={connector.mode === "locked" ? undefined : connectorSwitch}
			fixedLabel={connector.mode === "locked" ? m["mcp.card.locked"]() : undefined}
			name={connector.name}
			iconSrc={getMcpServerFaviconUrl(connector.url)}
			description={connector.url}
			toggleLabel={connector.connected
				? m["mcp.card.toggle_label"]()
				: m["mcp.connectors.sign_in_first"]()}
			toggleLabelShort={connector.connected
				? m["mcp.card.toggle_label_short"]()
				: m["mcp.connectors.sign_in_first"]()}
			toggleTitle={connector.mode === "locked"
				? m["mcp.card.locked_title"]()
				: connector.connected
					? m["mcp.connectors.on_for_new"]()
					: m["mcp.connectors.sign_in_first"]()}
			onopen={() => (detail = connector)}
		>
			{#snippet pills()}
				{#if connector.connected}
					<span
						class="inline-flex items-center gap-1 rounded-full bg-green-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-green-600 dark:bg-green-900/20 dark:text-green-400"
					>
						<IconCheckmark class="size-3" />
						{connector.auth === "none"
							? m["mcp.connectors.ready"]()
							: m["mcp.connectors.connected"]()}
					</span>
				{:else}
					<span
						class="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
					>
						<IconWarning class="size-3" />
						{m["mcp.connectors.not_signed_in"]()}
					</span>
				{/if}
				<span class="text-xs text-gray-600 dark:text-gray-400">
					{connector.auth === "oauth"
						? m["mcp.connectors.auth.oauth"]()
						: connector.auth === "token"
							? m["mcp.connectors.auth.token"]()
							: m["mcp.connectors.auth.none"]()}
				</span>
				{#if connector.registrationSource === "static"}
					<!-- Worth saying: it explains why Sign in works on a server
						     that refuses to register clients, and why a re-check
						     will not replace these credentials. -->
					<span
						class="text-xs text-gray-500 dark:text-gray-500"
						title={m["mcp.connectors.client_id_title"]({ id: connector.clientId ?? "" })}
					>
						{m["mcp.connectors.own_app"]()}
					</span>
				{/if}
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
						{m["mcp.connectors.edit"]()}
					</button>
				{/if}
				{#if connector.auth === "oauth" && !connector.connected}
					<button
						onclick={() => signIn(connector)}
						disabled={busy || !connector.canAuthorize}
						title={connector.canAuthorize
							? m["mcp.connectors.sign_in_title"]()
							: m["mcp.connectors.sign_in_blocked"]()}
						class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-[.29rem] text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
					>
						<IconLogin class="size-3" />
						{m["mcp.connectors.sign_in"]()}
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
							{m["mcp.connectors.add_app_details"]()}
						</button>
					{/if}
				{:else if connector.auth === "oauth"}
					<button
						onclick={() => act(connector, "disconnect")}
						disabled={busy}
						class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
					>
						{m["mcp.connectors.disconnect"]()}
					</button>
				{/if}
				{#if connector.manageable}
					<button
						onclick={() => act(connector, "reprobe")}
						disabled={busy}
						title={connector.auth === "token"
							? m["mcp.connectors.check_token_title"]()
							: m["mcp.connectors.check_title"]()}
						class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-[.29rem] text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300"
					>
						<IconRefresh class="size-3 {busyConnector === connector.id ? 'animate-spin' : ''}" />
						{busyConnector === connector.id
							? m["mcp.connectors.checking"]()
							: m["mcp.connectors.check"]()}
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
						{m["mcp.connectors.remove"]()}
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
						placeholder={m["mcp.connectors.client_id"]()}
						class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						bind:value={rowClientId}
						required
						disabled={busy}
					/>
					<input
						type="password"
						autocomplete="off"
						placeholder={m["mcp.connectors.client_secret_placeholder"]()}
						class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
						bind:value={rowClientSecret}
						disabled={busy}
					/>
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{m["mcp.connectors.redirect_uri_row"]()}
						<code class="rounded-sm bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{redirectUri}</code>
					</p>
					<div class="flex justify-end">
						<button
							type="submit"
							disabled={busy || !rowClientId.trim()}
							class="btn rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
						>
							{m["mcp.connectors.save"]()}
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
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
							>{m["mcp.connectors.name"]()}</span
						>
						<input
							class="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-hidden dark:border-gray-600 dark:bg-gray-900"
							bind:value={editName}
							required
							disabled={busy}
						/>
					</label>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
							>{m["mcp.connectors.url"]()}</span
						>
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
								>{connector.auth === "token"
									? m["mcp.connectors.new_access_key"]()
									: m["mcp.connectors.token"]()}
								<span class="font-normal text-gray-500"
									>{connector.auth === "token"
										? m["mcp.connectors.leave_blank"]()
										: m["mcp.connectors.if_access_key"]()}</span
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
							<span class="text-xs font-medium text-gray-700 dark:text-gray-300"
								>{m["mcp.connectors.header"]()}</span
							>
							<input
								placeholder={"Authorization"}
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
								{m["mcp.connectors.remove_saved_key"]()}
							</label>
						{/if}
					{/if}
					<p class="text-xs text-gray-500 dark:text-gray-400">
						{m["mcp.connectors.address_change"]()}
					</p>
					<div class="flex justify-end gap-2">
						<button
							type="button"
							onclick={cancelEdit}
							disabled={busy}
							class="btn rounded-lg border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
						>
							{m["mcp.connectors.cancel"]()}
						</button>
						<button
							type="submit"
							disabled={busy || !editName.trim() || !editUrl.trim()}
							class="btn rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
						>
							{busy ? m["mcp.connectors.saving"]() : m["mcp.connectors.save_changes"]()}
						</button>
					</div>
				</form>
			{/if}
		</ServerCardFrame>
	{/snippet}

	{#snippet localCard(connector: McpConnectorView, local: McpLocalView)}
		<ServerCardFrame
			name={local.server}
			machine={local.machineName}
			description={local.description ??
				m["mcp.connectors.server_description"]({ transport: local.transport })}
			toggleLabel={connector.connected
				? m["mcp.card.toggle_label"]()
				: m["mcp.connectors.unavailable"]()}
			toggleLabelShort={connector.connected
				? m["mcp.card.toggle_label_short"]()
				: m["mcp.connectors.unavailable"]()}
			toggleTitle={connector.connected
				? m["mcp.connectors.on_for_new"]()
				: m["mcp.connectors.unavailable_title"]()}
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
						{m["mcp.connectors.pill_on"]()}
					</span>
				{:else}
					<span
						data-testid="local-pill"
						class="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-2 pl-1.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-400"
					>
						<IconWarning class="size-3" />
						{local.state === "offline"
							? m["mcp.detail.state.offline"]()
							: local.state === "needs-login"
								? m["mcp.detail.state.needs_login"]()
								: local.state === "disabled"
									? m["mcp.detail.state.disabled"]()
									: m["mcp.detail.state.invalid"]()}
					</span>
				{/if}
				<span class="text-xs text-gray-600 dark:text-gray-400">{local.transport}</span>
				{#if local.allowedTools}
					<span
						class="text-xs text-gray-500 dark:text-gray-500"
						title={m["mcp.connectors.allowed_only"]({ tools: local.allowedTools.join(", ") })}
					>
						{m["mcp.connectors.tools_allowed"]({ count: local.allowedTools.length })}
					</span>
				{/if}
			{/snippet}
			{#snippet toggle()}
				<Switch
					name={`use-connector-${connector.id}`}
					disabled={!connector.connected}
					bind:checked={
						() => connector.enabled && connector.connected, (on) => setOn(connector, on)
					}
				/>
			{/snippet}

			{#if local.state === "needs-login" && local.transport === "http"}
				<p
					class="mb-2 rounded-sm bg-gray-50 px-2 py-1 text-xs wrap-break-word text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
				>
					{m["mcp.connectors.needs_sign_in_local"]({ machine: local.machineName })}
					<span class="text-gray-500 dark:text-gray-400">
						<Rich
							parts={m["mcp.connectors.needs_sign_in_help"].parts({
								command: `galopin connectors login ${local.server}`,
							})}
							tags={{ code }}
						/>
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
						title={m["mcp.connectors.sign_in_local_title"]({ machine: local.machineName })}
						class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-2.5 py-[.29rem] text-xs font-medium text-white hover:bg-blue-600 disabled:opacity-50"
					>
						<IconLogin class="size-3" />
						{m["mcp.connectors.sign_in"]()}
					</button>
				</div>
			{/if}
		</ServerCardFrame>
	{/snippet}

	{#if detail}
		<ConnectorDetailSheet connector={detail} onclose={() => (detail = null)} />
	{/if}

	{#if loading}
		<p class="text-sm text-gray-600 dark:text-gray-400">{m["mcp.connectors.loading"]()}</p>
	{:else}
		<div>
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">
						{m["mcp.connectors.yours"]({ count: own.length })}
					</h3>
					<p class="text-xs text-gray-600 dark:text-gray-400">
						{m["mcp.connectors.yours_hint"]()}
					</p>
				</div>
				<button
					type="button"
					onclick={() => (adding = !adding)}
					class="btn flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 py-1.5 pr-3 pl-2 text-sm font-medium text-white hover:bg-blue-600"
				>
					<IconAddLarge class="size-4" />
					{m["mcp.connectors.add_short"]()}
				</button>
			</div>

			{#if outcome === "connected"}
				<p
					class="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-300"
				>
					{m["mcp.connectors.outcome_connected"]()}
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

			{#if switchError}
				<p
					role="alert"
					data-testid="switch-error"
					class="mt-3 rounded-lg border border-red-500/15 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/25 dark:bg-red-900/20 dark:text-red-300"
				>
					{switchError}
				</p>
			{/if}

			{#if own.length === 0}
				<div
					class="mt-3 flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 p-6 dark:border-gray-700"
				>
					<LucidePlug class="mb-3 size-10 text-gray-400" />
					<p class="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">
						{m["mcp.connectors.none_yet"]()}
					</p>
					<p class="mb-3 text-xs text-gray-600 dark:text-gray-400">
						{m["mcp.connectors.none_hint"]()}
					</p>
					<button
						type="button"
						onclick={() => (adding = true)}
						class="btn flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600"
					>
						<IconAddLarge class="size-4" />
						{m["mcp.connectors.add_first"]()}
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
					{m["mcp.connectors.built_in"]({ count: provided.length })}
				</h3>
				<p class="text-xs text-gray-600 dark:text-gray-400">
					{m["mcp.connectors.built_in_hint"]()}
				</p>
				<div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
					{#each provided as item (item.id)}
						{#if item.kind === "base"}
							<ServerCard server={item.server} fromEnv={isAdmin} />
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
					? m["mcp.connectors.local_denied_not_configured"]()
					: m["mcp.connectors.local_denied_groups"]()}
			</p>
		{/if}

		{#if onMachines.length > 0}
			<!-- Servers on the person's own machines (ADR 0102): defined in each machine's
			     mcp.json, so nothing here is added or edited. Only the person's own are ever
			     listed. -->
			<div data-testid="local-section">
				<h3 class="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
					<LucideLaptop class="size-4" />
					{m["mcp.connectors.on_machines"]({ count: onMachines.length })}
				</h3>
				<p class="text-xs text-gray-600 dark:text-gray-400">
					<Rich parts={m["mcp.connectors.on_machines_hint"].parts()} tags={{ code }} />
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
