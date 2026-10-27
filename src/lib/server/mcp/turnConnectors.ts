/**
 * The connectors a turn may use, decided on the server (ADR 0104).
 *
 * The one resolver for every path that builds a turn: the turn route, the
 * parked-turn and tool-approval sweepers (through `mcpLocalsFor`), a resume,
 * and the nested agents, which inherit what the turn resolved. Its inputs are
 * the deployment's policies, this person's own switches and the
 * conversation's loaded set. The browser sends nothing and can widen or
 * narrow nothing.
 *
 * Resolving costs no connection to any connector. A connector that is on but
 * not loaded is only a line for the assistant (name, a sentence, the tool
 * names from `catalogCache`/its row); its credential is looked up and it is
 * contacted only when the assistant loads it, or calls one of its tools.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { McpConnector } from "$lib/types/McpConnector";
import type { McpServerConfig } from "./httpClient";
import { getMcpServers } from "./registry";
import { knownTools, type CatalogTool } from "./catalogCache";
import {
	baseKey,
	connectorKey,
	isEnabled,
	isLocalKey,
	loadPolicies,
	loadSwitches,
	policyIn,
} from "./deploymentModes";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { resolveLocalSelection, localConnectorViews } from "./local";

import type { ResolvedServer } from "./selection";

export interface TurnConnector {
	key: string;
	name: string;
	kind: "base" | "connector" | "local";
	/** Loaded from the start of every turn (a deployment policy). */
	alwaysLoaded: boolean;
	/** One sentence for the assistant: its description, else made from its tool names. */
	summary: string;
	/** Tool names as last seen; empty when it has never been listed. */
	toolNames: string[];
	/** The server to call, with this person's credential, or why it cannot be used now. */
	open(): Promise<{ server: ResolvedServer } | { unavailable: string }>;
}

/** Connectors left out of the list, for `load_tools` to explain: switched off by the person, or needing a sign-in. */
export interface BlockedConnector {
	key: string;
	name: string;
	reason: "switched off" | "needs sign-in";
}

export interface ResolvedConnectors {
	connectors: TurnConnector[];
	blocked: BlockedConnector[];
}

export function summaryOf(description: string | undefined, tools: CatalogTool[]): string {
	if (description?.trim()) return description.trim();
	const first = tools.find((t) => t.description?.trim())?.description?.trim();
	if (first) {
		const sentence = first.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, " ");
		return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
	}
	return tools.length > 0
		? "Tools it offers are listed below."
		: "Its tools are listed when you load it.";
}

/**
 * A connector row's tools are the ones its own last check stored on it. Never the address cache:
 * two rows may share an address, and a listing made with one person's credential is theirs.
 */
function toolsOfRow(row: McpConnector): CatalogTool[] {
	return row.tools ?? [];
}

/**
 * Every connector that is on for this person, with the ones that are not
 * because of their own switch or a missing sign-in listed apart.
 */
export async function resolveConnectors(userId: ObjectId | undefined): Promise<ResolvedConnectors> {
	// Unreadable policies fail closed: no deployment connector this turn, the person's own still.
	const policies = await loadPolicies().catch(() => null);
	const switches = await loadSwitches(userId);
	const connectors: TurnConnector[] = [];
	const blocked: BlockedConnector[] = [];

	// The `.env` servers: no row, no credential lookup, so no cost.
	for (const server of policies ? (getMcpServers() as McpServerConfig[]) : []) {
		const key = baseKey(server.name);
		const policy = policyIn(policies ?? new Map(), key);
		if (policy.mode === "off") continue;
		if (!isEnabled(key, policy, switches)) {
			blocked.push({ key, name: server.name, reason: "switched off" });
			continue;
		}
		const tools = knownTools(server.url) ?? [];
		connectors.push({
			key,
			name: server.name,
			kind: "base",
			alwaysLoaded: policy.alwaysLoaded,
			summary: summaryOf(server.description, tools),
			toolNames: tools.map((t) => t.name),
			open: async () => ({
				server: {
					name: server.name,
					url: server.url,
					...(server.headers ? { headers: server.headers } : {}),
				},
			}),
		});
	}

	if (!userId) return { connectors, blocked };

	// The administrator's and the person's own connectors.
	const rows = await collections.mcpConnectors
		.find({ $or: [{ userId }, { scope: "deployment" }] })
		.sort({ name: 1 })
		.limit(200)
		.toArray();
	const oauthIds = rows.filter((r) => r.auth === "oauth").map((r) => r._id);
	const signedIn = new Set(
		oauthIds.length === 0
			? []
			: (
					await collections.mcpTokens
						.find({ userId, connectorId: { $in: oauthIds } }, { projection: { connectorId: 1 } })
						.toArray()
				).map((t) => t.connectorId.toString())
	);
	const { credentialHeaders } = await import("./selection");
	for (const row of rows) {
		const key = connectorKey(row._id.toString());
		const deployment = (row.scope ?? "user") === "deployment";
		if (deployment && !policies) continue;
		const policy = deployment && policies ? policyIn(policies, key) : undefined;
		if (policy?.mode === "off") continue;
		if (!isEnabled(key, policy, switches)) {
			blocked.push({ key, name: row.name, reason: "switched off" });
			continue;
		}
		const usable =
			row.auth === "none" ||
			(row.auth === "token" && Boolean(row.tokenSealed)) ||
			(row.auth === "oauth" && signedIn.has(row._id.toString()));
		if (!usable) {
			blocked.push({ key, name: row.name, reason: "needs sign-in" });
			continue;
		}
		const tools = toolsOfRow(row);
		connectors.push({
			key,
			name: row.name,
			kind: "connector",
			alwaysLoaded: policy?.alwaysLoaded ?? false,
			summary: summaryOf(row.description, tools),
			toolNames: tools.map((t) => t.name),
			open: async () => {
				const headers = await credentialHeaders({ connector: row, userId });
				if (!headers) return { unavailable: "not signed in, or its token is missing" };
				return {
					server: {
						name: row.name,
						url: row.url,
						...(Object.keys(headers).length > 0 ? { headers } : {}),
					},
				};
			},
		});
	}

	// The servers on their own machines: off unless they switched one on.
	if (localConnectorsEnabled() && switches.on.size > 0) {
		const wanted = [...switches.on].filter(isLocalKey);
		if (wanted.length > 0) {
			const views = await localConnectorViews(userId).catch((err) => {
				logger.warn({ err: String(err) }, "mcp_local_listing_failed");
				return [];
			});
			for (const view of views) {
				if (!wanted.includes(view.id)) continue;
				const tools = (view.tools ?? []) as CatalogTool[];
				connectors.push({
					key: view.id,
					name: view.name,
					kind: "local",
					alwaysLoaded: false,
					summary: summaryOf(view.local?.description, tools),
					toolNames: tools.map((t) => t.name),
					open: async () => {
						const local = await resolveLocalSelection({ connectorIds: [view.id], userId });
						const server = local.servers[0];
						return server
							? { server: { name: server.name, url: server.url } }
							: { unavailable: local.unavailable[0]?.reason ?? "it is not available" };
					},
				});
			}
		}
	}
	return { connectors, blocked };
}
