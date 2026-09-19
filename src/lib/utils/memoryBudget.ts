import { MEMORY_BLOCK_MAX_CHARS } from "$lib/types/Memory";

export interface MemoryBudgetResult {
	/** Indices into the oldest-first input that fit, in the same order. */
	included: number[];
	/** How many did not fit, and are therefore not sent to the model. */
	omitted: number;
}

/**
 * Decide which stored facts fit in the prompt's memory block.
 *
 * Shared by the two places that must agree about it: the server building the
 * block, and the Memory screen marking the rows that are no longer being
 * sent. Two copies of this arithmetic would drift, and the drift would be
 * invisible — the screen would claim a fact is in the prompt while the
 * prompt has dropped it, which is worse than having no such warning at all.
 *
 * **Newest wins.** Filling proceeds from the most recent fact backwards, so
 * a tight budget keeps what was learned most recently and drops what is
 * oldest. That is the opposite of how the list is *rendered* (chronological,
 * so it reads as a history), which is why this returns indices rather than
 * text: the caller orders, this only decides.
 *
 * One fact always survives, however long. A single 400-character fact
 * exceeding the whole budget would otherwise produce an empty block, and
 * silence is a worse answer than one long line.
 */
export function fitMemoriesToBudget(
	texts: string[],
	maxChars: number = MEMORY_BLOCK_MAX_CHARS
): MemoryBudgetResult {
	const included: number[] = [];
	let used = 0;
	for (let index = texts.length - 1; index >= 0; index -= 1) {
		// `- ` prefix and the newline that joins it to the next line: the block's
		// real cost per fact, not the bare text length.
		const cost = texts[index].length + 3;
		if (used + cost > maxChars && included.length > 0) continue;
		included.push(index);
		used += cost;
	}
	included.reverse();
	return { included, omitted: texts.length - included.length };
}
