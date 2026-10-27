/**
 * How the deployment offers its own connectors (ADR 0104): off, on or on and
 * locked, and whether the assistant has them loaded from the start of every
 * turn. Administrator only (`requireAdmin`, the gateway's answer).
 *
 * The `.env` servers are listed by `GET /api/mcp/servers?admin=1` and the
 * administrator's own connectors by `GET /api/v2/mcp/connectors?admin=1`, each
 * with its policy. PUT changes one. A change applies from the next turn: policies
 * are read on every turn.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { baseKey, connectorKey, setPolicy } from "$lib/server/mcp/deploymentModes";
import { getMcpServers } from "$lib/server/mcp/registry";

const change = {
	mode: z.enum(["off", "on", "locked"]).optional(),
	alwaysLoaded: z.boolean().optional(),
};
const body = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("base"), name: z.string().min(1).max(256), ...change }),
	z.object({ kind: z.literal("connector"), id: z.string().min(1).max(64), ...change }),
]);

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (
		!parsed.success ||
		(parsed.data.mode === undefined && parsed.data.alwaysLoaded === undefined)
	) {
		error(
			400,
			"Choose a connector, and a mode (off, on or locked) or whether it is always loaded."
		);
	}
	const { mode, alwaysLoaded } = parsed.data;

	let key: string;
	if (parsed.data.kind === "base") {
		const { name } = parsed.data;
		if (!getMcpServers().some((server) => server.name === name)) {
			error(404, "No such built-in connector.");
		}
		key = baseKey(name);
	} else {
		const { id } = parsed.data;
		const found = ObjectId.isValid(id)
			? await collections.mcpConnectors.findOne(
					{ _id: new ObjectId(id), scope: "deployment" },
					{ projection: { _id: 1 } }
				)
			: null;
		if (!found) error(404, "No such connector.");
		key = connectorKey(id);
	}
	const policy = await setPolicy(key, {
		...(mode !== undefined ? { mode } : {}),
		...(alwaysLoaded !== undefined ? { alwaysLoaded } : {}),
	});
	logger.info({ key, ...policy, admin: admin.email }, "connector_policy_changed");
	return json(policy);
};
