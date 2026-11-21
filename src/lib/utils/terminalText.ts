/**
 * Plain text out of an xterm buffer, for the copy overlay (a phone cannot
 * select text drawn by xterm, so the text is shown as ordinary DOM).
 *
 * xterm has already parsed the escape sequences, so a buffer line holds only
 * characters: "ANSI stripped" is inherent. What is left to do here is joining
 * rows the terminal wrapped (`isWrapped`) back into the logical line they
 * came from, trimming trailing blanks and dropping the empty rows below the
 * last output.
 */

/** The slice of xterm's `IBuffer` this needs (a structural subset). */
export interface TextBufferLine {
	readonly isWrapped: boolean;
	translateToString(trimRight?: boolean): string;
}

export interface TextBuffer {
	readonly length: number;
	getLine(y: number): TextBufferLine | undefined;
}

export interface BufferTextOptions {
	/** First buffer row to read (default 0: the oldest scrollback). */
	startRow?: number;
	/** One past the last row to read (default `buffer.length`). */
	endRow?: number;
	/** Keep only the last N logical lines. */
	maxLines?: number;
}

/** How many logical lines "Copy all" and the overlay keep. */
export const TERMINAL_TEXT_MAX_LINES = 5000;

export function bufferToText(buffer: TextBuffer, options: BufferTextOptions = {}): string {
	const start = Math.max(0, options.startRow ?? 0);
	const end = Math.min(buffer.length, options.endRow ?? buffer.length);
	const lines: string[] = [];
	for (let y = start; y < end; y++) {
		const line = buffer.getLine(y);
		if (!line) continue;
		// A wrapped row continues the previous one; only the last row's right edge is padding.
		const text = line.translateToString(true);
		if (line.isWrapped && lines.length > 0) {
			lines[lines.length - 1] += text;
		} else {
			lines.push(text);
		}
	}
	for (let i = 0; i < lines.length; i++) lines[i] = lines[i].trimEnd();
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const kept = options.maxLines !== undefined ? lines.slice(-options.maxLines) : lines;
	return kept.join("\n");
}
