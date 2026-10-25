<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { formatNumber } from "$lib/i18n/format";
	import {
		compareTableCells,
		MAX_TABLE_RENDER_ROWS,
		parseCsvTable,
		rowMatchesQuery,
	} from "$lib/utils/csv";
	import { escapeHTML } from "$lib/utils/markedLight";

	import CarbonArrowUp from "~icons/carbon/arrow-up";
	import CarbonArrowDown from "~icons/carbon/arrow-down";

	/**
	 * The `table` artifact's preview: CSV with a header row gridded into a
	 * sortable, filterable table. Header copy/download in the panel chrome
	 * carry the full CSV; this view only slices what is shown.
	 *
	 * Streaming never reaches this component: like every other previewable
	 * kind, an incomplete version renders the raw text in the code tab until
	 * the closing tag lands.
	 */
	interface Props {
		content: string;
	}

	let { content }: Props = $props();

	let table = $derived(parseCsvTable(content));
	let query = $state("");
	/** Sorted column, or null for source order; a third click clears back to it. */
	let sortCol = $state<number | null>(null);
	let sortDir = $state<1 | -1>(1);

	function toggleSort(col: number) {
		if (sortCol !== col) {
			sortCol = col;
			sortDir = 1;
		} else if (sortDir === 1) {
			sortDir = -1;
		} else {
			sortCol = null;
			sortDir = 1;
		}
	}

	let filtered = $derived.by(() => {
		const rows = table?.rows ?? [];
		const matching = rows.filter((row) => rowMatchesQuery(row, query));
		if (sortCol === null || !table) return matching;
		const col = sortCol;
		const dir = sortDir;
		return [...matching].sort((a, b) => dir * compareTableCells(a[col] ?? "", b[col] ?? ""));
	});

	let totalRows = $derived(table?.rows.length ?? 0);
	let capped = $derived(filtered.length > MAX_TABLE_RENDER_ROWS);
	let shown = $derived(capped ? filtered.slice(0, MAX_TABLE_RENDER_ROWS) : filtered);

	let countLabel = $derived.by(() => {
		if (!table) return "";
		const q = query.trim();
		if (capped)
			return m["chat.table.count_capped"]({
				max: formatNumber(MAX_TABLE_RENDER_ROWS),
				shown: formatNumber(filtered.length),
				total: formatNumber(totalRows),
			});
		if (q) {
			return m["chat.table.count_filtered"]({
				shown: formatNumber(filtered.length),
				total: formatNumber(totalRows),
			});
		}
		return m["chat.table.count"]({ count: totalRows, formatted: formatNumber(totalRows) });
	});
</script>

{#if !table}
	<div class="px-6 py-5">
		<p class="mb-2 text-xs text-amber-600 dark:text-amber-400">
			{m["chat.table.plain_text"]()}
		</p>
		<!-- eslint-disable svelte/no-at-html-tags -->
		<pre
			class="scrollbar-custom max-h-full overflow-auto rounded-lg border border-gray-200/70 bg-gray-50 p-3 font-mono text-xs break-words whitespace-pre-wrap text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">{@html escapeHTML(
				content
			)}</pre>
	</div>
{:else}
	<div class="flex h-full flex-col" data-testid="table-grid">
		<div class="flex flex-none flex-wrap items-center gap-2 px-6 pt-4 pb-2">
			<label class="min-w-40 flex-1">
				<span class="sr-only">{m["chat.table.filter"]()}</span>
				<input
					type="search"
					bind:value={query}
					placeholder={m["chat.table.filter_placeholder"]()}
					aria-label={m["chat.table.filter"]()}
					class="w-full rounded-md border border-gray-200/80 bg-white px-2.5 py-1.5 text-xs text-gray-800 placeholder:text-ink-faint focus:border-blue-400 focus:outline-none dark:border-gray-700/80 dark:bg-gray-900 dark:text-gray-200"
				/>
			</label>
			<span class="flex-none text-xs text-gray-500 tabular-nums dark:text-gray-400">
				{countLabel}
			</span>
		</div>
		<div class="scrollbar-custom min-h-0 flex-1 overflow-auto px-6 pb-5">
			<table class="w-full border-collapse text-xs">
				<thead class="sticky top-0 z-10">
					<tr>
						{#each table.header as head, col (col)}
							<th
								scope="col"
								aria-sort={sortCol === col ? (sortDir === 1 ? "ascending" : "descending") : "none"}
								class="border border-gray-200 bg-gray-100 p-0 text-left font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
							>
								<button
									type="button"
									class="btn flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-left hover:bg-gray-200/70 dark:hover:bg-gray-700/70"
									title={sortCol === col
										? sortDir === 1
											? m["chat.table.sorted_asc"]()
											: m["chat.table.sorted_desc"]()
										: m["chat.table.sort_by"]({
												column: head || m["chat.table.column_lower"]({ number: col + 1 }),
											})}
									onclick={() => toggleSort(col)}
								>
									<span class="min-w-0 flex-1 truncate">{head || m["chat.table.column"]({ number: col + 1 })}</span>
									{#if sortCol === col}
										{#if sortDir === 1}
											<CarbonArrowUp class="flex-none text-xxs" />
										{:else}
											<CarbonArrowDown class="flex-none text-xxs" />
										{/if}
									{/if}
								</button>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each shown as row, r (`${r}:${row.join("|")}`)}
						<tr
							class="odd:bg-white even:bg-gray-50/60 dark:odd:bg-gray-900 dark:even:bg-gray-800/40"
						>
							{#each row as cell (cell)}
								<td
									class="max-w-64 truncate border border-gray-200 px-2 py-1 text-gray-800 dark:border-gray-700/70 dark:text-gray-200"
									title={cell}
								>
									{cell}
								</td>
							{/each}
						</tr>
					{:else}
						<tr>
							<td
								colspan={table.header.length}
								class="border border-gray-200 px-2 py-6 text-center text-gray-400 dark:border-gray-700/70"
							>
								{query.trim() ? m["chat.table.no_match"]() : m["chat.table.no_rows"]()}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}
