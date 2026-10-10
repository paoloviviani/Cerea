<!--
	The Permissions dialog: what this session will do about each kind of tool
	call, in plain words, read from the machine. One row per capability
	(edit files, run commands, fetch from the web, ...) with the FINAL
	answer: Allowed, Asks first or Blocked. opencode's rules are
	last-match-wins and the same permission repeats in the raw list with
	contradictory answers, so the rows work the answer out (`capabilityRows`)
	instead of listing them. A row the machine's limits hold below what the
	session's setting would give says so.

	Opened from a session's ⋯ menu in the agents sidebar (CodeNavTree) or
	from the details button beside the composer's Deny / Ask / Allow
	selector (AgentComposer), so the transcript and its approval cards stay
	in view while the person reads it. The Deny / Ask / Allow selector and
	the Coordination switches are the two ways to grant here: the former is
	the composer's, the latter replaces a repeated approval card with a
	grant the session keeps; Remove on an exception can only tighten (that
	command asks again). What it shows is always the machine's last
	word: the dialog reads the rules and the exceptions itself, for the
	session it was opened for, and re-reads after every change. The
	ceiling, the machine's own rules and its policy have no control here
	at all.

	An exception is what the card's "Always allow" leaves behind: one command
	or pattern allowed for this session, on top of the selector. Switching to
	Deny blocks it without deleting it; switching back to Ask restores it.

	The raw rule list, in evaluation order, is kept behind a small disclosure
	for troubleshooting. There a rule from the person's own opencode config
	that Cerea or the machine replace is struck through and labelled, rather
	than listed as if it were in force. A machine whose galopin predates the
	op answers 404, and the dialog says so instead of listing rules.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import {
		CodeApiError,
		getPermissionRules,
		removeSavedApproval,
		setCoordinationGrant,
		type CodeDeviceView,
	} from "$lib/codeApi";
	import type { PermissionRulesResult, Policy } from "$lib/types/machineProtocol";
	import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
	import {
		actionLabel,
		annotateRules,
		capabilityRows,
		isLegacyMachine,
		sourceLabel,
		overriddenLabel,
		type RuleAction,
	} from "$lib/utils/permissionRules";
	import {
		ceilingNote,
		coordinationKeys,
		coordinationOptions,
		coordinationSupport,
		type CoordinationOptions,
	} from "$lib/utils/coordination";
	import { error as errorToast } from "$lib/stores/errors";
	import IconShield from "~icons/lucide/shield";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The session's title, for the heading: the dialog is one session's
		 * and can be opened for a row that is not the one on screen. */
		sessionTitle: string;
		/** The device row this session belongs to, for the coordination
		 * switches' disabled reasons (a galopin too old to grant, agent tools
		 * off) and the ceiling note. Unknown when the tree has not loaded
		 * it — the switches stay usable and the grant itself answers. */
		device?: CodeDeviceView;
		/** A subagent holds no grant of its own (it follows its root):
		 * the section says so instead of offering the switches. */
		subagent?: boolean;
		/** Called after an exception is removed (the dialog re-reads itself);
		 * a parent showing the exceptions count re-reads with it. */
		onchanged?: () => void;
		/** The machine's `hello` policy, to tell a machine that predates
		 * ceilings from one that has none to report yet. */
		policy?: Policy;
		/** Opens the enroll flow, for a machine flagged as legacy. */
		onreenroll?: () => void;
		onclose: () => void;
	}

	let {
		deviceId,
		agentId,
		sessionTitle,
		device,
		subagent = false,
		onchanged,
		policy,
		onreenroll,
		onclose,
	}: Props = $props();

	let removing = $state<string | null>(null);
	let coordinating = $state(false);

	/** The machine's `permission.rules` answer for this session, read here:
	 * the dialog owns its read, so it can be opened for any session's row,
	 * selected or not. A failed read keeps the last good answer; a 404 (a
	 * galopin that predates the op) is said, not retried. */
	let result = $state<PermissionRulesResult | null>(null);
	let missing = $state(false);
	let loading = $state(true);
	let loadToken = 0;

	async function load() {
		const token = ++loadToken;
		loading = true;
		try {
			const read = await getPermissionRules(deviceId, agentId);
			if (token === loadToken) {
				result = read;
				missing = false;
			}
		} catch (err) {
			if (token === loadToken) {
				missing = err instanceof CodeApiError && err.status === 404;
				if (missing) result = null;
			}
		} finally {
			if (token === loadToken) loading = false;
		}
	}

	$effect(() => {
		void deviceId;
		void agentId;
		untrack(() => void load());
	});

	let rules = $derived(annotateRules(result?.rules ?? []));
	let rows = $derived(result ? capabilityRows(result) : []);
	let exceptions = $derived(result?.savedApprovals ?? []);

	/** A machine enrolled before ceilings: nothing caps its Allow. Said up
	 * front, never inside the collapsed detail. */
	let legacy = $derived(isLegacyMachine(policy, result));
	$effect(() => {
		// Remembered per machine, so its row in the tree carries the flag after
		// this dialog is closed. Cleared again if a re-enroll makes it go away.
		if (result) codeLegacyMachines[deviceId] = legacy;
	});

	const TONES: Record<RuleAction, keyof typeof s.PILL_TONES> = {
		allow: "good",
		ask: "neutral",
		deny: "bad",
	};

	async function remove(id: string) {
		if (removing) return;
		removing = id;
		try {
			await removeSavedApproval(deviceId, agentId, id);
			await load();
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : "Could not remove that exception.");
		} finally {
			removing = null;
		}
	}

	/** The session's grant read back as the two switches, in the same
	 * wording the schedules use (utils/coordination.ts). */
	let grant = $derived(coordinationOptions(result?.coordination ?? []));
	/** Whether the machine can take a grant at all; null while the device
	 * row is unknown — the switches stay usable and the grant itself
	 * answers (an old galopin 404s with the reason). */
	let grantable = $derived(device ? coordinationSupport(device) : null);
	let ceilingWarning = $derived(device ? ceilingNote(device, result?.coordination ?? []) : null);

	async function setGrant(next: CoordinationOptions) {
		if (coordinating) return;
		coordinating = true;
		console.log("DEBUG setGrant", JSON.stringify(next));
		try {
			await setCoordinationGrant(deviceId, agentId, coordinationKeys(next));
			await load();
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : "Could not change the grant.");
		} finally {
			coordinating = false;
		}
	}
