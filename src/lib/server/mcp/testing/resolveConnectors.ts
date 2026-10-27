/**
 * Test stand-in for the old per-id resolution: what does this person get when
 * these connectors are loaded? Goes through the real resolver (`mcpLocalsFor`),
 * so a specification of "a stranger's id resolves to nothing" is a
 * specification of the code a turn actually runs.
 */
import type { ObjectId } from "mongodb";
import { mcpLocalsFor } from "../selection";
import { connectorKey } from "../deploymentModes";

export async function resolveConnectors(options: { connectorIds: string[]; userId: ObjectId }) {
	const locals = await mcpLocalsFor(
		{ loadedConnectors: options.connectorIds.map(connectorKey) },
		options.userId
	);
	const asked = new Set(options.connectorIds.map(connectorKey));
	return {
		servers: locals.servers,
		// Named, as the old resolution did: enabled and wanted, but needing a sign-in.
		needAuthorization: locals.blocked
			.filter((b) => asked.has(b.key) && b.reason === "needs sign-in")
			.map((b) => b.name),
	};
}
