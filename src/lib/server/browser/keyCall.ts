/**
 * The machine call `browser.key` (PROTOCOL.md section 10.7): the runtime on a machine fetches the
 * key that signs this device's approval grants, over the authenticated link, when
 * `galopin browser enable` registers the runtime (and again on a restart). Cerea acts as the
 * device's owner, for this device only, and only for a paired device.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { sealingAvailable } from "$lib/server/mcp/secretBox";
import type { CallFrame, CallResFrame } from "$lib/types/machineProtocol";
import { deviceBrowserKey } from "./grants";
import { browserEnabled } from "./settings";

export const BROWSER_CALL_OPS: string[] = ["browser.key"];

export async function handleBrowserCall(deviceId: string, frame: CallFrame): Promise<CallResFrame> {
	const fail = (
		code: "forbidden" | "unavailable" | "unsupported",
		message: string
	): CallResFrame => ({
		type: "callres",
		id: frame.id,
		ok: false,
		error: { code, message },
	});
	if (frame.op !== "browser.key") return fail("unsupported", `Unknown call "${frame.op}".`);
	if (!browserEnabled()) return fail("unavailable", "Browser use is switched off on this Cerea.");
	if (!sealingAvailable()) {
		return fail(
			"unavailable",
			"This Cerea has no CHAT_SECRET_KEY, so it cannot keep the browser key."
		);
	}
	try {
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		if (!device) return fail("forbidden", "This machine is not known to Cerea.");
		if (device.status !== "paired") {
			return fail("forbidden", "This machine is not paired yet; its owner must confirm it.");
		}
		const key = await deviceBrowserKey(deviceId, device.userId);
		return {
			type: "callres",
			id: frame.id,
			ok: true,
			result: { key: key.toString("base64url"), alg: "HMAC-SHA256" },
		};
	} catch (err) {
		logger.warn({ err: String(err), deviceId }, "browser.key failed");
		return fail("unavailable", "Cerea could not provide the key just now; try again.");
	}
}
