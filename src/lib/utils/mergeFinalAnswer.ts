export interface MergeFinalAnswerParams {
	/** Content accumulated on the message so far (streamed tokens). */
	existing: string;
	/** The FinalAnswer's text. */
	finalText: string;
	/** Whether any tool update occurred during this turn. */
	hadTools: boolean;
	/** Whether the run was interrupted (stopped). */
	isInterrupted: boolean;
}

/**
 * Comparison form for streamed-vs-final text. Line endings and Unicode
 * normalization routinely differ between a provider's streamed tokens and
 * its final text (CRLF vs LF, NFD vs NFC — the latter bites any language
 * with accented characters) while rendering identically. Comparing raw
 * bytes would read those as different answers and duplicate the message;
 * comparing normalized forms treats canonically identical text as identical.
 * Only the comparisons use this — stored content is never rewritten. The
 * server's applyUpdate.ts carries an identical copy; the two must stay in
 * sync or views diverge.
 */
export function normForCompare(text: string): string {
	return text.replace(/\r\n/g, "\n").normalize("NFC");
}

/** Comparison form with every whitespace run removed (see the step-break case). */
export function squashWhitespace(text: string): string {
	return text.replace(/\s+/g, "");
}

/**
 * Content for an assistant message when a FinalAnswer arrives, mirroring the server so
 * every view agrees. Isolated (and unit-tested) because this reconciliation of streamed
 * content with the provider's final text is where subtle content bugs live; both the
 * streaming and reattach paths route through it.
 */
export function mergeFinalAnswerContent({
	existing,
	finalText,
	hadTools,
	isInterrupted,
}: MergeFinalAnswerParams): string {
	if (isInterrupted) {
		if (!existing) return finalText;
		// The server may have clamped the persisted text back to the stop point. Adopt it
		// only when it is a prefix of ours, so this view matches what others will load;
		// otherwise keep our streamed content (continue flows send only post-prefix text).
		if (finalText && existing.startsWith(finalText)) return finalText;
		return existing;
	}

	if (hadTools) {
		// Providers often stream content, run tools, then return a different follow-up
		// message; preserve the pre-tool stream instead of letting the final text clobber it.
		// All comparisons run on normalized forms (see normForCompare): streamed
		// tokens and the final text routinely differ in line endings or Unicode
		// normalization while rendering identically, and byte comparison would
		// duplicate the answer.
		const normExisting = normForCompare(existing);
		const normFinal = normForCompare(finalText);
		const trimmedExistingSuffix = normExisting.replace(/\s+$/, "");
		const trimmedFinalPrefix = normFinal.replace(/^\s+/, "");
		// Right-trimmed final for the trailing-junk case: a provider final
		// that is the streamed text plus a trailing newline (or CRLF) must
		// still count as streamed, or it falls through to the join below
		// and the answer is stored twice.
		const trimmedFinalSuffix = normFinal.replace(/\s+$/, "");
		// Whitespace-free form for the step-break case: after a tool, the server
		// inserts a paragraph break where the next step's visible text starts,
		// which for a reasoning model is right after `</think>` — inside the
		// final text, not at its edges. Without this the final answer reads as
		// new and is appended a second time.
		const squashedFinal = squashWhitespace(normFinal);
		const alreadyStreamed =
			!!finalText &&
			(normExisting.endsWith(normFinal) ||
				(trimmedFinalPrefix.length > 0 && trimmedExistingSuffix.endsWith(trimmedFinalPrefix)) ||
				(trimmedFinalSuffix.length > 0 && trimmedExistingSuffix.endsWith(trimmedFinalSuffix)) ||
				(squashedFinal.length > 0 && squashWhitespace(normExisting).endsWith(squashedFinal)));

		if (existing.length > 0) {
			// A. We already streamed the same final text; keep it.
			if (alreadyStreamed) return existing;
			// B. The final text already includes the streamed prefix; use it verbatim.
			if (
				finalText &&
				(normFinal.startsWith(normExisting) ||
					(trimmedExistingSuffix.length > 0 &&
						trimmedFinalPrefix.startsWith(trimmedExistingSuffix)))
			) {
				return finalText;
			}
			// C. Distinct pre-tool and post-tool text; join with a paragraph break.
			const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(finalText);
			return existing + (needsGap ? "\n\n" : "") + finalText;
		}
		return finalText;
	}

	// No tools: the provider's final text is authoritative.
	return finalText;
}
