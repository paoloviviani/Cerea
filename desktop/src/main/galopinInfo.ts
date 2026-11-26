/** What the galopin tab shows, worked out from files and PATH (no galopin command needed). */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Tool } from "../shared/ipc.ts";

export const TOOL_LABELS: Record<Tool, string> = {
	opencode: "opencode",
	goose: "goose",
	vibe: "Vibe",
	claude: "Claude Code",
};

/** The command each tool is found by on PATH. */
const COMMAND: Record<Tool, string> = {
	opencode: "opencode",
	goose: "goose",
	vibe: "vibe",
	claude: "claude",
};

/** Where `galopin setup TOOL --default` puts its shim, under the install directory. */
export const shimFile = (installDir: string, tool: Tool) => join(installDir, "galopin-shims", tool);

export function toolsInfo(opts: {
	path: string;
	home: string;
	/** The directory galopin's shims live in: its own `claude` shim is not the tool being installed. */
	installDir: string;
	exists?: (p: string) => boolean;
}): { tool: Tool; label: string; installed: boolean; byDefault: boolean }[] {
	const exists = opts.exists ?? existsSync;
	const shims = resolve(join(opts.installDir, "galopin-shims"));
	const dirs = [
		...opts.path.split(delimiter).filter(Boolean),
		join(opts.home, ".opencode", "bin"),
	].filter((d) => resolve(d) !== shims);
	return (Object.keys(COMMAND) as Tool[]).map((tool) => ({
		tool,
		label: TOOL_LABELS[tool],
		installed: dirs.some((d) => exists(join(d, COMMAND[tool]))),
		byDefault: exists(shimFile(opts.installDir, tool)),
	}));
}

/** How many local connectors mcp.json lists (the browser is not one of them), and whether the browser is set up. */
export function mcpSummary(file: string): { connectors: number; browser: boolean } {
	try {
		const servers =
			(JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> })
				.mcpServers ?? {};
		const names = Object.keys(servers);
		return {
			connectors: names.filter((n) => n !== "cerea-browser").length,
			browser: names.includes("cerea-browser"),
		};
	} catch {
		return { connectors: 0, browser: false };
	}
}

/** The sign-in is expired when the latest word about it in galopin's output is the gateway's refusal. */
export function signInState(lines: string[]): "ok" | "expired" {
	for (let i = lines.length - 1; i >= 0; i--) {
		const l = lines[i];
		if (/invalid_grant|galopin auth login|sign-in to the gateway expired/i.test(l))
			return "expired";
		if (/link: connected|signed in|enrolled|paired\b/i.test(l)) return "ok";
	}
	return "ok";
}

export { dedupeLog } from "../shared/dedupe.ts";