</script>

<Modal width="max-w-xl" closeButton labelledBy="permissions-dialog-title" {onclose}>
	<div class="p-4 sm:p-6">
		<div class="mb-6 flex items-center gap-3">
			<div class="{s.STRIP_TILE} shrink-0">
				<IconShield class="size-5 text-blue-600" />
			</div>
			<div class="min-w-0 pr-8">
				<h2 id="permissions-dialog-title" class="{s.TITLE} truncate">
					Permissions — {sessionTitle}
				</h2>
				<p class="{s.SUBTITLE} break-words">
					What this session will do about its tool calls, and the exceptions you have allowed.
				</p>
			</div>
		</div>

		{#if result && !codeReauth.required}
			<div class="flex flex-col gap-2 text-sm" data-testid="permissions-detail">
				{#if legacy}
					<div
						class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
						data-testid="legacy-machine-flag"
					>
						<span class="min-w-0 flex-1">
							<span class="font-medium">Re-enroll this machine to set limits.</span> Its policy predates
							ceilings, so nothing caps Allow: on Allow, edits, commands and fetches run without asking,
							subagents too.
						</span>
						{#if onreenroll}
							<button
								type="button"
								class="shrink-0 rounded-lg border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-transparent dark:text-amber-200"
								onclick={onreenroll}>Re-enroll this machine</button
							>
						{/if}
					</div>
				{/if}

				<ul class="flex flex-col gap-1" data-testid="permission-rows">
					{#each rows as row (row.id)}
						<li
							class="flex flex-wrap items-center gap-1.5"
							data-testid="permission-row"
							data-row={row.id}
							data-action={row.action}
						>
							<span class="text-ink">{row.label}</span>
							<span class="{s.PILL} {s.PILL_TONES[TONES[row.action]]}"
								>{actionLabel(row.action)}</span
							>
							{#if row.except.length > 0}
								<span class="text-ink-muted">except {row.except.join("; ")}</span>
							{/if}
							{#if row.capped}
								<span class="text-ink-faint" data-testid="permission-capped"
									>limited by this machine</span
								>
							{/if}
						</li>
					{/each}
				</ul>

				<p class="text-ink-muted">
					Set by this session's Deny / Ask / Allow switch, within the limits this machine was
					enrolled with.
				</p>

				<div>
					<p class="mb-1 font-medium text-ink">Exceptions</p>
					{#if exceptions.length === 0}
						<p class="text-ink-muted">
							None. "Always allow (this session)" on a card would add one here.
						</p>
					{:else}
						<ul class="flex flex-col gap-1" data-testid="permission-exceptions">
							{#each exceptions as exception (exception.id)}
								<li
									class="flex flex-wrap items-center gap-1.5"
									data-testid="permission-exception-item"
								>
									<span class="text-ink-muted">Allowed for this session:</span>
									<span class="min-w-0 truncate font-mono text-ink">
										{exception.patterns.length > 0
											? exception.patterns.join(", ")
											: exception.permission}
									</span>
									{#if exception.permission !== "bash" && exception.patterns.length > 0}
										<span class="text-ink-faint">({exception.permission})</span>
									{/if}
									<span class="min-w-0 flex-1"></span>
									{#if exception.removable === false}
										<span class="text-ink-faint">held by the machine</span>
									{:else}
										<button
											type="button"
											class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
											disabled={removing !== null}
											title="Remove this exception: the next matching call asks again."
											aria-label="Remove exception for {exception.permission}"
											onclick={() => void remove(exception.id)}
										>
											{removing === exception.id ? "Removing…" : "Remove"}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
						<p class="mt-1 text-ink-faint">
							Exceptions last for this session only. Deny blocks them without deleting them;
							switching back to Ask restores them.
						</p>
					{/if}
				</div>

				<div>
					<p class="mb-1 font-medium text-ink">Coordination</p>
					{#if subagent}
						<p class="text-ink-muted">
							A subagent follows its root's setting and holds no grant of its own. Open this dialog
							on the main session to change it.
						</p>
					{:else if grantable && !grantable.ok}
						<p class="text-ink-muted" data-testid="coordination-unavailable">
							{grantable.detail}
						</p>
					{:else}
						<div
							class="space-y-2"
							role="group"
							aria-label="Coordination with other sessions"
							data-testid="coordination-options"
						>
							<label class="flex items-start gap-2 text-sm text-ink">
								<input
									type="checkbox"
									class="mt-1"
									checked={grant.canMessage}
									disabled={coordinating}
									onchange={() =>
										void setGrant({ canMessage: !grant.canMessage, canSpawn: grant.canSpawn })}
								/>
								<span>Can find, read and message other sessions</span>
							</label>
							<label class="flex items-start gap-2 text-sm text-ink">
								<input
									type="checkbox"
									class="mt-1"
									checked={grant.canSpawn}
									disabled={coordinating}
									onchange={() =>
										void setGrant({ canMessage: grant.canMessage, canSpawn: !grant.canSpawn })}
								/>
								<span>Can start new sessions</span>
							</label>
						</div>
						<p class="mt-1 text-ink-faint">
							Takes effect on the session's next turn. Still asks: a session in another workspace, a
							send past three hops, anything this machine caps at Ask — and the rate limits still
							apply. A session it spawns starts with the same grant.
						</p>
						{#if ceilingWarning}
							<p class="mt-1 text-ink-faint">{ceilingWarning}</p>
						{/if}
					{/if}
				</div>

				<details data-testid="permission-raw">
					<summary class="cursor-pointer text-ink-faint hover:text-ink-muted">
						Show the raw rules (for troubleshooting)
					</summary>
					<p class="my-1 text-ink-muted">
						opencode's rules in evaluation order: the last one that matches wins, so an earlier rule
						for the same permission can be replaced by a later one.
					</p>
					{#if rules.length === 0}
						<p class="text-ink-muted">No rules: opencode asks for everything it checks.</p>
					{:else}
						<ul class="flex flex-col gap-1" data-testid="permission-rules">
							{#each rules as rule, index (index)}
								<li
									class="flex flex-wrap items-center gap-1.5"
									data-testid="permission-rule"
									data-overridden={rule.overriddenBy ? "true" : "false"}
								>
									<span class={rule.overriddenBy ? "text-ink-faint line-through" : "text-ink"}>
										<span class="font-mono">{rule.permission}</span>
										{#if rule.pattern !== "*"}
											<span class="font-mono text-ink-muted">{rule.pattern}</span>
										{/if}
									</span>
									<span
										class="{s.PILL} {s.PILL_TONES[TONES[rule.action]]} {rule.overriddenBy
											? 'opacity-60'
											: ''}">{rule.action}</span
									>
									{#if rule.overriddenBy}
										<span class="text-ink-faint">{overriddenLabel(rule.overriddenBy)}</span>
									{:else if rule.source}
										<span class="text-ink-faint">{sourceLabel(rule.source)}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</details>
			</div>
		{:else if !codeReauth.required}
			{#if loading}
				<p class="text-sm text-ink-muted" data-testid="permissions-loading">
					Reading the session's rules…
				</p>
			{:else if missing}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					This machine's galopin is too old to report permissions; update it to see them.
				</p>
			{:else}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					The machine has not answered yet. Close and open this again in a moment.
				</p>
			{/if}
		{/if}
		<!-- While the sign-in is stale the detail goes, with the fallback:
		     the server refuses every call anyway, and what it held was
		     machine-derived. -->
	</div>
</Modal>
