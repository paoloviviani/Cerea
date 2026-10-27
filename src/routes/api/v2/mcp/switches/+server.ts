/**
 * One person's switch for one connector (ADR 0104): the Workspace toggle.
 *
 * `key` is `base:<name>` for a `.env` server, `connector:<id>` for an
 * administrator's or the person's own connector, or the `local:` id of a
 * server on one of their machines. A connector the deployment locked cannot be
 * switched off, and one it switched off is not theirs to switch on.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import {
	baseKey,
	connectorKey,
	isLocalKey,
	loadPolicies,
	MAX_SWITCHES,
	policyIn,
	setSwitch,
} from "$lib/server/mcp/deploymentModes";
import { getMcpServers } from "$lib/server/mcp/registry";

const body = z.object({ key: z.string().min(1).max(512), enabled: z.boolean() });

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) error(401, "Login required");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Give the connector's key and whether it is on.");
	const { key, enabled } = parsed.data;

	if (key.startsWith("base:")) {
		if (!getMcpServers().some((s) => baseKey(s.name) === key)) error(404, "No such connector.");
	} else if (key.startsWith("connector:")) {
		const id = key.slice("connector:".length);
		const row = ObjectId.isValid(id)
			? await collections.mcpConnectors.findOne(
					{ _id: new ObjectId(id), $or: [{ userId: user._id }, { scope: "deployment" }] },
					{ projection: { scope: 1 } }
				)
			: null;
		if (!row) error(404, "No such connector.");
		if (key !== connectorKey(id)) error(404, "No such connector.");
	} else if (isLocalKey(key)) {
		// Only a server on one of this person's own machines.
		const { localConnectorViews } = await import("$lib/server/mcp/local");
		if (!(await localConnectorViews(user._id)).some((view) => view.key === key)) {
			error(404, "No such connector.");
		}
	} else {
		error(404, "No such connector.");
	}

	const row = await collections.connectorSwitches.findOne(
		{ userId: user._id },
		{ projection: { off: 1, on: 1 } }
	);
	const kept = [...(row?.off ?? []), ...(row?.on ?? [])];
	if (!kept.includes(key) && kept.length >= MAX_SWITCHES) {
		error(400, "Too many connectors switched; switch some back first.");
	}

	const policy = policyIn(await loadPolicies(), key);
	if (policy.mode === "off") error(404, "No such connector.");
	if (policy.mode === "locked" && !enabled) {
		error(409, "Your administrator keeps this connector on, so it cannot be turned off.");
	}
	await setSwitch(user._id, key, enabled);
	return json({ key, enabled: policy.mode === "locked" ? true : enabled });
};
