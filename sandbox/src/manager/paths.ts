export const WORKSPACE = "/workspace";

export class BadPath extends Error {}

/**
 * A caller's path, as a path under /workspace. Refuses rather than resolves: a `..` segment, a NUL
 * or control character, a backslash, an over-long name. Leading slashes are dropped, so
 * `/etc/passwd` names `/workspace/etc/passwd`. The in-container scripts also resolve symlinks and
 * refuse a target outside /workspace, but that is a courtesy, not a boundary: code running in the
 * sandbox owns the file system and can swap a link between the check and the use. The boundary
 * is the container itself (gVisor, a workspace of its own, no host mounts).
 */
export function workspacePath(raw: string): string {
	let decoded = raw;
	for (let i = 0; i < decoded.length; i++) {
		const c = decoded.charCodeAt(i);
		if (c < 0x20 || c === 0x7f || c === 0x5c) {
			throw new BadPath("the path has a control character or backslash");
		}
	}
	if (decoded.length > 1024) throw new BadPath("the path is too long");
	const parts: string[] = [];
	for (const seg of decoded.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new BadPath("the path may not contain ..");
		if (seg.length > 255) throw new BadPath("a path segment is too long");
		parts.push(seg);
	}
	decoded = parts.join("/");
	if (!decoded) throw new BadPath("the path is empty");
	return `${WORKSPACE}/${decoded}`;
}

/** Same rules, but the workspace itself is a valid answer (a working directory). */
export function workspaceDir(raw: string | undefined): string {
	if (raw === undefined || raw === "" || raw === "." || raw === "/") return WORKSPACE;
	return workspacePath(raw);
}
