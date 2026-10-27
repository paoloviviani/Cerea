/**
 * Fold a fresh list into the one already on screen, keeping the old object
 * for every row whose content did not change. A keyed `{#each}` over the
 * result then touches nothing but the rows that really differ, in the order
 * the fresh list gives; when nothing differs the very same array comes back,
 * so nothing downstream even re-runs. Rows are matched by `id`.
 */
export function reconcileById<T extends { id: string }>(
	prev: readonly T[],
	next: readonly T[]
): T[] {
	const byId = new Map<string, { row: T; json: string }>();
	for (const row of prev) byId.set(row.id, { row, json: JSON.stringify(row) });
	let same = prev.length === next.length;
	const merged = next.map((row, i) => {
		const old = byId.get(row.id);
		const keep = old && old.json === JSON.stringify(row) ? old.row : row;
		if (same && prev[i] !== keep) same = false;
		return keep;
	});
	return same ? (prev as T[]) : merged;
}
