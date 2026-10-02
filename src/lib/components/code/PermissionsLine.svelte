<!--
	The Permissions line: what opencode will do about this session's tool
	calls, read from the machine, and the place to set this session's own
	rules. A summary for the three tools people ask about (edit, bash,
	webfetch: ask / allow / deny, with how many saved "always" approvals each
	has) and a disclosure with every rule, the session-rule editor and the
	saved approvals.

	opencode's rules decide; this line shows them, and what it shows is always
	the machine's last word. The editor composes THIS session's rules
	(`setSessionRules`) and offers nothing above the machine's ceiling, but the
	machine caps them anyway: it may lower or refuse a rule. So after every
	write the whole thing is re-read (`getPermissionRules`) and the list above
	the editor, the summary and the editor's own rows all show what is in
	force, never what was asked for; where the two differ the line says so. The
	ceiling, the machine's own rules and its policy have no control here at all.

	The other write is forgetting a saved "always" approval, which can only
	tighten. Auto-accept (the composer's toggle) answers asks; it does not
	appear here because it changes no rule.

	A rule the person wrote in opencode's own config that Cerea or the
	machine replace is shown struck through and labelled, rather than listed
	as if it were in force. A machine whose galopin predates the op answers
	404, and the line simply is not drawn.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import {
		CodeApiError,
		getPermissionRules,
		removeSavedApproval,
		setSessionRules,
	} from "$lib/codeApi";
	import type { PermissionRulesResult, Policy, SessionRuleInput } from "$lib/types/machineProtocol";
	import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
	import {
		SUMMARY_TOOLS,
		allowedActions,
		annotateRules,
		isLegacyMachine,
		ceilingOf,
		notApplied,
		overriddenLabel,
		savedCount,
		sessionRulesOf,
		sourceLabel,
		summarizeTool,
		validateDraft,
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
		/** Bumped by the parent when something may have changed the rules or
		 * the saved approvals (a turn settled, an ask was answered). */
		refreshKey?: number;
		/** The machine's `hello` policy, to tell a machine that predates
		 * ceilings from one that has none to report yet. */
		policy?: Policy;
		/** Opens the enroll flow, for a machine flagged as legacy. */
		onreenroll?: () => void;
	}

	let { deviceId, agentId, refreshKey = 0, policy, onreenroll }: Props = $props();

	let result = $state<PermissionRulesResult | null>(null);
	let open = $state(false);
	let removing = $state<string | null>(null);

	/** The editor's rows: this session's own rules, as the person is writing
	 * them. Starts from what the machine says is in force and is reset to it
	 * after every write; never what the machine "should" have. */
	let draft = $state<SessionRuleInput[]>([]);
	let dirty = $state(false);
	let saving = $state(false);
	/** What the last write came to, in words: set only after the re-read. */
	let outcome = $state<{ tone: "ok" | "differs"; text: string } | null>(null);

	async function load(resetDraft = false) {
		try {
			result = await getPermissionRules(deviceId, agentId);
			if (resetDraft || !dirty) {
				draft = sessionRulesOf(result.rules);
				dirty = false;
			}
		} catch (err) {
			// An older machine has no such op: draw nothing. Any other failure
			// keeps what was last read rather than blanking a line that was
			// right a moment ago.
			if (err instanceof CodeApiError && err.status === 404) result = null;
		}
	}

	$effect(() => {
		void refreshKey;
		void deviceId;
		void agentId;
		void untrack(() => load());
	});

	let rules = $derived(annotateRules(result?.rules ?? []));
	let summaries = $derived(
		SUMMARY_TOOLS.map((tool) => ({
			...summarizeTool(rules, tool),
			saved: result ? savedCount(result, tool) : 0,
		}))
	);
	let saved = $derived(result?.savedApprovals ?? []);
	let ceiling = $derived(result ? ceilingOf(result) : {});
	let capped = $derived(Object.entries(ceiling));
	let problems = $derived(validateDraft(draft, ceiling));

	/** A machine enrolled before ceilings: allows everything until it is
	 * re-enrolled. Said up front, never inside the collapsed detail. */
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

	function edit() {
		dirty = true;
		outcome = null;
	}

	function addRule() {
		const permission = "edit";
		const options = allowedActions(ceiling, permission);
		draft = [
			...draft,
			{ permission, pattern: "*", action: options.includes("ask") ? "ask" : options[0] },
		];
		edit();
	}

	function dropRule(index: number) {
		draft = draft.filter((_, at) => at !== index);
		edit();
	}

	function discard() {
		draft = sessionRulesOf(result?.rules ?? []);
		dirty = false;
		outcome = null;
	}

	async function save() {
		if (saving || problems.length > 0) return;
		const asked = draft.map((rule) => ({
			permission: rule.permission.trim(),
			pattern: rule.pattern.trim(),
			action: rule.action,
		}));
		saving = true;
		outcome = null;
		let refused: string | null = null;
		try {
			await setSessionRules(deviceId, agentId, asked);
		} catch (err) {
			refused = err instanceof Error ? err.message : "The machine refused those rules.";
		}
		// Whatever the answer was, the truth is what the machine holds now.
		await load(refused === null);
		saving = false;
		if (refused !== null) {
			errorToast.set(refused);
			outcome = { tone: "differs", text: `Nothing was applied. ${refused}` };
			return;
		}
		const differences = notApplied(asked, sessionRulesOf(result?.rules ?? []));
		outcome =
			differences.length === 0
				? { tone: "ok", text: "Applied. This is what is in force." }
				: {
						tone: "differs",
						text: `Not applied as asked, showing what is in force: ${differences
							.map(
								(d) =>
									`${d.asked.permission} ${d.asked.pattern} is ${d.inForce ?? "not set"}, not ${d.asked.action}`
							)
							.join("; ")}.`,
					};
	}

	async function remove(id: string) {
		if (removing) return;
		removing = id;
		try {
			await removeSavedApproval(deviceId, agentId, id);
			await load();
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : "Could not forget that approval.");
		} finally {
			removing = null;
		}
	}
