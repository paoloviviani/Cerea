/** Repeated lines shown once with a count: "reconnecting in 25s" and "in 50s" are the same line. */
export function dedupeLog(lines: string[]): { text: string; count: number }[] {
	const out: { key: string; text: string; count: number }[] = [];
	for (const text of lines) {
		const key = text.replace(/\d+/g, "#");
		const last = out[out.length - 1];
		if (last && last.key === key) {
			last.count += 1;
			last.text = text; // the latest wording
		} else out.push({ key, text, count: 1 });
	}
	return out.map(({ text, count }) => ({ text, count }));
}
