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
import {
	baseKey,
	connectorKey,
	loadPolicies,
	policyIn,
	type ConnectorPolicy,
} from "./deploymentModes";

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern that matches every spelling `connectorNameKey` treats as `name` (any case, any
 * whitespace between words, any around). The matches are checked again with the key itself.
 */
function spellingsOf(name: string): RegExp {
	const words = connectorNameKey(name).split(" ").map(escapeRegex);
	return new RegExp(`^\\s*${words.join("\\s+")}\\s*$`, "i");
}

/**
 * The name of the connector `name` clashes with, or undefined. `excludeId` is the row being renamed.
 * For a user, a deployment connector the administrator switched off is not visible and does not
 * count; unreadable policies fail closed the same way (as in `resolveConnectors`).
 */
export async function findNameClash(options: {
	name: string;
	scope: "user" | "deployment";
	userId: ObjectId;
	excludeId?: ObjectId;
}): Promise<string | undefined> {
	const { name, scope, userId, excludeId } = options;
	const wanted = connectorNameKey(name);
	const pattern = spellingsOf(name);
	const filter =
		scope === "deployment"
			? { scope: "deployment" as const, name: pattern }
			: {
					$or: [
						{ userId, scope: { $ne: "deployment" as const }, name: pattern },
						{ scope: "deployment" as const, name: pattern },
					],
				};
	const rows = await collections.mcpConnectors
		.find(filter, { projection: { name: 1, scope: 1 } })
		.toArray();
	const policies =
		scope === "user" ? await loadPolicies().catch(() => null) : new Map<string, ConnectorPolicy>();
	const visible = (key: string) =>
		scope === "deployment" || (policies !== null && policyIn(policies, key).mode !== "off");
	for (const row of rows) {
		if (excludeId && row._id.equals(excludeId)) continue;
		if (connectorNameKey(row.name) !== wanted) continue;
		if ((row.scope ?? "user") === "deployment" && !visible(connectorKey(row._id.toString()))) {
			continue;
		}
		return row.name;
	}
	for (const server of getMcpServers()) {
		if (connectorNameKey(server.name) === wanted && visible(baseKey(server.name))) {
			return server.name;
		}
	}
	return undefined;
}
