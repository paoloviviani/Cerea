<!--
	The Permissions line: what opencode will do about this session's tool
	calls, read from the machine. A summary for the three tools people ask
	about (edit, bash, webfetch: ask / allow / deny) and a disclosure with
	every rule and the "always" approvals opencode is holding.

	READ-ONLY, on purpose. opencode's rules decide; this line shows them. The
	one thing it can do is forget a saved approval (`removeSavedApproval`),
	which can only tighten: that kind of call asks again. There is no control
	here, and no call in `codeApi`, that adds or edits a rule — that would make
	a machine's permissions writable over the link. Auto-accept (the composer's
	toggle) answers asks; it does not appear here because it changes no rule.

	A rule the person wrote in opencode's own config that Cerea or the
	machine's limits replace is shown struck through and labelled, rather than
	listed as if it were in force. After a removal the list is re-read from the
	machine, never spliced: the machine owns what it holds.

	A machine whose galopin predates the op answers 404, and the line simply
	is not drawn.
-->
<script lang="ts">
	import { CodeApiError, getPermissionRules, removeSavedApproval } from "$lib/codeApi";
	import type { PermissionRulesResult } from "$lib/types/machineProtocol";
	import {
		SUMMARY_TOOLS,
		annotateRules,
		sourceLabel,
		summarizeTool,
		type RuleAction,
	} from "$lib/utils/permissionRules";
	import { error as errorToast } from "$lib/stores/errors";
	import IconShield from "~icons/lucide/shield";
	import IconChevron from "~icons/carbon/chevron-down";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		deviceId: string;
		agentId: string;
		/** Bumped by the parent when something may have changed the rules or
		 * the saved approvals (a turn settled, an ask was answered). */
		refreshKey?: number;
	}

	let { deviceId, agentId, refreshKey = 0 }: Props = $props();

	let result = $state<PermissionRulesResult | null>(null);
	let open = $state(false);
	let removing = $state<string | null>(null);

	async function load() {
		try {
			result = await getPermissionRules(deviceId, agentId);
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
		void load();
	});

	let rules = $derived(annotateRules(result?.rules ?? []));
	let summaries = $derived(SUMMARY_TOOLS.map((tool) => summarizeTool(rules, tool)));
	let saved = $derived(result?.savedApprovals ?? []);

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
		} catch (err) {
			errorToast.set(err instanceof Error ? err.message : "Could not forget that approval.");
		} finally {
			removing = null;
		}
	}
</script>

{#if result}
	<div class="pointer-events-auto flex flex-col gap-1 pl-6 text-xs" data-testid="permissions-line">
		<button
			type="button"
			class="flex min-w-0 flex-wrap items-center gap-1.5 text-left text-ink-muted hover:text-ink"
			aria-expanded={open}
			aria-controls="permissions-detail-{agentId}"
			title="What opencode will do about this session's tool calls. Read-only."
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
					{summary.action}{summary.narrower ? ` +${summary.narrower}` : ""}
				</span>
			{/each}
			{#if saved.length > 0}
				<span class="{s.PILL} {s.PILL_TONES.neutral}" data-testid="permission-saved-count">
					{saved.length} saved
				</span>
			{/if}
			<IconChevron class="size-3.5 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
		</button>

		{#if open}
			<div
				id="permissions-detail-{agentId}"
				class="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3"
				data-testid="permissions-detail"
			>
				<p class="text-ink-muted">
					opencode's rules decide; this is what they say, last match wins. This view cannot change a
					rule. Auto-accept answers asks "allow once"; it never edits one.
				</p>

				<div>
					<p class="mb-1 font-medium text-ink">Rules</p>
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
									{#if rule.overriddenBy === "cerea"}
										<span class="text-ink-faint">overridden by Cerea</span>
									{:else if rule.overriddenBy === "ceiling"}
										<span class="text-ink-faint">overridden by this machine's limits</span>
									{:else if rule.source}
										<span class="text-ink-faint">{sourceLabel(rule.source)}</span>
									{/if}
								</li>
							{/each}
						</ul>
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
