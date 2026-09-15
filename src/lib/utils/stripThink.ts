/**
 * Remove `<think>` blocks and their contents from model output.
 *
 * The unterminated case matters: when a generation budget runs out mid-trace
 * the closing tag never arrives, so an anchored `$` alternative is what stops
 * raw reasoning from leaking out as if it were the answer.
 */
export function stripThink(content: string): string {
	return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
}

const THINK_CAPTURE_REGEX = /<think>([\s\S]*?)(?:<\/think>|$)/g;

/**
 * Collect the inner contents of every `<think>` block in model output.
 *
 * Uses the exact same pattern as {@link stripThink} so the two always
 * partition the content identically: `extractThink(c)` holds what
 * `stripThink(c)` removed. An unterminated trailing block (budget cutoff,
 * stopped run) yields the text up to the end of the string.
 */
export function extractThink(content: string): string[] {
	const out: string[] = [];
	THINK_CAPTURE_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = THINK_CAPTURE_REGEX.exec(content)) !== null) {
		const inner = match[1].trim();
		if (inner.length > 0) out.push(inner);
	}
	return out;
}
