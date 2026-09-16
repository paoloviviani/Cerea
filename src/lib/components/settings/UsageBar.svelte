<!--
	One `UsageEntry`, rendered as a progress bar when it carries a `limit` and
	a plain stat row otherwise — the one shape that has to serve both Pystino's
	quota bars and a future stat-only provider with no changes here.
-->
<script lang="ts">
	import type { UsageEntry } from "$lib/types/UsageReport";

	interface Props {
		entry: UsageEntry;
	}

	let { entry }: Props = $props();

	// A currency code (e.g. "USD", "EUR") reads better formatted than a bare
	// number-and-unit pair; a metric name like "tokens" or "requests" does not.
	const isCurrency = $derived(/^[A-Z]{3}$/.test(entry.unit));

	function format(value: number): string {
		if (isCurrency) {
			try {
				return new Intl.NumberFormat(undefined, { style: "currency", currency: entry.unit }).format(
					value
				);
			} catch {
				// An unrecognised currency code from the gateway: fall through to
				// the plain number rather than throwing on render.
			}
		}
		return new Intl.NumberFormat().format(value);
	}

	const percent = $derived(
		!entry.unknown && entry.limit && entry.limit > 0
			? Math.min(100, (entry.used / entry.limit) * 100)
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
					unknown
				{:else}
					{format(entry.used)} / {format(entry.limit)}{isCurrency ? "" : ` ${entry.unit}`}
				{/if}
			{:else}
				{format(entry.used)}{isCurrency ? "" : ` ${entry.unit}`}
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
				? "unknown"
				: `${format(entry.used)} of ${format(entry.limit)} ${entry.unit}`}
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
