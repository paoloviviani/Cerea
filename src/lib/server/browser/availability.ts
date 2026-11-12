/**
 * Where a `browse` call can run: the user's own machines that are online and offer a browser
 * runtime (a `cerea-browser` server in `mcp.json`, state `ready`).
 *
 * Resolved by the caller before the tool list is built, like the other builtins' network reads:
 * it reads the device rows and each online machine's server list (`serversOf`, bounded and
 * cached), and never throws. Only the caller's own paired devices, ever.
 */

import type { ObjectId } from "mongodb";
import { isMachineOnline } from "$lib/server/code/machines";
import { localConnectorsAccessFor, localConnectorsEnabled } from "$lib/server/codeEnabled";
import { logger } from "$lib/server/logger";
import { localDevicesOf, serversOf } from "$lib/server/mcp/local";
import { BROWSER_RUNTIME_SERVER } from "./contract";
import { browserEnabled } from "./settings";

export interface BrowseMachine {
	id: string;
	name: string;
}

export async function browseMachinesFor(
	locals: Pick<App.Locals, "user" | "token" | "sessionId"> | undefined,
	options: { userId?: ObjectId } = {}
): Promise<BrowseMachine[]> {
	const userId = options.userId ?? locals?.user?._id;
	if (!userId || !browserEnabled() || !localConnectorsEnabled()) return [];
	try {
		if (locals && (await localConnectorsAccessFor(locals as App.Locals)) !== "ok") return [];
		const devices = (await localDevicesOf(userId)).filter((d) => isMachineOnline(d._id.toString()));
		const lists = await Promise.all(devices.map((device) => serversOf(device)));
		const machines: BrowseMachine[] = [];
		devices.forEach((device, i) => {
			const runtime = lists[i].servers.find((s) => s.name === BROWSER_RUNTIME_SERVER);
			if (runtime && runtime.state === "ready" && lists[i].live) {
				machines.push({ id: device._id.toString(), name: device.name });
			}
		});
		return machines;
	} catch (err) {
		logger.info({ err: String(err) }, "browse_machines_unavailable");
		return [];
	}
}
