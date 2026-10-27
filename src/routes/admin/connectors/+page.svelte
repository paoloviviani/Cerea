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
	import IconEdit from "~icons/carbon/edit";
	import IconRefresh from "~icons/carbon/renew";
	import ConnectorTools from "$lib/components/mcp/ConnectorTools.svelte";
	import { credentialLikeParams } from "$lib/utils/connectorUrl";
	import type { ConnectorMode, McpConnectorView } from "$lib/types/McpConnector";
	import type { MCPServer, MCPTool } from "$lib/types/Tool";
	import Switch from "$lib/components/Switch.svelte";

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
	let description = $state("");

	/** The connector being edited, and what is in its form. */
	let editing = $state<McpConnectorView | null>(null);
	let editName = $state("");
	let editUrl = $state("");
	let editDescription = $state("");
	let editToken = $state("");
	let editTokenHeader = $state("");
	let clearEditToken = $state(false);
	/** Which connector's tool check is running. */
	let checking = $state<string | null>(null);
	/** Which OAuth connector has its app details (client id and secret) form open. */
	let detailsFor = $state<string | null>(null);
	let rowClientId = $state("");
	let rowClientSecret = $state("");
	// Shown so somebody registering a client by hand can copy it: the same value the server derives.
	const redirectUri = $derived(
		typeof window === "undefined" ? "" : `${window.location.origin}${base}/mcp/callback`
	);
	/** Query parameters of the address being typed that look like a key. */
	const addUrlSecrets = $derived(credentialLikeParams(url.trim()));
	const editUrlSecrets = $derived(credentialLikeParams(editUrl.trim()));

	// The servers `.env` (`MCP_SERVERS`) defines, with how the deployment offers each
	// (ADR 0104). Their address and key are edited in `.env`; their mode is set here.
	let envList = $state<MCPServer[]>([]);
	const envServers = $derived(
		envList
			.map((server) => ({ ...server, ...(checks[server.id] ?? {}) }))
			.sort((a, b) => a.name.localeCompare(b.name))
	);
	/** What the Check button last found, by server id. */
	let checks = $state<
		Record<string, { status?: MCPServer["status"]; tools?: MCPTool[]; errorMessage?: string }>
	>({});

	async function check(server: MCPServer) {
		checks[server.id] = { status: "connecting" };
		try {
			const response = await fetch(`${base}/api/mcp/health`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: server.url }),
			});
			const result = (await response.json()) as {
				ready?: boolean;
				tools?: MCPTool[];
				error?: string;
			};
			checks[server.id] =
				result.ready && result.tools
					? { status: "connected", tools: result.tools }
					: { status: "error", errorMessage: result.error };
		} catch (err) {
			checks[server.id] = {
				status: "error",
				errorMessage: err instanceof Error ? err.message : undefined,
			};
		}
	}

	const MODES: ConnectorMode[] = ["off", "on", "locked"];
	// Spelled out rather than built from the mode, so each message can be found and translated.
	const modeLabel = (mode: ConnectorMode): string =>
		mode === "off"
			? m["admin.connectors.mode.off"]()
			: mode === "locked"
				? m["admin.connectors.mode.locked"]()
				: m["admin.connectors.mode.on"]();
	const modeHint = (mode: ConnectorMode): string =>
		mode === "off"
			? m["admin.connectors.mode.off_hint"]()
			: mode === "locked"
				? m["admin.connectors.mode.locked_hint"]()
				: m["admin.connectors.mode.on_hint"]();

	/**
	 * Change how one connector is offered, shown at once and put back if refused. `target` is a
	 * `.env` server (by name) or an administrator's connector (by id).
	 */
	async function setPolicy(
		target: { kind: "base"; name: string } | { kind: "connector"; id: string },
		change: { mode?: ConnectorMode; alwaysLoaded?: boolean }
	) {
		const beforeEnv = envList;
		const beforeShared = connectors;
		const apply = <T extends { mode?: ConnectorMode; alwaysLoaded?: boolean }>(row: T): T => ({
			...row,
			...(change.mode !== undefined ? { mode: change.mode } : {}),
			...(change.alwaysLoaded !== undefined ? { alwaysLoaded: change.alwaysLoaded } : {}),
		});
		if (target.kind === "base") {
			envList = envList.map((row) => (row.name === target.name ? apply(row) : row));
		} else {
			connectors = connectors.map((row) => (row.id === target.id ? apply(row) : row));
		}
		failure = null;
		try {
			const response = await fetch(`${base}/api/v2/admin/connector-modes`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...target, ...change }),
			});
			if (!response.ok) throw new Error(m["admin.connectors.mode.save_failed"]());
		} catch (err) {
			envList = beforeEnv;
			connectors = beforeShared;
			failure = err instanceof Error ? err.message : m["admin.connectors.mode.save_failed"]();
		}
	}

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
			// `admin=1` lists the connectors that are switched off too, and each one's always-loaded flag.
			connectors = (await api<{ data: McpConnectorView[] }>("/connectors?admin=1")).data;
			const env = await fetch(`${base}/api/mcp/servers?admin=1`);
			if (env.ok) envList = (await env.json()) as MCPServer[];
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
					...(description.trim() ? { description: description.trim() } : {}),
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
			description = "";
			authMode = "auto";
			adding = false;
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.add_failed"]();
		} finally {
			busy = false;
		}
	}

	// `?scope=deployment` says this is the administrator's screen: the same routes serve
	// Workspace, where a connector the deployment provides cannot be changed by anyone.
	const asDeployment = (id: string) => `/connectors/${id}?scope=deployment`;

	function beginEdit(connector: McpConnectorView) {
		editing = connector;
		editName = connector.name;
		editUrl = connector.url;
		editDescription = connector.description ?? "";
		editToken = "";
		editTokenHeader = connector.tokenHeader ?? "";
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
		const target = editing;
		if (!target || !editName.trim() || !editUrl.trim()) return;
		busy = true;
		failure = null;
		try {
			const header = editTokenHeader.trim();
			await api(asDeployment(target.id), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "update",
					name: editName.trim(),
					url: editUrl.trim(),
					// Always sent: an empty one clears it.
					description: editDescription.trim(),
					...(editToken.trim()
						? {
								token: editToken.trim(),
								...(header
									? {
											tokenHeader: header,
											tokenPrefix: /^authorization$/i.test(header) ? "Bearer " : "",
										}
									: {}),
							}
						: {}),
					...(clearEditToken ? { clearToken: true } : {}),
				}),
			});
			cancelEdit();
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.edit_failed"]();
		} finally {
			busy = false;
		}
	}

	/** Register the OAuth client id (and secret) a provider without self-registration gave you. */
	async function saveDetails(event: SubmitEvent, connector: McpConnectorView) {
		event.preventDefault();
		if (!rowClientId.trim()) return;
		busy = true;
		failure = null;
		try {
			await api(asDeployment(connector.id), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "update",
					clientId: rowClientId.trim(),
					...(rowClientSecret.trim() ? { clientSecret: rowClientSecret.trim() } : {}),
				}),
			});
			rowClientId = "";
			rowClientSecret = "";
			detailsFor = null;
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.edit_failed"]();
		} finally {
			busy = false;
		}
	}

	/**
	 * Check one connector. A shared-key or open one lists its tools again with its own key;
	 * an OAuth one is asked again how it signs people in (`reprobe`), which is what repairs a
	 * connector whose address changed or whose provider moved.
	 */
	async function recheck(connector: McpConnectorView, action: "check" | "reprobe" = "check") {
		checking = connector.id;
		failure = null;
		try {
			await api(asDeployment(connector.id), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action }),
			});
			await load();
		} catch (err) {
			failure = err instanceof Error ? err.message : m["admin.connectors.check_failed"]();
		} finally {
			checking = null;
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

<!-- An address with a key in it is shown to nobody but you, but it is still stored in the clear. -->
{#snippet urlWarning(names: string[])}
	<p
		role="alert"
		data-testid="url-secret-warning"
		class="rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
	>
		{m["admin.connectors.form.url_secret_warning"]({ names: names.join(", ") })}
	</p>
{/snippet}

<!--
	How one connector is offered: off, on, or on and locked, and whether the assistant has it
	loaded from the start. One line says what the chosen mode means.
-->
{#snippet policyControl(
	id: string,
	mode: ConnectorMode | undefined,
	alwaysLoaded: boolean | undefined,
	label: string,
	onmode: (mode: ConnectorMode) => void,
	onloaded: (on: boolean) => void
)}
	{@const current = mode ?? "on"}
	<div class="mt-3 flex flex-col gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs font-medium">{m["admin.connectors.mode.label"]()}</span>
			<div
				role="radiogroup"
				aria-label={label}
				class="inline-flex overflow-clip rounded-lg border border-gray-200 dark:border-gray-600"
			>
				{#each MODES as option (option)}
					<!--
						`relative` keeps the hidden radio inside its label. Unpositioned, the
						`sr-only` input's containing block was the page's fixed, clipping shell:
						tapping an option focused it, and the browser scrolled that shell (which
						overflow-hidden does not forbid) to reveal it, shifting the whole page up.
					-->
					<label
						class="relative cursor-pointer px-2.5 py-1 text-xs font-medium has-[:focus-visible]:outline-2 {current ===
						option
							? 'bg-blue-600 text-white'
							: 'bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300'}"
					>
						<input
							type="radio"
							class="sr-only"
							name={`mode-${id}`}
							value={option}
							checked={current === option}
							onchange={() => onmode(option)}
						/>
						{modeLabel(option)}
					</label>
				{/each}
			</div>
		</div>
		<p class="text-xs text-gray-500 dark:text-gray-400" data-testid="mode-hint">
			{modeHint(current)}
		</p>
		{#if current !== "off"}
			<div class="flex items-center gap-2">
				<Switch name={`loaded-${id}`} bind:checked={() => alwaysLoaded === true, onloaded} />
				<span class="text-xs font-medium">{m["admin.connectors.mode.always_loaded"]()}</span>
			</div>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				{m["admin.connectors.mode.always_loaded_hint"]()}
			</p>
		{/if}
	</div>
{/snippet}

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
			{#if addUrlSecrets.length > 0}
				{@render urlWarning(addUrlSecrets)}
			{/if}

			<label class="flex flex-col gap-1">
				<span class="text-xs font-medium"
					>{m["admin.connectors.form.description"]()}
					<span class="font-normal text-gray-500">{m["admin.connectors.form.optional"]()}</span
					></span
				>
				<input
					class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
					placeholder={m["admin.connectors.form.description_placeholder"]()}
					maxlength="300"
					bind:value={description}
					disabled={busy}
				/>
				<span class="text-xs text-gray-500 dark:text-gray-400">
					{m["admin.connectors.form.description_hint"]()}
				</span>
			</label>

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

			<p class="text-xs text-gray-500 dark:text-gray-400">
				{m["admin.connectors.form.add_hint"]()}
			</p>

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
						class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
					>
						<div
							class="flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch"
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
									onclick={() => check(server)}
									disabled={server.status === "connecting"}
									class="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
								>
									{m["admin.connectors.env.check"]()}
								</button>
							</div>
						</div>
						{@render policyControl(
							server.id,
							server.mode,
							server.alwaysLoaded,
							server.name,
							(mode) => setPolicy({ kind: "base", name: server.name }, { mode }),
							(alwaysLoaded) => setPolicy({ kind: "base", name: server.name }, { alwaysLoaded })
						)}
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
					data-testid="shared-connector"
					class="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
				>
					<div class="flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
						<div class="min-w-0">
							<p class="truncate text-sm font-medium">{connector.name}</p>
							<p class="truncate text-xs text-gray-500 dark:text-gray-400" title={connector.url}>
								{connector.url}
							</p>
							{#if connector.description}
								<p class="mt-1 text-xs text-gray-600 dark:text-gray-300">
									{connector.description}
								</p>
							{/if}
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
							<ConnectorTools {connector} />
							{#if connector.manageable}
								<button
									type="button"
									onclick={() => beginEdit(connector)}
									disabled={busy}
									class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
								>
									<IconEdit class="size-3" />
									{m["admin.connectors.edit"]()}
								</button>
								{#if connector.auth === "oauth"}
									<!-- Asks the server again how it signs people in: the repair for a changed address. -->
									<button
										type="button"
										onclick={() => recheck(connector, "reprobe")}
										disabled={busy || checking !== null}
										title={m["admin.connectors.recheck_title"]()}
										class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
									>
										{m["admin.connectors.recheck"]()}
									</button>
									{#if !connector.canAuthorize}
										<button
											type="button"
											onclick={() =>
												(detailsFor = detailsFor === connector.id ? null : connector.id)}
											disabled={busy}
											class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
										>
											{m["mcp.connectors.add_app_details"]()}
										</button>
									{/if}
								{/if}
								<button
									type="button"
									onclick={() => recheck(connector)}
									disabled={busy || checking !== null}
									title={m["admin.connectors.check_title"]()}
									class="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
								>
									<IconRefresh class="size-3 {checking === connector.id ? 'animate-spin' : ''}" />
									{checking === connector.id
										? m["admin.connectors.checking"]()
										: m["admin.connectors.check"]()}
								</button>
							{/if}
							<button
								onclick={() => remove(connector)}
								disabled={busy}
								class="flex items-center gap-1.5 rounded-lg border border-red-500/15 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 disabled:opacity-50 dark:border-red-500/25 dark:bg-red-900/30 dark:text-red-400"
							>
								<IconTrash class="size-3" />
								{m["admin.connectors.remove"]()}
							</button>
						</div>
					</div>
					<ConnectorTools {connector} list />
					{#if detailsFor === connector.id}
						<form
							data-testid="app-details"
							class="mt-3 space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
							onsubmit={(event) => saveDetails(event, connector)}
						>
							<input
								autocomplete="off"
								aria-label={m["mcp.connectors.client_id"]()}
								placeholder={m["mcp.connectors.client_id"]()}
								class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
								bind:value={rowClientId}
								required
								disabled={busy}
							/>
							<input
								type="password"
								autocomplete="off"
								aria-label={m["mcp.connectors.client_secret_placeholder"]()}
								placeholder={m["mcp.connectors.client_secret_placeholder"]()}
								class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
								bind:value={rowClientSecret}
								disabled={busy}
							/>
							<p class="text-xs text-gray-500 dark:text-gray-400">
								{m["mcp.connectors.redirect_uri_row"]()}
								<code class="rounded-sm bg-gray-100 px-1 py-0.5 break-all dark:bg-gray-800"
									>{redirectUri}</code
								>
							</p>
							<div class="flex justify-end">
								<button
									type="submit"
									disabled={busy || !rowClientId.trim()}
									class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
								>
									{m["mcp.connectors.save"]()}
								</button>
							</div>
						</form>
					{/if}
					{#if editing?.id === connector.id}
						<form
							data-testid="edit-connector"
							class="mt-3 space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
							onsubmit={saveEdit}
						>
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium">{m["admin.connectors.form.name"]()}</span>
								<input
									class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
									bind:value={editName}
									required
									disabled={busy}
								/>
							</label>
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium">{m["admin.connectors.form.url"]()}</span>
								<input
									type="url"
									class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
									bind:value={editUrl}
									required
									disabled={busy}
								/>
								{#if editUrlSecrets.length > 0}
									{@render urlWarning(editUrlSecrets)}
								{/if}
							</label>
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium"
									>{m["admin.connectors.form.description"]()}
									<span class="font-normal text-gray-500"
										>{m["admin.connectors.form.optional"]()}</span
									></span
								>
								<input
									class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
									placeholder={m["admin.connectors.form.description_placeholder"]()}
									maxlength="300"
									bind:value={editDescription}
									disabled={busy}
								/>
								<span class="text-xs text-gray-500 dark:text-gray-400">
									{m["admin.connectors.form.description_hint"]()}
								</span>
							</label>
							{#if connector.auth !== "oauth"}
								<!-- A shared key belongs to the connector; an OAuth one is each person's own. -->
								<div class="flex flex-wrap gap-2">
									<label class="flex min-w-48 flex-2 flex-col gap-1" style="flex-grow:2">
										<span class="text-xs font-medium"
											>{m["admin.connectors.form.new_token"]()}
											<span class="font-normal text-gray-500"
												>{connector.auth === "token"
													? m["admin.connectors.form.leave_blank"]()
													: m["admin.connectors.form.optional"]()}</span
											></span
										>
										<input
											type="password"
											autocomplete="off"
											class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
											bind:value={editToken}
											disabled={busy}
										/>
									</label>
									<label class="flex min-w-32 flex-1 flex-col gap-1">
										<span class="text-xs font-medium">{m["admin.connectors.form.header"]()}</span>
										<input
											class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
											placeholder={EXAMPLE_HEADER}
											bind:value={editTokenHeader}
											disabled={busy || !editToken.trim()}
										/>
									</label>
								</div>
								{#if connector.auth === "token"}
									<label class="flex items-center gap-2 text-xs">
										<input
											type="checkbox"
											bind:checked={clearEditToken}
											disabled={busy || !!editToken.trim()}
										/>
										{m["admin.connectors.form.remove_key"]()}
									</label>
								{/if}
							{/if}
							<p class="text-xs text-gray-500 dark:text-gray-400">
								{m["admin.connectors.form.edit_hint"]()}
							</p>
							<div class="flex justify-end gap-2">
								<button
									type="button"
									onclick={cancelEdit}
									disabled={busy}
									class="btn rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
								>
									{m["admin.connectors.form.cancel"]()}
								</button>
								<button
									type="submit"
									disabled={busy || !editName.trim() || !editUrl.trim()}
									class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
								>
									{busy ? m["admin.connectors.form.saving"]() : m["admin.connectors.form.save"]()}
								</button>
							</div>
						</form>
					{/if}
					{@render policyControl(
						connector.id,
						connector.mode,
						connector.alwaysLoaded,
						connector.name,
						(mode) => setPolicy({ kind: "connector", id: connector.id }, { mode }),
						(alwaysLoaded) => setPolicy({ kind: "connector", id: connector.id }, { alwaysLoaded })
					)}
				</li>
			{/each}
		</ul>
	{/if}
</section>
