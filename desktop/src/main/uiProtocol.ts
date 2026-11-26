/**
 * The local UI is served from `app://ui/`, not `file://`: a file page can read other files and
 * `grantFileProtocolExtraPrivileges` could then not be turned off. The handler maps the URL to a
 * file under the UI directory and nothing else.
 */
import { extname, join, normalize, resolve, sep } from "node:path";

export const UI_ORIGIN = "app://ui";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

/** The file for an `app://ui/...` URL, or undefined for anything outside the directory or of another type. */
export function resolveUiFile(
	root: string,
	url: string
): { path: string; type: string } | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (u.protocol !== "app:" || u.host !== "ui") return undefined;
	let rel: string;
	try {
		rel = decodeURIComponent(u.pathname);
	} catch {
		return undefined;
	}
	if (rel === "/" || rel === "") rel = "/index.html";
	if (rel.includes("\0") || rel.includes("\\")) return undefined;
	const base = resolve(root);
	const path = resolve(join(base, normalize(rel)));
	if (path !== base && !path.startsWith(base + sep)) return undefined;
	const type = TYPES[extname(path)];
	return type ? { path, type } : undefined;
}
