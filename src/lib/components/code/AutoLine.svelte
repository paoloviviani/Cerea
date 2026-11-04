<!--
	The computed expectation under the composer's permission control (ADR 0107 section 3): what a
	session on Auto does on this machine, class by class, from the machine's limits and the
	administrator's rows, with a details view that says why for each.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import type { Policy } from "$lib/types/machineProtocol";
	import {
		className,
		classRows,
		expectationLine,
		outcomeText,
		reasonText,
		thirdStepLabel,
		type AutoSetup,
	} from "$lib/utils/autoApproval";

	let {
		machineName,
		policy,
		setup,
	}: { machineName: string; policy: Policy | undefined; setup: AutoSetup | null } = $props();

	const label = $derived(thirdStepLabel(setup));
	const computed = $derived(
		classRows(policy, setup ?? { reviewerAvailable: false, perClass: {} as AutoSetup["perClass"] })
	);
	const line = $derived(expectationLine(machineName, computed.rows, label));
	let open = $state(false);
</script>

<div class="mt-1.5 px-0.5 text-xs text-gray-500 dark:text-gray-400" data-testid="auto-line-wrap">
	<p class="flex flex-wrap items-baseline gap-x-2">
		<span data-testid="auto-line">{line}</span>
		<button
			type="button"
			class="font-medium underline underline-offset-2"
			aria-expanded={open}
			aria-controls="auto-details"
			data-testid="auto-details-toggle"
			onclick={() => (open = !open)}
		>
			{m["code.auto.details"]()}
		</button>
	</p>
	{#if setup?.degraded && label === "auto"}
		<p class="mt-1 text-amber-700 dark:text-amber-400" data-testid="auto-degraded">
			{m["code.auto.degraded"]()}
		</p>
	{/if}
	{#if open}
		<div id="auto-details" class="mt-1.5 max-w-xl" data-testid="auto-details">
			{#if computed.older}
				<p class="mb-1" data-testid="auto-older">{m["code.auto.older_note"]()}</p>
			{/if}
			<table class="w-full text-left">
				<tbody>
					{#each computed.rows as row (row.class)}
						<tr class="border-t border-gray-200 align-top dark:border-gray-700">
							<th scope="row" class="py-1 pr-2 font-medium">{className(row.class)}</th>
							<td class="py-1 pr-2" data-testid="auto-row-{row.class}">{outcomeText(row)}</td>
							<td class="py-1">{reasonText(row)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
