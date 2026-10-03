<!--
	The Permissions line: what this session will do about each kind of tool
	call, in plain words, read from the machine. The collapsed line says it in
	a breath ("Edits ask · commands ask · web ask"); opening it gives one row
	per capability (edit files, run commands, fetch from the web, ...) with the
	FINAL answer: Allowed, Asks first or Blocked. opencode's rules are
	last-match-wins and the same permission repeats in the raw list with
	contradictory answers, so the rows work the answer out (`capabilityRows`)
	instead of listing them. A row the machine's limits hold below what the
	session's setting would give says so.

	It is read-only. The one setting is the composer's Deny / Ask / Allow
	selector; the one write here is Remove on an exception, which can only
	tighten (that command asks again). What it shows is always the machine's
	last word: the rules and the exceptions arrive from the parent view's
	`permission.rules` read (`result`) and are re-read after every change. The
	ceiling, the machine's own rules and its policy have no control here at all.

	An exception is what the card's "Always allow" leaves behind: one command
	or pattern allowed for this session, on top of the selector. Switching to
	Deny blocks it without deleting it; switching back to Ask restores it.

	The raw rule list, in evaluation order, is kept behind a small disclosure
	for troubleshooting. There a rule from the person's own opencode config that
	Cerea or the machine replace is struck through and labelled, rather than
	listed as if it were in force. A machine whose galopin predates the op
	answers 404, and the line simply is not drawn.
-->
<script lang="ts">
	import { removeSavedApproval } from "$lib/codeApi";
	import type { PermissionRulesResult, Policy } from "$lib/types/machineProtocol";
	import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
	import {
		actionLabel,
		annotateRules,
		capabilityRows,
		isLegacyMachine,
		overriddenLabel,
		permissionSummary,
		sourceLabel,
		type RuleAction,
	} from "$lib/utils/permissionRules";
	import { error as errorToast } from "$lib/stores/errors";
	import IconShield from "~icons/lucide/shield";
	import IconChevron from "~icons/carbon/chevron-down";
	import { codeReauth } from "$lib/stores/codeReauth.svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** The machine's `permission.rules` answer for this session, read by
		 * the parent; null until it lands and on a machine that predates it. */
		result: PermissionRulesResult | null;
		/** Called after an exception is removed: the parent re-reads. */
		onchanged?: () => void;
		/** The machine's `hello` policy, to tell a machine that predates
		 * ceilings from one that has none to report yet. */
		policy?: Policy;
		/** Opens the enroll flow, for a machine flagged as legacy. */
		onreenroll?: () => void;
	}

	let { deviceId, agentId, result, onchanged, policy, onreenroll }: Props = $props();

	let open = $state(false);
	let removing = $state<string | null>(null);

	let rules = $derived(annotateRules(result?.rules ?? []));
	let rows = $derived(result ? capabilityRows(result) : []);
	let summary = $derived(permissionSummary(rows));
	let exceptions = $derived(result?.savedApprovals ?? []);

	/** A machine enrolled before ceilings: nothing caps its Allow. Said up
	 * front, never inside the collapsed detail. */
	let legacy = $derived(isLegacyMachine(policy, result));
	$effect(() => {
		// Remembered per machine, so its row in the tree carries the flag after
		// this screen is closed. Cleared again if a re-enroll makes it go away.
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
			onchanged?.();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : "Could not remove that exception.");
		} finally {
			removing = null;
		}
	}
</script>

<!-- While the sign-in is stale the whole line goes, with its Remove: the
     server refuses every call anyway, and what it held was machine-derived. -->
{#if result && !codeReauth.required}
	<div class="pointer-events-auto flex flex-col gap-1 pl-6 text-xs" data-testid="permissions-line">
		<button
			type="button"
			class="flex min-w-0 flex-wrap items-center gap-1.5 text-left text-ink-muted hover:text-ink"
			aria-expanded={open}
			aria-controls="permissions-detail-{agentId}"
			title="What this session will do about its tool calls, and the exceptions you have allowed."
			onclick={() => (open = !open)}
		>
			<IconShield class="size-3.5 shrink-0" />
			<span class="font-medium">Permissions</span>
			<span data-testid="permission-summary">{summary}</span>
			{#if exceptions.length > 0}
				<span class="{s.PILL} {s.PILL_TONES.neutral}" data-testid="permission-exceptions-count">
					{exceptions.length}
					{exceptions.length === 1 ? "exception" : "exceptions"}
				</span>
			{/if}
			<IconChevron class="size-3.5 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
		</button>

		{#if legacy}
			<div
				class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200"
				data-testid="legacy-machine-flag"
			>
				<span class="min-w-0 flex-1">
					<span class="font-medium">Re-enroll this machine to set limits.</span> Its policy predates ceilings,
					so nothing caps Allow: on Allow, edits, commands and fetches run without asking, subagents too.
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

		{#if open}
			<div
				id="permissions-detail-{agentId}"
				class="scrollbar-custom flex max-h-[40vh] flex-col gap-2 overflow-y-auto rounded-lg border border-line bg-surface p-3"
				data-testid="permissions-detail"
			>
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
		{/if}
	</div>
{/if}