</script>

<!-- While the sign-in is stale the whole line goes, with its Apply: the
     server refuses every call anyway, and what it held was machine-derived. -->
{#if result && !codeReauth.required}
	<div class="pointer-events-auto flex flex-col gap-1 pl-6 text-xs" data-testid="permissions-line">
		<button
			type="button"
			class="flex min-w-0 flex-wrap items-center gap-1.5 text-left text-ink-muted hover:text-ink"
			aria-expanded={open}
			aria-controls="permissions-detail-{agentId}"
			title="What opencode will do about this session's tool calls, and this session's own rules."
			onclick={() => (open = !open)}
		>
			<IconShield class="size-3.5 shrink-0" />
			<span class="font-medium">Permissions</span>
			{#each summaries as summary (summary.tool)}
				<span
					class="{s.PILL} {s.PILL_TONES[TONES[summary.action]]}"
					data-testid="permission-{summary.tool}"
					title={summary.explicit
						? `${summary.tool}: ${summary.action}${summary.narrower ? `, with ${summary.narrower} narrower rule${summary.narrower === 1 ? "" : "s"}` : ""}`
						: `${summary.tool}: no rule matches, so opencode asks`}
				>
					{summary.tool}
					{summary.action}{summary.narrower ? ` +${summary.narrower}` : ""}{summary.saved > 0
						? ` · ${summary.saved} saved`
						: ""}
				</span>
			{/each}
			{#if saved.length > 0}
				<span class="{s.PILL} {s.PILL_TONES.neutral}" data-testid="permission-saved-count">
					{saved.length} saved
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
					<span class="font-medium">Re-enroll this machine.</span> Its policy predates ceilings, so it
					still allows everything: edits, commands and fetches run without asking, subagents too. One
					re-enroll tightens it.
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
				class="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
				data-testid="permissions-detail"
			>
				<p class="text-ink-muted">
					opencode's rules decide; this is what they say, last match wins. Rules you set for this
					session are capped by this machine's ceiling, and what is listed here is always what is in
					force, not what was asked. Auto-accept answers asks "allow once"; it never edits a rule.
				</p>

				<div>
					<p class="mb-1 font-medium text-ink">Rules in force</p>
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
				</div>

				<div data-testid="permission-session-rules">
					<p class="mb-1 font-medium text-ink">This session's rules</p>
					{#if capped.length > 0}
						<p class="mb-1 text-ink-muted" data-testid="permission-ceiling">
							This machine caps: {capped.map(([key, max]) => `${key} at most ${max}`).join(", ")}.
						</p>
					{/if}
					{#if draft.length === 0}
						<p class="text-ink-muted">None set. The rules above apply as they are.</p>
					{:else}
						<ul class="flex flex-col gap-1">
							{#each draft as rule, index (index)}
								<li class="flex flex-wrap items-center gap-1.5" data-testid="session-rule-row">
									<input
										class="w-24 rounded-lg border border-line bg-surface px-2 py-0.5 font-mono text-xs"
										list="permission-keys-{agentId}"
										aria-label="Permission for rule {index + 1}"
										bind:value={rule.permission}
										oninput={edit}
									/>
									<input
										class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-0.5 font-mono text-xs"
										aria-label="Pattern for rule {index + 1}"
										bind:value={rule.pattern}
										oninput={edit}
									/>
									<select
										class="rounded-lg border border-line bg-surface px-1 py-0.5 text-xs"
										aria-label="Action for rule {index + 1}"
										bind:value={rule.action}
										onchange={edit}
									>
										{#each ["allow", "ask", "deny"] as const as action (action)}
											{@const offered = allowedActions(ceiling, rule.permission.trim())}
											{#if offered.includes(action) || action === rule.action}
												<option value={action} disabled={!offered.includes(action)}>{action}</option
												>
											{/if}
										{/each}
									</select>
									<button
										type="button"
										class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken"
										aria-label="Remove rule {index + 1}"
										onclick={() => dropRule(index)}>×</button
									>
								</li>
							{/each}
						</ul>
						<datalist id="permission-keys-{agentId}">
							{#each SUMMARY_TOOLS as tool (tool)}<option value={tool}></option>{/each}
						</datalist>
					{/if}
					{#each problems as problem, at (at)}
						<p class="mt-1 text-danger" data-testid="session-rule-problem">
							{problem.index >= 0 ? `Rule ${problem.index + 1}: ` : ""}{problem.message}
						</p>
					{/each}
					<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
						<button
							type="button"
							class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken"
							onclick={addRule}>Add rule</button
						>
						<button
							type="button"
							class="rounded-lg bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
							disabled={!dirty || saving || problems.length > 0}
							onclick={() => void save()}>{saving ? "Applying…" : "Apply to this session"}</button
						>
						{#if dirty}
							<button
								type="button"
								class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken"
								disabled={saving}
								onclick={discard}>Discard</button
							>
						{/if}
					</div>
					{#if outcome}
						<p
							class="mt-1 {outcome.tone === 'differs' ? 'text-amber-600' : 'text-ink-muted'}"
							role="status"
							data-testid="session-rules-outcome"
						>
							{outcome.text}
						</p>
					{/if}
				</div>

				<div>
					<p class="mb-1 font-medium text-ink">Saved approvals</p>
					{#if saved.length === 0}
						<p class="text-ink-muted">None. Every "always" answer would show up here.</p>
					{:else}
						<ul class="flex flex-col gap-1" data-testid="permission-saved">
							{#each saved as approval (approval.id)}
								<li class="flex flex-wrap items-center gap-1.5" data-testid="permission-saved-item">
									<span class="font-mono text-ink">{approval.permission}</span>
									{#if approval.patterns.length > 0}
										<span class="min-w-0 truncate font-mono text-ink-muted">
											{approval.patterns.join(", ")}
										</span>
									{/if}
									<span class="min-w-0 flex-1"></span>
									{#if approval.removable === false}
										<span class="text-ink-faint">held by opencode</span>
									{:else}
										<button
											type="button"
											class="rounded-lg border border-line px-2 py-0.5 text-xs font-medium text-ink-muted hover:bg-sunken disabled:opacity-60"
											disabled={removing !== null}
											title="Forget this approval: the next matching call asks again."
											aria-label="Remove saved approval for {approval.permission}"
											onclick={() => void remove(approval.id)}
										>
											{removing === approval.id ? "Removing…" : "Remove"}
										</button>
									{/if}
								</li>
							{/each}
						</ul>
						<p class="mt-1 text-ink-faint">
							An "always" approval covers every session in this workspace until opencode restarts.
						</p>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
