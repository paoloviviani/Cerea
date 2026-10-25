<!--
	The Local connectors tab of the workspace (ADR 0102): MCP servers that run on the
	person's own machines, offered to their chat over the machine link.

	Three jobs, in the order a person meets them. **Connect a machine**: the complete how-to
	(install galopin from this deployment, enroll it as a connectors machine, run it, write
	`mcp.json`), shown in full while there is no paired machine and folded behind "Add a machine"
	once there is one. **Approve it**: a machine that checked in waits here, in `pending`; nothing
	it offers reaches a chat until the person approves (the same fresh human confirmation the
	Agents panel asks for a coding agent). **See what it offers**: each paired machine with its
	servers and their states, and a revoke.

	The servers themselves are used from the MCP panel and the composer; a machine never appears
	in the Agents panel.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import * as s from "$lib/components/overlay/styles";
	import CopyToClipBoardBtn from "$lib/components/CopyToClipBoardBtn.svelte";
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { onAppResume } from "$lib/utils/appResume";
	import { buildConnectorsCommands } from "$lib/codeEnrollCommand";
	import {
		LocalConnectorsApiError,
		confirmLocalMachine,
		listLocalMachines,
		revokeLocalMachine,
		startLocalSignIn,
	} from "$lib/localConnectorsApi";
	import type { LocalMachineView, LocalServerView } from "$lib/types/LocalConnectors";
	import IconLaptop from "~icons/carbon/laptop";
	import IconWarning from "~icons/carbon/warning-filled";
	import IconCheck from "~icons/carbon/checkmark";
	import IconClose from "~icons/carbon/close";
	import IconTrash from "~icons/carbon/trash-can";
	import LucidePlug from "~icons/lucide/plug";

	/** The page that explains all of this, for the "more" link. */
	const DOCS_URL = "https://paoloviviani.github.io/Cerea/local-connectors/";
	const POLL_MS = 8000;

	const publicConfig = usePublicConfig();
	const origin = $derived(publicConfig.origin);
	/** What the sentence calls this deployment: its name, else the host the machine dials. */
	const deploymentName = $derived.by(() => {
		if (publicConfig.PUBLIC_APP_NAME) return publicConfig.PUBLIC_APP_NAME;
		try {
			return new URL(origin || page.url.origin).host;
		} catch {
			return page.url.host;
		}
	});
	const commands = $derived(
		buildConnectorsCommands({
			origin,
			issuer: page.data.codeOidcIssuerUrl ?? "",
			clientId: page.data.codeOidcClientId,
		})
	);

	/** Pystino's `local_connectors` capability, per person (layout data): null when granted. */
	const denied = $derived<"not_granted" | "not_configured" | null>(
		page.data.localConnectorsDenied ?? null
	);

	let machines = $state<LocalMachineView[]>([]);
	let loading = $state(true);
	let failure = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let needsFreshSignIn = $state(false);
	let signingIn = $state<string | null>(null);

	/** Chat-side sign-in for a local http server: carries the browser to the provider and back. */
	async function signIn(server: LocalServerView) {
		signingIn = server.id;
		failure = null;
		try {
			const back = new URL(page.url);
			for (const key of ["mcp", "mcpDetail", "mcpConnector"]) back.searchParams.delete(key);
			window.location.href = await startLocalSignIn(server.id, `${back.pathname}${back.search}`);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not start the sign-in.";
			signingIn = null;
		}
	}

	const pending = $derived(machines.filter((m) => m.status === "pending"));
	const paired = $derived(machines.filter((m) => m.status === "paired"));
	/** The how-to is the page until a connectors machine is paired. */
	const hasMachine = $derived(paired.some((m) => m.mode === "connectors"));
	let showAdd = $state(false);

	let epoch = 0;
	async function refresh() {
		const mine = ++epoch;
		try {
			const list = await listLocalMachines();
			if (mine === epoch) {
				machines = list;
				failure = null;
			}
		} catch (err) {
			if (mine === epoch) failure = err instanceof Error ? err.message : "Could not load machines.";
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), POLL_MS);
		const stopResume = onAppResume(() => void refresh());
		return () => {
			clearInterval(timer);
			stopResume();
		};
	});

	async function approve(machine: LocalMachineView) {
		busy = machine.id;
		failure = null;
		needsFreshSignIn = false;
		try {
			await confirmLocalMachine(machine.id);
			await refresh();
		} catch (err) {
			if (err instanceof LocalConnectorsApiError && err.code === "reauth_required") {
				needsFreshSignIn = true;
			} else {
				failure = err instanceof Error ? err.message : "Could not approve the machine.";
			}
		} finally {
			busy = null;
		}
	}

	async function remove(machine: LocalMachineView, verb: "Reject" | "Revoke") {
		if (
			verb === "Revoke" &&
			!confirm(`Revoke “${machine.name}”? Its servers leave your chats; it must be enrolled again.`)
		) {
			return;
		}
		busy = machine.id;
		failure = null;
		try {
			await revokeLocalMachine(machine.id);
			machines = machines.filter((m) => m.id !== machine.id);
			void refresh();
		} catch (err) {
			failure = err instanceof Error ? err.message : `Could not ${verb.toLowerCase()} the machine.`;
		} finally {
			busy = null;
		}
	}

	const reauthHref = $derived(`${base}/login?reauth=1&next=${base}/workspace?tab=local`);

	/** One word for a server's state, and the pill tone it takes. */
	function stateOf(server: LocalServerView): { label: string; tone: s.PillTone } {
		switch (server.state) {
			case "ready":
				return { label: "Ready", tone: "good" };
			case "needs-login":
				return { label: "Needs sign-in", tone: "busy" };
			case "disabled":
				return { label: "Disabled", tone: "neutral" };
			case "offline":
				return { label: "Offline", tone: "neutral" };
			default:
				return { label: "Invalid", tone: "bad" };
		}
	}

	const MCP_JSON = `{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"],
      "env": { "LOG_LEVEL": "warn" },
      "description": "My notes folder",
      "allowedTools": ["read_file", "list_directory"]
    },
    "crm": {
      "type": "http",
      "url": "http://127.0.0.1:9000/mcp",
      "headers": { "Authorization": "Bearer \${CRM_TOKEN}" }
    }
  }
}`;

	const SERVICE_UNIT = `[Unit]
Description=galopin: this machine's local connectors
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/galopin run
# Another connectors file: ExecStart=%h/.local/bin/galopin run --mcp-config /path/to/file.json
Restart=on-failure
RestartSec=10
# 78 means this machine was revoked: restarting cannot fix it.
RestartPreventExitStatus=78
# Add the directories your servers' commands live in (npx, uvx, your own).
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target`;

	const SERVICE_COMMANDS = `mkdir -p ~/.config/systemd/user
# save the unit above as ~/.config/systemd/user/galopin.service, then:
systemctl --user daemon-reload
systemctl --user enable --now galopin
loginctl enable-linger "$USER"`;
</script>

