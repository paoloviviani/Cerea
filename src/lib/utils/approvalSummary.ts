import { m } from "$lib/paraglide/messages";
import type { PermissionClass } from "$lib/types/machineProtocol";

/**
 * Plain words for a tool-approval card: a title a non-developer can read, and
 * risk tags that say what saying yes lets happen. The raw command or JSON stays
 * one click away on the card ("Show details"); this only describes it.
 *
 * Tags come from the machine's own permission class (and its read-only stamp)
 * when the ask carries them, and from the tool name otherwise. A bash command
 * is also read for the few shapes that change the picture: a download piped to
 * a shell, a delete, a network fetch, a secrets path. The analysis is textual
 * and only ever ADDS a warning to what the class says; it never removes one,
 * except the machine's own read-only stamp, which the machine sets alone.
 */
export type RiskTag =
	| "readonly"
	| "changes"
	| "runs"
	| "deletes"
	| "network"
	| "secrets"
	| "outside"
	| "agents"
	| "connector";

/** Tags whose "always allow" asks for a second click. */
export const CONFIRM_ALWAYS_TAGS: ReadonlySet<RiskTag> = new Set(["deletes", "network", "secrets"]);

export const RISK_LABELS: Record<RiskTag, () => string> = {
	readonly: m["chat.approval.risk.readonly"],
	changes: m["chat.approval.risk.changes"],
	runs: m["chat.approval.risk.runs"],
	deletes: m["chat.approval.risk.deletes"],
	network: m["chat.approval.risk.network"],
	secrets: m["chat.approval.risk.secrets"],
	outside: m["chat.approval.risk.outside"],
	agents: m["chat.approval.risk.agents"],
	connector: m["chat.approval.risk.connector"],
};

export interface ApprovalInput {
	tool: string;
	args: Record<string, unknown>;
	class?: PermissionClass | null;
	readOnly?: boolean | null;
	/** The chat surface: `tool` is "‹connector›:‹tool›" and args are a model's own. */
	chat?: boolean;
}

export interface ApprovalSummary {
	title: string;
	tags: RiskTag[];
	/** The exact thing that will run, when there is one (a command, a path, a URL). */
	detail?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function first(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = text(args[key]);
		if (value) return value;
	}
	return "";
}

function clip(value: string, max = 60): string {
	const line = value.split("\n")[0];
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

const SHELL_PIPE = /\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/;
const FETCH =
	/\b(curl|wget|git\s+(clone|pull|fetch|push)|pip3?\s+install|npm\s+(i|install|ci)|pnpm\s+(i|install|add)|yarn\s+add|apt(-get)?\s+install|brew\s+install|cargo\s+install|go\s+get)\b/;
const SECRET_PATH =
	/(\.ssh\b|\.env\b|id_rsa|id_ed25519|\.aws\b|\.npmrc|\.netrc|credentials|\/etc\/shadow|\bsudo\b|\bprintenv\b)/;
const DELETE = /(^|[;&|]\s*|\bsudo\s+)(rm|rmdir|unlink|shred)\s+([^;&|]*)/;

/** What a shell command is, in words, and which warnings it adds. */
export function analyseCommand(command: string): { title: string; extra: RiskTag[] } {
	const extra: RiskTag[] = [];
	if (SECRET_PATH.test(command)) extra.push("secrets");
	if (SHELL_PIPE.test(command)) {
		return {
			title: m["chat.approval.title.remote_script"](),
			extra: [...extra, "network", "runs"],
		};
	}
	const del = DELETE.exec(command);
	if (del) {
		const words = del[3].split(/\s+/).filter(Boolean);
		const flags = words.filter((w) => w.startsWith("-")).join("");
		const targets = words.filter((w) => !w.startsWith("-"));
		const target = targets[0] ? baseName(targets[0]) : "";
		if (target) {
			const folder = /r/i.test(flags) || del[2] === "rmdir" || targets[0].endsWith("/");
			return {
				title:
					(folder
						? m["chat.approval.title.delete_folder"]({ name: clip(target) })
						: m["chat.approval.title.delete_file"]({ name: clip(target) })) +
					(targets.length > 1
						? m["chat.approval.title.and_more"]({ count: targets.length - 1 })
						: ""),
				extra: [...extra, "deletes"],
			};
		}
		return { title: m["chat.approval.title.delete_generic"](), extra: [...extra, "deletes"] };
	}
	if (FETCH.test(command)) extra.push("network");
	return { title: m["chat.approval.title.run_command"]({ command: clip(command, 70) }), extra };
}

const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);
const READ_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "codesearch", "lsp"]);
const WEB_TOOLS = new Set(["webfetch", "websearch"]);

