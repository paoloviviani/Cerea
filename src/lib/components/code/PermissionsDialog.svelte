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
	import { m } from "$lib/paraglide/messages";
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
		type CapabilityRow,
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
	/** The machine's safe external directories, in its own words; empty on a
	 * galopin older than the field, and when the machine has none. */
	let safeDirs = $derived(result?.safeDirs ?? []);

	/** The safe-directory line in the external_directory row: the directories
	 * that never ask, and what happens everywhere else. Said only when the
	 * row is not held below the session's setting by the machine's limits —
	 * a ceiling on external_directory caps the safe directories too, and the
	 * row already says so. */
	function safeDirNote(row: CapabilityRow): string | null {
		if (row.id !== "external" || row.capped || safeDirs.length === 0) return null;
		const elsewhere =
			row.action === "deny"
				? m["code.permissions.where_blocked"]()
				: row.action === "allow"
					? m["code.permissions.where_allowed"]()
					: m["code.permissions.where_asks"]();
		return m["code.permissions.safe_dirs"]({ dirs: safeDirs.join(", "), where: elsewhere });
	}

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
			errorToast.set(err instanceof Error ? err.message : m["code.permissions.could_not_remove"]());
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
		try {
			await setCoordinationGrant(deviceId, agentId, coordinationKeys(next));
			await load();
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : m["code.permissions.could_not_grant"]());
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
					{m["code.permissions.title"]({ session: sessionTitle })}
				</h2>
				<p class="{s.SUBTITLE} break-words">
					{m["code.permissions.subtitle"]()}
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
							<span class="font-medium">{m["code.permissions.legacy_title"]()}</span>
							{m["code.permissions.legacy_detail"]()}
						</span>
						{#if onreenroll}
							<button
								type="button"
								class="shrink-0 rounded-lg border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-transparent dark:text-amber-200"
								onclick={onreenroll}>{m["code.permissions.reenroll"]()}</button
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
								<span class="text-ink-muted"
									>{m["code.permissions.except"]({ what: row.except.join("; ") })}</span
								>
							{/if}
							{#if safeDirNote(row)}
								<span class="text-ink-faint" data-testid="permission-safe-dirs">
									{safeDirNote(row)}
								</span>
							{/if}
							{#if row.capped}
								<span class="text-ink-faint" data-testid="permission-capped"
									>{m["code.permissions.limited"]()}</span
								>
							{/if}
						</li>
					{/each}
				</ul>

				<p class="text-ink-muted">
					{m["code.permissions.set_by"]()}
				</p>

				<div>
					<p class="mb-1 font-medium text-ink">{m["code.permissions.exceptions"]()}</p>
					{#if exceptions.length === 0}
						<p class="text-ink-muted">
							{m["code.permissions.exceptions_none"]()}
						</p>
					{:else}
						<ul class="flex flex-col gap-1" data-testid="permission-exceptions">
							{#each exceptions as exception (exception.id)}
								<li
									class="flex flex-wrap items-center gap-1.5"
									data-testid="permission-exception-item"
								>
									<span class="text-ink-muted">{m["code.permissions.allowed_for_session"]()}</span>
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
										<span class="text-ink-faint">{m["code.permissions.held"]()}</span>
									{:else}
										<button
											type="button"
											class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
											disabled={removing !== null}
											title={m["code.permissions.remove_title"]()}
											aria-label={m["code.permissions.remove_label"]({
												permission: exception.permission,
											})}
											onclick={() => void remove(exception.id)}
										>
											{removing === exception.id
												? m["code.permissions.removing"]()
												: m["code.permissions.remove"]()}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
						<p class="mt-1 text-ink-faint">
							{m["code.permissions.exceptions_note"]()}
						</p>
					{/if}
				</div>

				<div>
					<p class="mb-1 font-medium text-ink">{m["code.permissions.coordination"]()}</p>
					{#if subagent}
						<p class="text-ink-muted">
							{m["code.permissions.subagent_note"]()}
						</p>
					{:else if grantable && !grantable.ok}
						<p class="text-ink-muted" data-testid="coordination-unavailable">
							{grantable.reason === "tools-off"
								? m["code.permissions.coord_tools_off"]()
								: m["code.permissions.coord_too_old"]()}
						</p>
					{:else}
						<div
							class="space-y-2"
							role="group"
							aria-label={m["code.permissions.coordination_label"]()}
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
								<span>{m["code.permissions.can_message"]()}</span>
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
								<span>{m["code.permissions.can_spawn"]()}</span>
							</label>
						</div>
						<p class="mt-1 text-ink-faint">
							{m["code.permissions.grant_note"]()}
						</p>
						{#if ceilingWarning}
							<p class="mt-1 text-ink-faint">{ceilingWarning}</p>
						{/if}
					{/if}
				</div>

				<details data-testid="permission-raw">
					<summary class="cursor-pointer text-ink-faint hover:text-ink-muted">
						{m["code.permissions.raw"]()}
					</summary>
					<p class="my-1 text-ink-muted">
						{m["code.permissions.raw_note"]()}
					</p>
					{#if rules.length === 0}
						<p class="text-ink-muted">{m["code.permissions.no_rules"]()}</p>
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
					{m["code.permissions.reading"]()}
				</p>
			{:else if missing}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					{m["code.permissions.too_old"]()}
				</p>
			{:else}
				<p class="text-sm text-ink-muted" data-testid="permissions-unavailable">
					{m["code.permissions.no_answer"]()}
				</p>
			{/if}
		{/if}
		<!-- While the sign-in is stale the detail goes, with the fallback:
		     the server refuses every call anyway, and what it held was
		     machine-derived. -->
	</div>
</Modal>
