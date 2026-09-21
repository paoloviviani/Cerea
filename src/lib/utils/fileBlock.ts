/**
 * Direct-emission file blocks: a fenced code block whose info string names a
 * file (```markdown title=report.md) is the model handing over a finished
 * text file, not code to display or run. The block's content IS the file's
 * bytes, emitted verbatim — no Python wrapper, no sandbox, no execution.
 *
 * Why this exists: for a text deliverable (markdown, CSV, JSON, YAML, plain
 * text) the only path before was Python code that writes the file in the
 * browser sandbox — wrapper-token overhead, triple-quote hazards in the
 * content, and a file that dies with the page. A directly-emitted block is
 * ordinary message content instead, so it survives reload, the Markdown
 * export and share links by construction. Binary or computed files keep the
 * sandbox path; there is no alternative for those.
 *
 * Detection requires an explicit annotation token in the info string. A bare
 * language tag (```python) or a bare word never triggers, so detection cannot
 * collide with language identifiers. `title=` is the one form the prompt
 * teaches; `file=` and `filename=` are accepted aliases because models drift
 * toward them on their own.
 */

export interface FileBlockInfo {
	/** The language token(s) before the annotation, e.g. "markdown". Empty when the annotation is the whole info string. */
	language: string;
	/** The annotated filename, e.g. "report.md". */
	filename: string;
}

// The annotation must be its own token (preceded by start-of-string or
// whitespace), so "notfile=x" or "subtitle=x" never match. The value may be
// quoted (models often emit title="report.md") or bare.
const ANNOTATION_PATTERN = /(?:^|\s)(title|file|filename)\s*=\s*("([^"]*)"|'([^']*)'|(\S*))/i;

/**
 * Parse a fence info string into a file-block annotation, or null when the
 * block is an ordinary code fence. Tolerates whitespace around `=` and
 * ignores trailing tokens after the annotation.
 */
export function parseFileBlockInfo(infoString: string | undefined | null): FileBlockInfo | null {
	if (!infoString) return null;
	const match = ANNOTATION_PATTERN.exec(infoString);
	if (!match) return null;
	const filename = (match[3] ?? match[4] ?? match[5] ?? "").trim();
	if (!filename) return null;
	return { language: infoString.slice(0, match.index).trim(), filename };
}

/**
 * UTF-8 byte length of a directly-emitted block's content: the card shows the
 * size the download will have, and the only bytes that exist are this text.
 */
export function fileBlockByteSize(content: string): number {
	return new TextEncoder().encode(content).length;
}

/** Human size for the file row; mirrors FileCard so the two cards agree. */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Hand a directly-emitted block's text to the browser as a download under its
 * annotated filename. Same blob-anchor dance as FileCard's sandbox download,
 * but the bytes are already here — no worker filesystem to read from, which
 * is also why this download (unlike a sandbox file's) cannot go stale.
 */
export function downloadTextAsFile(filename: string, content: string): void {
	const url = URL.createObjectURL(new Blob([new TextEncoder().encode(content)]));
	try {
		const link = window.document.createElement("a");
		link.href = url;
		link.download = filename;
		link.rel = "noopener";
		window.document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
