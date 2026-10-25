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
	import { m } from "$lib/paraglide/messages";
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { base } from "$app/paths";
	import Rich from "$lib/i18n/Rich.svelte";
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
			failure = err instanceof Error ? err.message : m["workspace.local.could_not_sign_in"]();
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
			if (mine === epoch)
				failure = err instanceof Error ? err.message : m["workspace.local.could_not_load"]();
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
				failure = err instanceof Error ? err.message : m["workspace.local.could_not_approve"]();
			}
		} finally {
			busy = null;
		}
	}

	async function remove(machine: LocalMachineView, verb: "reject" | "revoke") {
		if (
			verb === "revoke" &&
			!confirm(m["workspace.local.revoke_confirm"]({ name: machine.name }))
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
			failure =
				err instanceof Error
					? err.message
					: verb === "reject"
						? m["workspace.local.could_not_reject"]()
						: m["workspace.local.could_not_revoke"]();
		} finally {
			busy = null;
		}
	}

	const reauthHref = $derived(`${base}/login?reauth=1&next=${base}/workspace?tab=local`);

	/** One word for a server's state, and the pill tone it takes. */
	function stateOf(server: LocalServerView): { label: string; tone: s.PillTone } {
		switch (server.state) {
			case "ready":
				return { label: m["workspace.local.state.ready"](), tone: "good" };
			case "needs-login":
				return { label: m["workspace.local.state.needs_login"](), tone: "busy" };
			case "disabled":
				return { label: m["workspace.local.state.disabled"](), tone: "neutral" };
			case "offline":
				return { label: m["workspace.local.state.offline"](), tone: "neutral" };
			default:
				return { label: m["workspace.local.state.invalid"](), tone: "bad" };
		}
	}

	// i18n: literal (sample files and commands the person copies: not words to translate)
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

