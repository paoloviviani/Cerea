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
