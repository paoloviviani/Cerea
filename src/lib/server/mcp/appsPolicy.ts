/**
 * Whether the apps (`ui://` pages, MCP Apps, #44) a connector offers may be shown to a user.
 *
 * `connectorRef` is the connector's key as everywhere else (ADR 0104): `connector:<id>`,
 * `base:<server name>` or `local:<device>:<server>`. **Callers pass the ref from the server-side
 * record of this turn's tool call, never one the browser or an app's iframe sent**: the check
 * below proves the user may use that connector, not that the ref is the one that was called.
 *
 * In order, all must hold:
 * 1. the deployment-wide setting (`MCP_APPS`, `appsMode.ts`): `off` allows nothing,
 *    `deployment` only the deployment's connectors;
 * 2. the connector is this user's to use (`usableBy`: their own, or the deployment's; a `local:`
 *    device that is theirs; a `base:` server still in `MCP_SERVERS`);
 * 3. its own switch: a deployment connector's or `.env` server's `appsAllowed` on its policy row
 *    (a row whose other fields are malformed still counts), a user's own connector's `appsAllowed`.
 *    Local connectors have no switch: their server runs as the user.
 *
 * Fails closed: anything unreadable, unknown or not theirs is false.
 */
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { appsMode } from "./appsMode";
import { baseKey, connectorKey } from "./deploymentModes";
import { usableBy } from "./connectors";
import { parseLocalConnectorId } from "./localUrl";
import { getMcpServers } from "./registry";

/** The administrator's switch for one policy key: anything but a stored `false` is on. */
async function switchedOn(key: string): Promise<boolean> {
	const row = await collections.connectorModes.findOne({ key }, { projection: { appsAllowed: 1 } });
	return row?.appsAllowed !== false;
}

export async function appsAllowedFor(connectorRef: string, userId: ObjectId): Promise<boolean> {
	try {
		const mode = appsMode();
		if (mode === "off") return false;

		if (connectorRef.startsWith("local:")) {
			if (mode !== "all") return false;
			const ref = parseLocalConnectorId(connectorRef);
			if (!ref || !ObjectId.isValid(ref.deviceId)) return false;
			const device = await collections.codeDevices.findOne(
				{ _id: new ObjectId(ref.deviceId), userId },
				{ projection: { _id: 1 } }
			);
			return device !== null;
		}

		if (connectorRef.startsWith("base:")) {
			const name = connectorRef.slice("base:".length);
			if (!getMcpServers().some((s) => s.name === name)) return false;
			return await switchedOn(baseKey(name));
		}

		if (!connectorRef.startsWith("connector:")) return false;
		const id = connectorRef.slice("connector:".length);
		const row = await usableBy(id, userId);
		if (!row) return false;
		if ((row.scope ?? "user") === "deployment") return await switchedOn(connectorKey(id));
		return mode === "all" && row.appsAllowed !== false;
	} catch (err) {
		logger.warn({ err: String(err), connectorRef }, "apps_policy_unreadable");
		return false;
	}
}
