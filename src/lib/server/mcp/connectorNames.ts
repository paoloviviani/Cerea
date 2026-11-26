/**
 * Refusing a connector name that is already taken (C169).
 *
 * A user's own connector may not share a name with another of theirs or with a deployment
 * connector (a row or an `MCP_SERVERS` entry); a deployment connector may not share one
 * with another deployment connector. Clashes that already exist, or that an administrator
 * creates later, are settled when a turn is built (`resolveConnectors`).
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { connectorNameKey } from "$lib/utils/connectorName";
import { getMcpServers } from "./registry";

/** The name of the connector `name` clashes with, or undefined. `excludeId` is the row being renamed. */
export async function findNameClash(options: {
	name: string;
	scope: "user" | "deployment";
	userId: ObjectId;
	excludeId?: ObjectId;
}): Promise<string | undefined> {
	const { name, scope, userId, excludeId } = options;
	const wanted = connectorNameKey(name);
	const filter =
		scope === "deployment"
			? { scope: "deployment" as const }
			: {
					$or: [
						{ userId, scope: { $ne: "deployment" as const } },
						{ scope: "deployment" as const },
					],
				};
	const rows = await collections.mcpConnectors
		.find(filter, { projection: { name: 1 } })
		.limit(5000)
		.toArray();
	for (const row of rows) {
		if (excludeId && row._id.equals(excludeId)) continue;
		if (connectorNameKey(row.name) === wanted) return row.name;
	}
	for (const server of getMcpServers()) {
		if (connectorNameKey(server.name) === wanted) return server.name;
	}
	return undefined;
}