{#snippet code(text: string, testid?: string)}
	<div class="flex items-center gap-2 rounded-lg border border-line bg-surface p-3">
		<pre
			class="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre text-ink"
			data-testid={testid}>{text}</pre>
		<CopyToClipBoardBtn
			classNames="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted hover:bg-sunken"
			value={text}
		/>
	</div>
{/snippet}

{#snippet step(n: number, title: string)}
	<p class="{s.LABEL} mt-5 mb-2 flex items-center gap-2">
		<span
			class="flex size-5 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent"
			>{n}</span
		>
		{title}
	</p>
{/snippet}

{#snippet instructions()}
	<div class="rounded-2xl border border-line bg-surface p-4 sm:p-6" data-testid="local-howto">
		<div class="flex items-start gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<LucidePlug class="size-5 text-accent" />
			</div>
			<div class="min-w-0">
				<h3 class="{s.CARD_TITLE} leading-10 !whitespace-normal">Connect a machine</h3>
				<p class="{s.SUBTITLE} mt-1 break-words">
					Run an MCP server on your own machine (a notes folder, a database, a tool on a private
					network) and use it from your chats. Nothing is opened to the internet: the machine dials
					out to {deploymentName}.
				</p>
			</div>
		</div>

		{@render step(1, "Install galopin on that machine")}
		{@render code(commands.install, "local-install-command")}
		<p class="mt-1 text-xs text-ink-muted">
			The installer comes from this deployment and puts <code class="font-mono">galopin</code> in
			<code class="font-mono">~/.local/bin</code>.
		</p>

		{@render step(2, "Enroll it as a connectors machine")}
		{@render code(commands.enroll, "local-enroll-command")}
		<p class="mt-1 text-xs text-ink-muted">
			Opens your browser to sign in with this deployment's identity provider (or prints a link and
			code for another device). A connectors machine needs no coding agent, no opencode and no
			billing group.
		</p>

		{@render step(3, "Sign in to Cerea in your browser once before running galopin")}
		<p class="mt-1 text-xs text-ink-muted">
			Open this chat and sign in with the same account. Cerea only accepts a machine for an account
			it has seen, so <code class="font-mono">galopin run</code> is refused (403) until you have.
		</p>

		{@render step(4, "Run it")}
		{@render code(commands.run, "local-run-command")}
		<details class="mt-2 text-xs text-ink-muted">
			<summary class="cursor-pointer">Keep it running as a service (Linux)</summary>
			<div class="mt-2 space-y-2">
				<p>
					Stop the copy you started by hand, save this as
					<code class="font-mono">~/.config/systemd/user/galopin.service</code>, then start it:
				</p>
				{@render code(SERVICE_UNIT)}
				{@render code(SERVICE_COMMANDS)}
				<p>
					A service does not read your shell profile: put the directories your servers' commands
					need in <code class="font-mono">PATH</code> and any
					<code class="font-mono">$&#123;VAR&#125;</code>
					an entry uses in the unit's <code class="font-mono">Environment=</code>. On macOS use the
					launchd file <code class="font-mono">org.cerea.galopin.plist</code> from the Cerea
					repository's
					<code class="font-mono">agent/packaging/</code>.
				</p>
			</div>
		</details>

		{@render step(5, "List the servers it offers in mcp.json")}
		<p class="mb-2 text-xs text-ink-muted">
			The file is in galopin's config directory, next to
			<code class="font-mono">credentials.json</code>:
			<code class="font-mono">~/.config/galopin/mcp.json</code> on Linux,
			<code class="font-mono">~/Library/Application Support/galopin/mcp.json</code> on macOS. It is
			the format Claude Desktop and Claude Code use, so an existing file can be copied as is, or
			point galopin at another file:
			<code class="font-mono">galopin run --mcp-config /path/to/claude_desktop_config.json</code>
		</p>
		{@render code(MCP_JSON, "local-mcp-json")}
		<ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
			<li>
				<code class="font-mono">command</code> starts a <strong>stdio</strong> server;
				<code class="font-mono">"type": "http"</code> with a <code class="font-mono">url</code>
				reaches an <strong>http</strong> one (headers and
				<code class="font-mono">$&#123;VAR&#125;</code> from the machine's environment work as in Claude
				Code).
			</li>
			<li>
				<code class="font-mono">allowedTools</code> is the machine's ceiling: only those tools are offered
				and any other call is refused on the machine, whatever the chat asks. Leave it out to offer every
				tool.
			</li>
			<li>
				<code class="font-mono">description</code> and
				<code class="font-mono">disabled: true</code> are shown here and in the MCP panel; Claude ignores
				them.
			</li>
			<li>
				Edits are picked up without a restart. A server that asks for OAuth is signed in from the
				MCP panel; its tokens stay on the machine.
			</li>
		</ul>

		{@render step(6, "Approve the machine below")}
		<p class="text-xs text-ink-muted">
			It appears under <em>Waiting for approval</em> as soon as it checks in. After you approve it,
			its servers show in the MCP panel and the composer, labelled with the machine's name.
			<a
				class="text-accent hover:underline"
				href={DOCS_URL}
				target="_blank"
				rel="noopener noreferrer">More about local connectors</a
			>.
		</p>
	</div>
{/snippet}

<div class="space-y-5 pb-6" data-testid="local-connectors">
	<header class="flex flex-wrap items-start justify-between gap-2">
		<div class="min-w-0">
			<h2 class={s.TITLE}>Local connectors</h2>
			<p class="{s.SUBTITLE} max-w-2xl">
				MCP servers that run on your own machines, offered to your chats while the machine is
				connected. Only you see them.
				<a
					class="text-accent hover:underline"
					href={DOCS_URL}
					target="_blank"
					rel="noopener noreferrer">More</a
				>
			</p>
		</div>
	</header>

	{#if failure}
		<div class={s.ERROR}>
			<p class="flex items-center gap-1.5 font-medium">
				<IconWarning class="size-4" />
				{failure}
			</p>
		</div>
	{/if}
	{#if needsFreshSignIn}
		<div class={s.ERROR} role="alert" data-testid="local-reauth">
			<p class="font-medium">Sign in again to approve a machine.</p>
			<p class="mt-1 text-xs">
				Approving a machine lets it put tools in front of the assistant, so it asks for a sign-in
				from the last 7 days.
				<a class="underline" href={reauthHref}>Sign in again</a>
			</p>
		</div>
	{/if}

	{#if denied}
		<!-- Not the how-to: a machine enrolled now would be refused, so say why instead. -->
		<div
			class="rounded-2xl border border-line bg-surface p-4 text-sm sm:p-6"
			data-testid="local-denied"
		>
			{#if denied === "not_configured"}
				This gateway is not configured for the chat, so local connectors are unavailable. Ask your
				administrator to check the deployment.
			{:else}
				Your administrator has not enabled local connectors for your groups.
			{/if}
		</div>
	{:else if loading}
		<p class="text-sm text-ink-muted">Loading…</p>
	{:else}
		{#if !hasMachine}
			{@render instructions()}
		{/if}

		<section aria-labelledby="local-pending-title">
			<h3 id="local-pending-title" class={s.SECTION_TITLE}>
				Waiting for approval{pending.length > 0 ? ` (${pending.length})` : ""}
			</h3>
			{#if pending.length === 0}
				<p class="text-xs text-ink-muted">
					No machine is waiting. A machine you enroll appears here as soon as it checks in.
				</p>
			{:else}
				<ul class="flex flex-col gap-2">
					{#each pending as machine (machine.id)}
						<li
							class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3"
							data-testid="local-pending-machine"
						>
							<IconLaptop class="size-4 shrink-0 text-ink-muted" />
							<span class="min-w-0 flex-1 truncate text-sm font-medium text-ink"
								>{machine.name}</span
							>
							<span class="text-xs text-ink-muted"
								>Nothing it offers is used until you approve it.</span
							>
							<button
								type="button"
								class="flex h-8 items-center gap-1 rounded-lg bg-accent-solid px-3 text-xs font-medium text-white hover:bg-accent-solid-hover disabled:opacity-60"
								disabled={busy === machine.id}
								onclick={() => void approve(machine)}
							>
								<IconCheck class="size-3.5" />
								Approve
							</button>
							<button
								type="button"
								class="flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
								disabled={busy === machine.id}
								onclick={() => void remove(machine, "Reject")}
							>
								<IconClose class="size-3.5" />
								Reject
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if paired.length > 0}
			<section aria-labelledby="local-machines-title">
				<h3 id="local-machines-title" class={s.SECTION_TITLE}>Your machines ({paired.length})</h3>
				<div class={s.GRID}>
					{#each paired as machine (machine.id)}
						<div class={s.card(machine.online)} data-testid="local-machine">
							<div class={s.CARD_BODY}>
								<div class="mb-2 flex items-start justify-between gap-2">
									<div class="min-w-0">
										<h4 class={s.CARD_TITLE}>{machine.name}</h4>
										<p class={s.CARD_SUBTITLE}>
											{machine.mode === "connectors"
												? "Connectors machine"
												: "Also a coding-agent machine"}
										</p>
									</div>
									<span
										class="{s.PILL} {s.PILL_TONES[machine.online ? 'good' : 'neutral']} shrink-0"
									>
										{machine.online ? "Connected" : "Offline"}
									</span>
								</div>

								{#if machine.servers.length === 0}
									<p class="text-xs text-ink-muted">
										{machine.online
											? "It lists no servers yet. Add some to mcp.json on that machine."
											: "Start galopin on that machine to see its servers."}
									</p>
								{:else}
									<ul class="mb-3 flex flex-col gap-1.5">
										{#each machine.servers as server (server.id)}
											{@const state = stateOf(server)}
											<li class="flex flex-col gap-0.5" data-testid="local-server">
												<div class="flex items-center gap-2">
													<span class="min-w-0 flex-1 truncate text-sm text-ink">{server.name}</span
													>
													<span class="text-xs text-ink-muted">{server.transport}</span>
													<span class="{s.PILL} {s.PILL_TONES[state.tone]}">{state.label}</span>
												</div>
												{#if server.state === "needs-login" && server.transport === "http"}
													<p class="text-xs wrap-break-word text-ink-muted">
														Needs a sign-in; the tokens stay on {machine.name}.
													</p>
													<div class="flex flex-wrap items-center gap-2">
														<button
															type="button"
															class={s.CARD_ACTION}
															disabled={signingIn === server.id}
															onclick={() => void signIn(server)}
														>
															Sign in
														</button>
														<span class="text-xs text-ink-muted">
															If the provider refuses this page's redirect, run
															<code class="font-mono">galopin connectors login {server.name}</code> on
															the machine.
														</span>
													</div>
												{:else if server.state !== "ready" && server.detail}
													<p class="text-xs wrap-break-word text-ink-muted">{server.detail}</p>
												{/if}
											</li>
										{/each}
									</ul>
								{/if}

								{#if machine.mode === "connectors"}
									<button
										type="button"
										class={s.CARD_DESTRUCTIVE}
										disabled={busy === machine.id}
										onclick={() => void remove(machine, "Revoke")}
									>
										<IconTrash class="size-3" />
										Revoke
									</button>
								{:else}
									<p class="text-xs text-ink-muted">Managed in the Agents panel.</p>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		{#if hasMachine}
			<section>
				<button
					type="button"
					class={s.SECONDARY}
					aria-expanded={showAdd}
					onclick={() => (showAdd = !showAdd)}
				>
					{showAdd ? "Hide" : "Add a machine"}
				</button>
				{#if showAdd}
					<div class="mt-3">
						{@render instructions()}
					</div>
				{/if}
			</section>
		{/if}
	{/if}
</div>
