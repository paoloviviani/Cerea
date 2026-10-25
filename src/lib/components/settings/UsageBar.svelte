<!--
	One `UsageEntry`, rendered as a progress bar when it carries a `limit` and
	a plain stat row otherwise — the one shape that has to serve both Pystino's
	quota bars and a future stat-only provider with no changes here.

	An entry marked `noFigures` (a shared budget: its "used" figure is a
	group's or the deployment's total, which never left the server) renders as
	a statement of the rule and its period, with no amount and no bar.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { formatCurrency, formatNumber } from "$lib/i18n/format";
	import type { UsageEntry } from "$lib/types/UsageReport";

	interface Props {
		entry: UsageEntry;
	}

	let { entry }: Props = $props();

	// A currency code (e.g. "USD", "EUR") reads better formatted than a bare
	// number-and-unit pair; a metric name like "tokens" or "requests" does not.
	const isCurrency = $derived(/^[A-Z]{3}$/.test(entry.unit));

	// In the page's language, not the browser's. An unrecognised currency code
	// from the gateway falls back to the plain number (formatCurrency).
	function format(value: number): string {
		return isCurrency ? formatCurrency(value, entry.unit) : formatNumber(value);
	}

	/** "12 / 50 tokens", or "$12.00 / $50.00" where the unit is a currency. */
	function ratio(used: number, limit: number): string {
		const inputs = { used: format(used), limit: format(limit), unit: entry.unit };
		return isCurrency
			? m["settings.usage_bar.used_of_limit"](inputs)
			: m["settings.usage_bar.used_of_limit_unit"](inputs);
	}

	/** "12 tokens", or "$12.00". */
	function amount(value: number): string {
		return isCurrency
			? format(value)
			: m["settings.usage_bar.with_unit"]({ amount: format(value), unit: entry.unit });
	}

	const percent = $derived(
		!entry.unknown && entry.limit && entry.limit > 0
			? Math.min(100, ((entry.used ?? 0) / entry.limit) * 100)
			: 0
	);
	const nearLimit = $derived(percent >= 90);
</script>

<div class="py-2">
	<div class="flex items-baseline justify-between gap-2 text-[13px]">
		<span class="font-medium text-gray-800 dark:text-gray-200">
			{entry.label}
			{#if entry.scope}
				<span
					class="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-normal text-gray-500 dark:bg-gray-700 dark:text-gray-400"
					>{entry.scope}</span
				>
			{/if}
		</span>
		<span class="shrink-0 text-[12px] text-gray-500 dark:text-gray-400">
			{#if entry.limit !== undefined}
				{#if entry.unknown}
					{m["settings.usage_bar.unknown"]()}
				{:else}
					{ratio(entry.used ?? 0, entry.limit)}
				{/if}
			{:else if entry.noFigures}
				<span class="text-gray-400 dark:text-gray-500"
					>{m["settings.usage_bar.figures_hidden"]()}</span
				>
			{:else}
				{amount(entry.used ?? 0)}
			{/if}
			{#if entry.period}
				<span class="text-gray-400 dark:text-gray-500">· {entry.period}</span>
			{/if}
		</span>
	</div>
	{#if entry.limit !== undefined}
		<div
			role="progressbar"
			aria-label={entry.label}
			aria-valuemin={0}
			aria-valuemax={entry.unknown ? undefined : entry.limit}
			aria-valuenow={entry.unknown ? undefined : entry.used}
			aria-valuetext={entry.unknown
				? m["settings.usage_bar.unknown"]()
				: m["settings.usage_bar.used_of"]({
						used: format(entry.used ?? 0),
						limit: format(entry.limit),
						unit: entry.unit,
					})}
			class="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
		>
			{#if !entry.unknown}
				<div
					class="h-full rounded-full transition-[width] {nearLimit ? 'bg-red-500' : 'bg-blue-600'}"
					style="width: {percent}%"
				></div>
			{/if}
		</div>
	{/if}
</div>
