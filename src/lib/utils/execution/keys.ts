/**
 * Stable keys for execution results.
 *
 * Chat blocks key on content hash: identical code in one session runs once,
 * wherever it appears. Artifact cells key on identity + version + content
 * hash, so an edit that changes the code invalidates its stored output
 * without needing a new version number.
 */

export function hashCode(code: string): string {
	let hash = 5381;
	for (let i = 0; i < code.length; i++) {
		hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
	}
	return (hash >>> 0).toString(36);
}

/** Stable key for a chat code block: identical code in one session runs once. */
export function chatRunKey(code: string): string {
	return `chat:${hashCode(code)}`;
}

/** Stable key for an artifact code cell's output at a specific version. */
export function artifactRunKey(identifier: string, version: number, content: string): string {
	return `artifact:${identifier}:v${version}:${hashCode(content)}`;
}

/**
 * Whether a stored Outputs record belongs to a code block or cell (which
 * finds it by its own key) rather than to a tool that produced files with no
 * code to sit under — `convert_document`'s PDF. Those render as their own
 * card in the message, where the tool ran.
 */
export function isCodeRunKey(runKey: string): boolean {
	return runKey.startsWith("chat:") || runKey.startsWith("artifact:");
}
