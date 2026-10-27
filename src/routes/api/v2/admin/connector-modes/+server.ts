/**
 * How the deployment offers its own connectors: on for everyone, optional, or
 * off. Administrator only (`requireAdmin`, the gateway's answer).
 *
 * GET lists the `.env` servers with their mode (the administrator's own
 * connectors carry theirs in `GET /api/v2/mcp/connectors?admin=1`). PUT sets
 * one. A change applies from the next turn: modes are read on every turn.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { requireAdmin } from "$lib/server/admin";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { baseKey, connectorKey, loadModes, modeIn, setMode } from "$lib/server/mcp/deploymentModes";
import { getMcpServers } from "$lib/server/mcp/registry";

const mode = z.enum(["always", "optional", "off"]);
const body = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("base"), name: z.string().min(1).max(256), mode }),
	z.object({ kind: z.literal("connector"), id: z.string().min(1).max(64), mode }),
]);

export const GET: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	const modes = await loadModes();
	return json({
		data: getMcpServers().map((server) => ({
			kind: "base" as const,
			id: `base-${server.name}`,
			name: server.name,
			url: server.url,
			mode: modeIn(modes, baseKey(server.name)),
		})),
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = await requireAdmin(locals);
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Choose a connector and a mode: always, optional or off.");

	if (parsed.data.kind === "base") {
		const { name } = parsed.data;
		if (!getMcpServers().some((server) => server.name === name)) {
			error(404, "No such built-in connector.");
		}
		await setMode(baseKey(name), parsed.data.mode);
		logger.info(
			{ kind: "base", name, mode: parsed.data.mode, admin: admin.email },
			"connector_mode_changed"
		);
	} else {
		const { id } = parsed.data;
		const found = ObjectId.isValid(id)
			? await collections.mcpConnectors.findOne(
					{ _id: new ObjectId(id), scope: "deployment" },
					{ projection: { _id: 1 } }
				)
			: null;
		if (!found) error(404, "No such connector.");
		await setMode(connectorKey(id), parsed.data.mode);
		logger.info(
			{ kind: "connector", id, mode: parsed.data.mode, admin: admin.email },
			"connector_mode_changed"
		);
	}
	return json({ ok: true, mode: parsed.data.mode });
};
