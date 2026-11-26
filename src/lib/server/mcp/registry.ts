import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { McpServerConfig } from "./httpClient";
import { resetMcpToolsCache } from "./tools";
import { connectorNameKey } from "$lib/utils/connectorName";

let cachedRaw: string | null = null;
let cachedServers: McpServerConfig[] = [];

function parseServers(raw: string): McpServerConfig[] {
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];

		return parsed
			.map((entry) => {
				if (!entry || typeof entry !== "object") return undefined;
				const name = (entry as Record<string, unknown>).name;
				const url = (entry as Record<string, unknown>).url;
				if (typeof name !== "string" || !name.trim()) return undefined;
				if (typeof url !== "string" || !url.trim()) return undefined;

				const headersRaw = (entry as Record<string, unknown>).headers;
				let headers: Record<string, string> | undefined;
				if (headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)) {
					const headerEntries = Object.entries(headersRaw as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string"
					);
					headers = Object.fromEntries(headerEntries);
				}

				const description = (entry as Record<string, unknown>).description;
				return {
					name,
					url,
					...(headers ? { headers } : {}),
					...(typeof description === "string" && description.trim()
						? { description: description.trim() }
						: {}),
				};
			})
			.filter((server): server is McpServerConfig => Boolean(server));
	} catch (error) {
		logger.warn({ err: error }, "[mcp] failed to parse MCP_SERVERS env");
		return [];
	}
}

/** Keeps the first of servers sharing a name (C169) and warns about the rest; never throws. */
export function dropDuplicateNames(servers: McpServerConfig[]): McpServerConfig[] {
	const seen = new Map<string, string>();
	const kept: McpServerConfig[] = [];
	for (const server of servers) {
		const key = connectorNameKey(server.name);
		const first = seen.get(key);
		if (first !== undefined) {
			logger.warn(
				{ kept: first, dropped: server.name },
				`[mcp] MCP_SERVERS has two servers named "${first}" and "${server.name}"; the first is kept and the later one is dropped. Rename it to use it.`
			);
			continue;
		}
		seen.set(key, server.name);
		kept.push(server);
	}
	return kept;
}

function setServers(raw: string) {
	cachedServers = dropDuplicateNames(parseServers(raw));
	cachedRaw = raw;
	resetMcpToolsCache();
	logger.debug({ count: cachedServers.length }, "[mcp] loaded server configuration");
	console.log(
		`[MCP] Loaded ${cachedServers.length} server(s):`,
		cachedServers.map((s) => s.name).join(", ") || "none"
	);
}

export function loadMcpServersOnStartup(): McpServerConfig[] {
	const raw = config.MCP_SERVERS || "[]";
	setServers(raw);
	return cachedServers;
}

export function getMcpServers(): McpServerConfig[] {
	if (cachedRaw === null) {
		loadMcpServersOnStartup();
	}
	return cachedServers;
}
