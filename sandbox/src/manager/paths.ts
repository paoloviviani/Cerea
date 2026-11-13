export const WORKSPACE = "/workspace";

export class BadPath extends Error {}

/**
 * A caller's path, as a path under /workspace. Refuses rather than resolves: a `..` segment, a NUL
 * or control character, a backslash, an over-long name. Leading slashes are dropped, so
 * `/etc/passwd` names `/workspace/etc/passwd`. The in-container scripts also resolve symlinks and
 * refuse a target outside /workspace.
 */
export function workspacePath(raw: string): string {
	let decoded = raw;
	if (/[\u0000-\u001f\u007f\\]/.test(decoded))
		throw new BadPath("the path has a control character or backslash");
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
