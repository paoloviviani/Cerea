/**
 * Whether the apps (`ui://` pages, MCP Apps, #44) a connector offers may be shown.
 *
 * `connectorRef` is the connector's key as everywhere else (ADR 0104): `connector:<id>`,
 * `base:<server name>` or `local:<device>:<server>`.
 *
 * - A deployment connector (the administrator's, or a `.env` server): its policy row's
 *   `appsAllowed`, set on Admin, Connectors. Default allowed.
 * - A person's own connector: its `appsAllowed` field, set by that person. Default allowed.
 * - A connector on a person's own computer: allowed. Its server runs as that person.
 *
 * Fails closed: a policy or row that cannot be read means no apps this time, never a page
 * from a connector the administrator blocked. A connector that no longer exists has none.
 */
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { baseKey, connectorKey, isLocalKey, loadPolicies, policyIn } from "./deploymentModes";

export async function appsAllowedFor(connectorRef: string): Promise<boolean> {
	try {
		if (isLocalKey(connectorRef)) return true;
		if (connectorRef.startsWith("base:")) {
			const name = connectorRef.slice("base:".length);
			return policyIn(await loadPolicies(), baseKey(name)).appsAllowed;
		}
		if (!connectorRef.startsWith("connector:")) return false;
		const id = connectorRef.slice("connector:".length);
		if (!ObjectId.isValid(id)) return false;
		const row = await collections.mcpConnectors.findOne(
			{ _id: new ObjectId(id) },
			{ projection: { scope: 1, appsAllowed: 1 } }
		);
		if (!row) return false;
		if ((row.scope ?? "user") === "deployment") {
			return policyIn(await loadPolicies(), connectorKey(id)).appsAllowed;
		}
		return row.appsAllowed !== false;
	} catch (err) {
		logger.warn({ err: String(err), connectorRef }, "apps_policy_unreadable");
		return false;
	}
}
