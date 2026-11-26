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
import { connectorBlurb } from "./connectorBlurb";
import { resolveLocalSelection, localConnectorViews } from "./local";
import { nameClashLosers, type NameCandidate } from "./nameClashes";
import { connectorNameKey } from "$lib/utils/connectorName";

import type { ResolvedServer } from "./selection";

export interface TurnConnector {
	key: string;
	name: string;
	kind: "base" | "connector" | "local";
	/** Loaded from the start of every turn (a deployment policy). */
	alwaysLoaded: boolean;
	/** One sentence for the assistant: its description, else made from its tool names. */
	summary: string;
	/** What the connector says about itself, plain and short, for the connector lists; "" when nothing. */
	blurb: string;
	/** Tool names as last seen; empty when it has never been listed. */
	toolNames: string[];
	/**
	 * The host of its address (`api.example.com`), which tells the assistant what a connector
	 * with no tool names is. Absent for a server on a person's machine. Derived from the row's
	 * address only, so the line it lands in stays the same from turn to turn.
	 */
	host?: string;
	/** The server to call, with this person's credential, or why it cannot be used now. */
	open(): Promise<{ server: ResolvedServer } | { unavailable: string }>;
}

/** Connectors left out of the list, for `load_tools` to explain: switched off by the person, or needing a sign-in. */
export interface BlockedConnector {
	key: string;
	name: string;
	reason: "switched off" | "needs sign-in" | "same name";
}

export interface ResolvedConnectors {
	connectors: TurnConnector[];
	blocked: BlockedConnector[];
}

export function summaryOf(description: string | undefined, tools: CatalogTool[]): string {
	// One line: the catalogue is a list of lines, and a description is the administrator's text.
	const oneLine = description?.replace(/\s+/g, " ").trim();
	if (oneLine) return oneLine;
	const first = tools.find((t) => t.description?.trim())?.description?.trim();
	if (first) {
		const sentence = first.split(/(?<=[.!?])\s/)[0].replace(/\s+/g, " ");
		return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
	}
	return tools.length > 0
		? "Tools it offers are listed below."
		: "its tools haven't been checked; load it to see them.";
}

/** The host of an address, or undefined for one that does not parse. */
export function hostOf(address: string | undefined): string | undefined {
	if (!address) return undefined;
	try {
		return new URL(address).hostname || undefined;
	} catch {
		return undefined;
	}
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

	// One name, one connector (C169): which of the connectors on for this user keep their name
	// is decided from everything that is on, usable or not, so signing in never changes the winner.
	const candidates: NameCandidate[] = [];
	const envServers = policies ? (getMcpServers() as McpServerConfig[]) : [];
	for (const server of envServers) {
		const key = baseKey(server.name);
		const policy = policyIn(policies ?? new Map(), key);
		if (policy.mode !== "off" && isEnabled(key, policy, switches)) {
			candidates.push({ key, name: server.name, deployment: true });
		}
	}
	const rows = userId
		? await collections.mcpConnectors
				.find({ $or: [{ userId }, { scope: "deployment" }] })
				.sort({ name: 1 })
				.limit(200)
				.toArray()
		: [];
	for (const row of rows) {
		const key = connectorKey(row._id.toString());
		const deployment = (row.scope ?? "user") === "deployment";
		if (deployment && !policies) continue;
		const policy = deployment && policies ? policyIn(policies, key) : undefined;
		if (policy?.mode === "off" || !isEnabled(key, policy, switches)) continue;
		candidates.push({
			key,
			name: row.name,
			deployment,
			...(row.createdAt ? { createdAt: new Date(row.createdAt).getTime() } : {}),
		});
	}
	const losers = nameClashLosers(candidates);
	const leftOut = (key: string, name: string): boolean => {
		if (!losers.has(key)) return false;
		blocked.push({ key, name, reason: "same name" });
		logger.warn({ key, name, keptName: losers.get(key) }, "mcp_connector_same_name_left_out");
		return true;
	};

	// The `.env` servers: no row, no credential lookup, so no cost.
	for (const server of envServers) {
		const key = baseKey(server.name);
		const policy = policyIn(policies ?? new Map(), key);
		if (policy.mode === "off") continue;
		if (!isEnabled(key, policy, switches)) {
			blocked.push({ key, name: server.name, reason: "switched off" });
			continue;
		}
		if (leftOut(key, server.name)) continue;
		const tools = knownTools(server.url) ?? [];
		connectors.push({
			key,
			name: server.name,
			kind: "base",
			alwaysLoaded: policy.alwaysLoaded,
			summary: summaryOf(server.description, tools),
			blurb: connectorBlurb(server.description),
			toolNames: tools.map((t) => t.name),
			host: hostOf(server.url),
			open: async () => ({
				server: {
					key,
					name: server.name,
					url: server.url,
					...(server.headers ? { headers: server.headers } : {}),
				},
			}),
		});
	}

	if (!userId) return { connectors, blocked };

	// The administrator's and the person's own connectors.
	const oauthIds = rows
		.filter((r) => r.auth === "oauth" || r.auth === "user-key")
		.map((r) => r._id);
	const signedIn = new Set(
		oauthIds.length === 0
			? []
			: (
					await collections.mcpTokens
						.find(
							{ userId, connectorId: { $in: oauthIds }, refusedAt: { $exists: false } },
							{ projection: { connectorId: 1 } }
						)
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
		if (leftOut(key, row.name)) continue;
		const usable =
			row.auth === "none" ||
			(row.auth === "token" && Boolean(row.tokenSealed)) ||
			((row.auth === "oauth" || row.auth === "user-key") && signedIn.has(row._id.toString()));
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
			blurb: connectorBlurb(row.description, row.about),
			toolNames: tools.map((t) => t.name),
			host: hostOf(row.url),
			open: async () => {
				const headers = await credentialHeaders({ connector: row, userId });
				if (!headers) return { unavailable: "not signed in, or its token is missing" };
				return {
					server: {
						key,
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
			// A computer's server named like another connector, or like another computer's, loses.
			const taken = new Set(connectors.map((c) => connectorNameKey(c.name)));
			for (const view of [...views].sort((a, b) => (a.id < b.id ? -1 : 1))) {
				if (!wanted.includes(view.id)) continue;
				const nameKey = connectorNameKey(view.name);
				if (taken.has(nameKey)) {
					blocked.push({ key: view.id, name: view.name, reason: "same name" });
					logger.warn({ key: view.id, name: view.name }, "mcp_connector_same_name_left_out");
					continue;
				}
				taken.add(nameKey);
				const tools = (view.tools ?? []) as CatalogTool[];
				connectors.push({
					key: view.id,
					name: view.name,
					kind: "local",
					alwaysLoaded: false,
					summary: summaryOf(view.local?.description, tools),
					blurb: connectorBlurb(view.local?.description),
					toolNames: tools.map((t) => t.name),
					open: async () => {
						const local = await resolveLocalSelection({ connectorIds: [view.id], userId });
						const server = local.servers[0];
						return server
							? { server: { key: view.id, name: server.name, url: server.url } }
							: { unavailable: local.unavailable[0]?.reason ?? "it is not available" };
					},
				});
			}
		}
	}
	return { connectors, blocked };
}
