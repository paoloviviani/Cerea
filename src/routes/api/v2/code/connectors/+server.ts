/**
 * Which connectors a coding-agent session may use (ADR 0108, item 3).
 *
 * `GET ?device=&session=` answers `{ options, selected }`: the connectors the caller could switch
 * on for a session on that machine (Cerea's and the machine's own), and the session's current
 * opt-in (empty without `session`). `PUT { deviceId, sessionId, keys }` replaces the opt-in, and
 * an empty list clears it. Default is none. Owner only: the machine is the caller's own, and each
 * key must be one the resolver offers this caller now, so another user's connector cannot be named.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { z } from "zod";
import { getOwnedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import {
	connectorOptions,
	getSessionConnectorKeys,
	MAX_SESSION_CONNECTORS,
	SessionConnectorsError,
	setSessionConnectorKeys,
} from "$lib/server/code/sessionConnectors";

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireCodeAgents(locals);
	const device = await getOwnedDevice(locals, url.searchParams.get("device"));
	const userId = device.userId;
	const sessionId = url.searchParams.get("session");
	const deviceId = device._id.toString();
	const [options, selected] = await Promise.all([
		connectorOptions(userId, deviceId),
		sessionId ? getSessionConnectorKeys(userId, deviceId, sessionId) : Promise.resolve([]),
	]);
	return superjsonResponse({ options, selected });
};

const bodySchema = z.object({
	deviceId: z.string().min(1).max(64),
	sessionId: z.string().min(1).max(256),
	keys: z.array(z.string().min(1).max(300)).max(MAX_SESSION_CONNECTORS),
});

export const PUT: RequestHandler = async ({ locals, request }) => {
	await requireCodeAgents(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Expected { deviceId, sessionId, keys }.");
	const device = await getOwnedDevice(locals, parsed.data.deviceId);
	try {
		const selected = await setSessionConnectorKeys(
			device.userId,
			device._id.toString(),
			parsed.data.sessionId,
			parsed.data.keys
		);
		return superjsonResponse({ selected });
	} catch (err) {
		if (err instanceof SessionConnectorsError) error(400, err.message);
		throw err;
	}
};
