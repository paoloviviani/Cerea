/**
 * A turn's connectors, loaded on demand (ADR 0104).
 *
 * `runMcpFlow` starts a turn with the connectors that are always loaded and
 * the ones this conversation loaded earlier. The assistant gets the rest as
 * one line each and loads one with `load_tools`; a call straight to a tool of
 * a connector it has not loaded loads it too, instead of failing.
 *
 * Loading **appends**: the new connector's tool definitions go after the ones
 * already sent, so the start of the request is unchanged and prompt caching
 * keeps working. The `servers`, `mapping` and `tools` it is given are the
 * turn's own and are changed in place, which is how the next model round, the
 * tool dispatch and a sub-agent all see the new tools without being told.
 *
 * Nothing here contacts a connector until it is loaded.
 */

import { sanitizeName, type McpToolMapping, type OpenAiTool } from "$lib/server/mcp/tools";
import type { McpServerConfig } from "$lib/server/mcp/httpClient";
import type { ResolvedServer } from "$lib/server/mcp/selection";
import type { BlockedConnector, TurnConnector } from "$lib/server/mcp/turnConnectors";
import type { ConnectorRuntime, LoadReport } from "../builtinTools/loadToolsTool";
import { logger } from "$lib/server/logger";

export interface ConnectorRuntimeOptions {
	connectors: TurnConnector[];
	blocked: BlockedConnector[];
	/** Keys loaded at the start of the turn, in order. */
	loadedKeys: string[];
	/** The loaded servers, prepared for use; changed in place. */
	servers: McpServerConfig[];
	/** Tool name -> server and tool; changed in place. */
	mapping: Record<string, McpToolMapping>;
	/** What each model round is sent; new tools are pushed on the end. */
	tools: OpenAiTool[];
	/** The MCP tools (repaired) as a nested agent reads them; new ones are pushed on the end. */
	mcpTools: OpenAiTool[];
	/** Tool names the built-in tools already use. An MCP tool with one of them is not offered. */
	builtinNames: Set<string>;
	/** Address safety and the per-server header overlays, as for the turn's first servers. */
	prepare(servers: ResolvedServer[]): McpServerConfig[];
	list(servers: McpServerConfig[]): Promise<{
		tools: OpenAiTool[];
		mapping: Record<string, McpToolMapping>;
		unavailable?: Array<{ name: string; reason: string }>;
	}>;
	repair(
		tools: OpenAiTool[],
		mapping: Record<string, McpToolMapping>,
		servers: McpServerConfig[]
	): OpenAiTool[];
	/** Remember newly loaded keys on the conversation. */
	persist(keys: string[]): Promise<void>;
	/** Told after tools were added (to refresh what depends on them). */
	onLoaded?(newTools: OpenAiTool[]): void;
}

export interface TurnConnectorRuntime extends ConnectorRuntime {
	/** Load the connector owning each of these tool names that is not callable yet. */
	loadForCalls(toolNames: string[]): Promise<LoadReport[]>;
	loadedKeys(): string[];
}

const norm = (s: string) => s.trim().toLowerCase();

export function createConnectorRuntime(options: ConnectorRuntimeOptions): TurnConnectorRuntime {
	const { connectors, blocked, servers, mapping, tools, mcpTools, builtinNames } = options;
	const loaded = new Set(options.loadedKeys);
	const order = [...options.loadedKeys];
	let version = 0;
	// One load at a time: two rounds' worth of calls (or a nested agent) must not interleave
	// their changes to the shared lists.
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = chain.then(fn, fn);
		chain = next.catch(() => undefined);
		return next;
	};

	const find = (name: string): TurnConnector | undefined =>
		connectors.find((c) => c.key === name) ??
		connectors.find((c) => norm(c.name) === norm(name)) ??
		connectors.find((c) => norm(c.name).startsWith(norm(name)) && norm(name).length >= 3);

	const toolNamesOf = (connectorName: string): string[] =>
		Object.values(mapping)
			.filter((entry) => entry.server === connectorName)
			.map((entry) => entry.fnName);

	async function loadOne(connector: TurnConnector): Promise<LoadReport> {
		if (loaded.has(connector.key)) {
			return { name: connector.name, status: "already", tools: toolNamesOf(connector.name) };
		}
		const opened = await connector.open();
		if (!("server" in opened)) {
			return { name: connector.name, status: "unavailable", reason: opened.unavailable };
		}
		const [prepared] = options.prepare([opened.server]);
		if (!prepared) {
			return { name: connector.name, status: "unavailable", reason: "its address is not allowed" };
		}
		const listing = await options.list([...servers, prepared]);
		const failed = listing.unavailable?.find((entry) => entry.name === prepared.name);
		if (failed) {
			return { name: connector.name, status: "unavailable", reason: failed.reason };
		}
		const fresh = listing.tools.filter((tool) => !(tool.function.name in mapping));
		const freshMapping: Record<string, McpToolMapping> = {};
		for (const tool of fresh) {
			const entry = listing.mapping[tool.function.name];
			if (entry) freshMapping[tool.function.name] = entry;
		}
		servers.push(prepared);
		Object.assign(mapping, freshMapping);
		// A tool that shares a built-in's name is not offered: dispatch checks built-ins first.
		const offered = options
			.repair(fresh, mapping, servers)
			.filter((tool) => !builtinNames.has(tool.function.name));
		// Appended after what was already sent, never in between.
		tools.push(...offered);
		mcpTools.push(...offered);
		loaded.add(connector.key);
		order.push(connector.key);
		version += 1;
		options.onLoaded?.(offered);
		return { name: connector.name, status: "loaded", tools: offered.map((t) => t.function.name) };
	}

	const load = (names: string[]): Promise<LoadReport[]> =>
		serial(async () => {
			const reports: LoadReport[] = [];
			const newKeys: string[] = [];
			for (const name of names) {
				const connector = find(name);
				if (!connector) {
					const stopped = blocked.find((b) => norm(b.name) === norm(name) || b.key === name);
					reports.push(
						stopped ? { name: stopped.name, status: stopped.reason } : { name, status: "unknown" }
					);
					continue;
				}
				try {
					const report = await loadOne(connector);
					reports.push(report);
					if (report.status === "loaded") newKeys.push(connector.key);
				} catch (err) {
					logger.warn({ err: String(err), connector: connector.name }, "[mcp] load_tools failed");
					reports.push({
						name: connector.name,
						status: "unavailable",
						reason: "it did not answer",
					});
				}
			}
			if (newKeys.length > 0) {
				await options
					.persist(newKeys)
					.catch((err) =>
						logger.warn({ err: String(err) }, "[mcp] loaded connectors not recorded")
					);
			}
			return reports;
		});

	return {
		get version() {
			return version;
		},
		load,
		loadedKeys: () => [...order],
		async loadForCalls(toolNames) {
			const missing = toolNames.filter((name) => !(name in mapping) && !builtinNames.has(name));
			if (missing.length === 0) return [];
			const owners = new Set<string>();
			for (const connector of connectors) {
				if (loaded.has(connector.key)) continue;
				const provided = new Set(connector.toolNames.map(sanitizeName));
				if (missing.some((name) => provided.has(name))) owners.add(connector.key);
			}
			return owners.size === 0 ? [] : load([...owners]);
		},
	};
}