{#snippet inlineCode(text: string)}<code class="font-mono">{text}</code>{/snippet}
{#snippet strong(text: string)}<strong>{text}</strong>{/snippet}
{#snippet em(text: string)}<em>{text}</em>{/snippet}
{#snippet docsLink(text: string)}<a
		class="text-accent hover:underline"
		href={DOCS_URL}
		target="_blank"
		rel="noopener noreferrer">{text}</a
	>{/snippet}
{#snippet reauthLink(text: string)}<a class="underline" href={reauthHref}>{text}</a>{/snippet}
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
				<h3 class="{s.CARD_TITLE} leading-10 !whitespace-normal">
					{m["workspace.local.howto.title"]()}
				</h3>
				<p class="{s.SUBTITLE} mt-1 break-words">
					{m["workspace.local.howto.intro"]({ name: deploymentName })}
				</p>
			</div>
		</div>

		{@render step(1, m["workspace.local.howto.step1"]())}
		{@render code(commands.install, "local-install-command")}
		<p class="mt-1 text-xs text-ink-muted">
			<Rich parts={m["workspace.local.howto.install_note"].parts()} tags={{ code: inlineCode }} />
		</p>

		{@render step(2, m["workspace.local.howto.step2"]())}
		{@render code(commands.enroll, "local-enroll-command")}
		<p class="mt-1 text-xs text-ink-muted">
			{m["workspace.local.howto.enroll_note"]()}
		</p>

		{@render step(3, m["workspace.local.howto.step3"]())}
		<p class="mt-1 text-xs text-ink-muted">
			<Rich parts={m["workspace.local.howto.signin_note"].parts()} tags={{ code: inlineCode }} />
		</p>

		{@render step(4, m["workspace.local.howto.step4"]())}
		{@render code(commands.run, "local-run-command")}
		<details class="mt-2 text-xs text-ink-muted">
			<summary class="cursor-pointer">{m["workspace.local.howto.service"]()}</summary>
			<div class="mt-2 space-y-2">
				<p>
					<Rich
						parts={m["workspace.local.howto.service_save"].parts()}
						tags={{ code: inlineCode }}
					/>
				</p>
				{@render code(SERVICE_UNIT)}
				{@render code(SERVICE_COMMANDS)}
				<p>
					<Rich
						parts={m["workspace.local.howto.service_note"].parts({ var: "${VAR}" })}
						tags={{ code: inlineCode }}
					/>
				</p>
			</div>
		</details>

		{@render step(5, m["workspace.local.howto.step5"]())}
		<p class="mb-2 text-xs text-ink-muted">
			<Rich parts={m["workspace.local.howto.config_note"].parts()} tags={{ code: inlineCode }} />
		</p>
		{@render code(MCP_JSON, "local-mcp-json")}
		<ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-ink-muted">
			<li>
				<Rich
					parts={m["workspace.local.howto.bullet_command"].parts({ var: "${VAR}" })}
					tags={{ code: inlineCode, strong }}
				/>
			</li>
			<li>
				<Rich
					parts={m["workspace.local.howto.bullet_allowed"].parts()}
					tags={{ code: inlineCode }}
				/>
			</li>
			<li>
				<Rich
					parts={m["workspace.local.howto.bullet_description"].parts()}
					tags={{ code: inlineCode }}
				/>
			</li>
			<li>
				{m["workspace.local.howto.bullet_edits"]()}
			</li>
		</ul>

		{@render step(6, m["workspace.local.howto.step6"]())}
		<p class="text-xs text-ink-muted">
			<Rich parts={m["workspace.local.howto.approve_note"].parts()} tags={{ em, link: docsLink }} />
		</p>
	</div>
{/snippet}

<div class="space-y-5 pb-6" data-testid="local-connectors">
	<header class="flex flex-wrap items-start justify-between gap-2">
		<div class="min-w-0">
			<h2 class={s.TITLE}>{m["workspace.local.title"]()}</h2>
			<p class="{s.SUBTITLE} max-w-2xl">
				<Rich parts={m["workspace.local.subtitle"].parts()} tags={{ link: docsLink }} />
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
			<p class="font-medium">{m["workspace.local.reauth_title"]()}</p>
			<p class="mt-1 text-xs">
				<Rich parts={m["workspace.local.reauth_detail"].parts()} tags={{ link: reauthLink }} />
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
				{m["workspace.local.denied_not_configured"]()}
			{:else}
				{m["workspace.local.denied_not_granted"]()}
			{/if}
		</div>
	{:else if loading}
		<p class="text-sm text-ink-muted">{m["workspace.local.loading"]()}</p>
	{:else}
		{#if !hasMachine}
			{@render instructions()}
		{/if}

		<section aria-labelledby="local-pending-title">
			<h3 id="local-pending-title" class={s.SECTION_TITLE}>
				{pending.length > 0
					? m["workspace.local.pending_title_count"]({ count: pending.length })
					: m["workspace.local.pending_title"]()}
			</h3>
			{#if pending.length === 0}
				<p class="text-xs text-ink-muted">
					{m["workspace.local.pending_empty"]()}
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
							<span class="text-xs text-ink-muted">{m["workspace.local.pending_note"]()}</span>
							<button
								type="button"
								class="flex h-8 items-center gap-1 rounded-lg bg-accent-solid px-3 text-xs font-medium text-white hover:bg-accent-solid-hover disabled:opacity-60"
								disabled={busy === machine.id}
								onclick={() => void approve(machine)}
							>
								<IconCheck class="size-3.5" />
								{m["workspace.local.approve"]()}
							</button>
							<button
								type="button"
								class="flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
								disabled={busy === machine.id}
								onclick={() => void remove(machine, "reject")}
							>
								<IconClose class="size-3.5" />
								{m["workspace.local.reject"]()}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if paired.length > 0}
			<section aria-labelledby="local-machines-title">
				<h3 id="local-machines-title" class={s.SECTION_TITLE}>
					{m["workspace.local.machines_title"]({ count: paired.length })}
				</h3>
				<div class={s.GRID}>
					{#each paired as machine (machine.id)}
						<div class={s.card(machine.online)} data-testid="local-machine">
							<div class={s.CARD_BODY}>
								<div class="mb-2 flex items-start justify-between gap-2">
									<div class="min-w-0">
										<h4 class={s.CARD_TITLE}>{machine.name}</h4>
										<p class={s.CARD_SUBTITLE}>
											{machine.mode === "connectors"
												? m["workspace.local.mode_connectors"]()
												: m["workspace.local.mode_agent"]()}
										</p>
									</div>
									<span
										class="{s.PILL} {s.PILL_TONES[machine.online ? 'good' : 'neutral']} shrink-0"
									>
										{machine.online
											? m["workspace.local.connected"]()
											: m["workspace.local.offline"]()}
									</span>
								</div>

								{#if machine.servers.length === 0}
									<p class="text-xs text-ink-muted">
										{machine.online
											? m["workspace.local.no_servers_online"]()
											: m["workspace.local.no_servers_offline"]()}
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
														{m["workspace.local.needs_login"]({ name: machine.name })}
													</p>
													<div class="flex flex-wrap items-center gap-2">
														<button
															type="button"
															class={s.CARD_ACTION}
															disabled={signingIn === server.id}
															onclick={() => void signIn(server)}
														>
															{m["workspace.local.sign_in"]()}
														</button>
														<span class="text-xs text-ink-muted">
															<Rich
																parts={m["workspace.local.login_help"].parts({ name: server.name })}
																tags={{ code: inlineCode }}
															/>
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
										onclick={() => void remove(machine, "revoke")}
									>
										<IconTrash class="size-3" />
										{m["workspace.local.revoke"]()}
									</button>
								{:else}
									<p class="text-xs text-ink-muted">{m["workspace.local.managed"]()}</p>
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
					{showAdd ? m["workspace.local.hide"]() : m["workspace.local.add_machine"]()}
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
