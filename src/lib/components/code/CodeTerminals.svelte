<!--
	The Terminal tab (ADR 0090, PROTOCOL.md §9): a tab strip over one or more
	terminals in this workspace, each a full shell on the paired machine.
	Owns the terminal roster (list/open/rename/close) and the one-time
	per-machine acknowledgement; CodeTerminal.svelte owns one live view.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import IconAdd from "~icons/carbon/add";
	import IconClose from "~icons/carbon/close";
	import IconRenew from "~icons/carbon/renew";
	import IconWarning from "~icons/carbon/warning-filled";
	import CodeTerminal from "./CodeTerminal.svelte";
	import Modal from "$lib/components/Modal.svelte";
	import * as s from "$lib/components/overlay/styles";
	import { base } from "$app/paths";
	import {
		listWorkspaceTerminals,
		openTerminal as apiOpenTerminal,
		renameTerminal,
		closeTerminal as apiCloseTerminal,
		acknowledgeTerminal,
	} from "$lib/codeApi";
	import type { Terminal } from "$lib/types/machineProtocol";

	interface Props {
		deviceId: string;
		workspaceId: string;
		machineName: string;
		acknowledged: boolean;
	}

	let { deviceId, workspaceId, machineName, acknowledged = $bindable() }: Props = $props();

	let terminals = $state<Terminal[]>([]);
	let activeId = $state<string | null>(null);
	/** Exit codes for terminals CodeTerminal reported as exited — kept
	 * separately from `terminals` (the roster's own `state`/`exitCode` only
	 * refreshes on an explicit reload) so the tab flips the instant the
	 * relay tells us, not on the next poll. */
	let exited = $state<Map<string, number>>(new Map());
	let renaming = $state<string | null>(null);
	let renameValue = $state("");
	let renameInput = $state<HTMLInputElement | undefined>();
	let showAck = $state(false);
	let pendingOpen = $state(false);
	let failure = $state<string | null>(null);
	let loading = $state(false);

	async function refresh() {
		loading = true;
		try {
			const { terminals: list } = await listWorkspaceTerminals(deviceId, workspaceId);
			terminals = list;
			if (!activeId || !list.some((t) => t.id === activeId)) {
				activeId = list[0]?.id ?? null;
			}
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not list terminals.";
		} finally {
			loading = false;
		}
	}

	async function reallyOpen() {
		pendingOpen = true;
		failure = null;
		try {
			const { terminal } = await apiOpenTerminal(deviceId, workspaceId, { cols: 80, rows: 24 });
			terminals = [...terminals, terminal];
			activeId = terminal.id;
			exited.delete(terminal.id);
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not open a terminal.";
		} finally {
			pendingOpen = false;
		}
	}

	function requestNew() {
		if (!acknowledged) {
			showAck = true;
			return;
		}
		void reallyOpen();
	}

	async function confirmAck() {
		await acknowledgeTerminal(deviceId);
		acknowledged = true;
		showAck = false;
		await reallyOpen();
	}

	function select(id: string) {
		activeId = id;
	}

	function startRename(t: Terminal) {
		renaming = t.id;
		renameValue = t.title;
		setTimeout(() => renameInput?.focus(), 0);
	}

	async function commitRename() {
		const id = renaming;
		if (!id) return;
		renaming = null;
		const title = renameValue.trim();
		if (!title) return;
		try {
			const { terminal } = await renameTerminal(deviceId, id, title);
			terminals = terminals.map((t) => (t.id === id ? terminal : t));
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not rename.";
		}
	}

	async function close(id: string) {
		try {
			await apiCloseTerminal(deviceId, id);
		} catch {
			// The tab still goes away locally; a stale close (already exited
			// on the machine) shouldn't strand the tab in the UI.
		}
		terminals = terminals.filter((t) => t.id !== id);
		exited.delete(id);
		if (activeId === id) activeId = terminals[0]?.id ?? null;
	}

	function onExit(id: string, code: number) {
		exited.set(id, code);
		exited = new Map(exited);
	}

	async function restart(t: Terminal) {
		exited.delete(t.id);
		exited = new Map(exited);
		terminals = terminals.filter((x) => x.id !== t.id);
		try {
			const { terminal } = await apiOpenTerminal(deviceId, workspaceId, {
				cols: 80,
				rows: 24,
				title: t.title,
			});
			terminals = [...terminals, terminal];
			activeId = terminal.id;
		} catch (err) {
			failure = err instanceof Error ? err.message : "Could not restart.";
		}
	}

	/** Step-up failed (a stale or missing OIDC auth_time, D6): sent through
	 * the existing login, with this page as the return URL. */
	function reauth() {
		const next = `${window.location.pathname}${window.location.search}`;
		// reauth=1: a plain login answers from the IdP's own SSO session with
		// the same stale auth_time and never re-prompts, which would loop
		// forever — see triggerOauthFlow/getOIDCAuthorizationUrl (auth.ts).
		window.location.href = `${base}/login?reauth=1&next=${encodeURIComponent(next)}`;
	}

	$effect(() => {
		void workspaceId;
		untrack(() => {
			terminals = [];
			activeId = null;
			exited = new Map();
			void refresh();
		});
	});

	let active = $derived(terminals.find((t) => t.id === activeId) ?? null);
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="code-terminals">
	<div
		class="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 px-1.5 dark:border-gray-700"
	>
		{#each terminals as t (t.id)}
			<div
				class="group flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs {activeId === t.id
					? 'bg-gray-100 dark:bg-gray-800'
					: 'hover:bg-gray-50 dark:hover:bg-gray-800/60'}"
			>
				{#if renaming === t.id}
					<input
						bind:this={renameInput}
						class="w-24 bg-transparent text-xs outline-none"
						bind:value={renameValue}
						onblur={commitRename}
						onkeydown={(e) => {
							if (e.key === "Enter") commitRename();
							if (e.key === "Escape") renaming = null;
						}}
					/>
				{:else}
					<button
						type="button"
						class="max-w-32 truncate"
						ondblclick={() => startRename(t)}
						onclick={() => select(t.id)}
					>
						{t.title}
					</button>
					{#if exited.has(t.id)}
						<span class="text-gray-400">·exited</span>
					{/if}
				{/if}
				<button
					type="button"
					aria-label="Close terminal"
					class="opacity-0 group-hover:opacity-100"
					onclick={() => close(t.id)}
				>
					<IconClose class="size-3" />
				</button>
			</div>
		{/each}
		<button
			type="button"
			class="ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
			disabled={pendingOpen}
			onclick={requestNew}
		>
			<IconAdd class="size-3.5" />
			New
		</button>
		<button
			type="button"
			class="flex size-6 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
			title="Refresh"
			aria-label="Refresh terminals"
			onclick={refresh}
		>
			<IconRenew class="size-3.5 {loading ? 'animate-spin' : ''}" />
		</button>
	</div>

	{#if failure}
		<p
			class="flex items-center gap-1.5 border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
		>
			<IconWarning class="size-3.5" />
			{failure}
		</p>
	{/if}

	<div class="min-h-0 flex-1">
		{#if active}
			{#if exited.has(active.id)}
				<div class="flex h-full flex-col items-center justify-center gap-3 text-sm text-gray-500">
					<p>Exited (code {exited.get(active.id)})</p>
					<button
						type="button"
						class="rounded-md border border-gray-200 px-3 py-1 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
						onclick={() => active && restart(active)}
					>
						Restart
					</button>
				</div>
			{:else}
				{#key active.id}
					<CodeTerminal
						{deviceId}
						terminalId={active.id}
						onexit={(code) => active && onExit(active.id, code)}
						onreauth={reauth}
					/>
				{/key}
			{/if}
		{:else if !loading}
			<div class="flex h-full items-center justify-center text-sm text-gray-400">
				No terminals open in this workspace.
			</div>
		{/if}
	</div>
</div>

{#if showAck}
	<Modal
		width="max-w-md"
		closeButton
		labelledBy="terminal-ack-title"
		onclose={() => (showAck = false)}
	>
		<div class="p-6">
			<div class="mb-4 flex items-center gap-3">
				<div class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-danger/15">
					<IconWarning class="size-5 text-danger" />
				</div>
				<h2 id="terminal-ack-title" class={s.TITLE}>A terminal is a full shell</h2>
			</div>
			<p class="text-sm text-ink-muted">
				A terminal is a full shell on <strong>{machineName}</strong>. Anything typed here runs on
				that machine, unmediated by the agent or any permission rule.
			</p>
			<div class="mt-4 flex justify-end gap-2">
				<button type="button" onclick={() => (showAck = false)} class={s.SECONDARY}>Cancel</button>
				<button type="button" class={s.PRIMARY} onclick={() => void confirmAck()}>
					I understand
				</button>
			</div>
		</div>
	</Modal>
{/if}