function classOf(input: ApprovalInput): PermissionClass | "readonly" | null {
	if (input.class) return input.class;
	const tool = input.tool.toLowerCase();
	if (tool === "bash") return "command";
	if (EDIT_TOOLS.has(tool)) return "edit";
	if (WEB_TOOLS.has(tool)) return "web";
	if (READ_TOOLS.has(tool)) return "readonly";
	if (tool === "external_directory") return "outside";
	if (tool === "task" || tool.startsWith("session_")) return "agents";
	if (tool === "doom_loop") return "loop";
	return null;
}

const READ_VERBS =
	/^(search|get|list|read|find|fetch|lookup|look_up|query|view|show|describe|count|check)\b/i;

function connectorSummary(input: ApprovalInput): ApprovalSummary {
	const colon = input.tool.indexOf(":");
	const server = colon > 0 ? input.tool.slice(0, colon) : "";
	const name = (colon > 0 ? input.tool.slice(colon + 1) : input.tool).replace(/[_-]+/g, " ").trim();
	const reads = READ_VERBS.test(name);
	const query = reads ? first(input.args, ["query", "q", "search", "term", "keywords"]) : "";
	const action = query
		? m["chat.approval.title.connector_for"]({ action: name, query: clip(query, 50) })
		: name;
	return {
		title: server
			? m["chat.approval.title.connector"]({ server, action })
			: m["chat.approval.title.tool"]({ tool: input.tool }),
		tags: reads ? ["readonly"] : ["connector"],
	};
}

export function summarizeApproval(input: ApprovalInput): ApprovalSummary {
	if (input.chat) return connectorSummary(input);
	const cls = classOf(input);
	const tool = input.tool.toLowerCase();
	const { args } = input;
	const path = first(args, ["filepath", "filePath", "file_path", "path", "file"]);
	let title: string = m["chat.approval.title.tool"]({ tool: input.tool });
	let detail: string | undefined;
	const tags: RiskTag[] = [];

	if (tool === "bash" || cls === "command") {
		const command = first(args, ["command", "cmd"]);
		if (command) {
			const analysed = analyseCommand(command);
			title = analysed.title;
			detail = command;
			tags.push(...analysed.extra);
		} else {
			title = m["chat.approval.title.run_generic"]();
		}
		if (input.readOnly === true && tags.length === 0) {
			tags.push("readonly");
			if (command) title = m["chat.approval.title.run_readonly"]({ command: clip(command, 70) });
		} else tags.unshift("runs");
	} else if (cls === "edit") {
		title = path
			? m["chat.approval.title.edit_file"]({ name: clip(baseName(path)) })
			: m["chat.approval.title.edit_generic"]();
		detail = path || undefined;
		tags.push("changes");
	} else if (cls === "readonly") {
		const pattern = first(args, ["pattern", "query"]);
		title = pattern
			? m["chat.approval.title.search_project"]({ pattern: clip(pattern, 50) })
			: path
				? m["chat.approval.title.read_file"]({ name: clip(baseName(path)) })
				: m["chat.approval.title.read_generic"]();
		detail = path || pattern || undefined;
		tags.push("readonly");
	} else if (cls === "web") {
		const url = first(args, ["url"]);
		const query = first(args, ["query"]);
		title = url
			? m["chat.approval.title.open_url"]({ url: clip(url.replace(/^https?:\/\//, ""), 60) })
			: query
				? m["chat.approval.title.web_search"]({ query: clip(query, 50) })
				: m["chat.approval.title.web_generic"]();
		detail = url || query || undefined;
		tags.push("network");
	} else if (cls === "outside") {
		title = path
			? m["chat.approval.title.outside_path"]({ path: clip(path, 70) })
			: m["chat.approval.title.outside_generic"]();
		detail = path || undefined;
		tags.push("outside");
	} else if (cls === "agents") {
		title = m["chat.approval.title.agents"]();
		tags.push("agents");
	} else if (cls === "secrets") {
		title = m["chat.approval.title.secrets"]();
		tags.push("secrets");
	} else if (cls === "loop") {
		title = m["chat.approval.title.loop"]();
	} else if (cls === "tools") {
		tags.push("connector");
	}
	// The machine's class always shows, even when the tool name said something else.
	if (cls === "secrets" || cls === "outside" || cls === "web") {
		const own: RiskTag = cls === "web" ? "network" : cls;
		if (!tags.includes(own)) tags.push(own);
	}
	return { title, tags: [...new Set(tags)], detail };
}
