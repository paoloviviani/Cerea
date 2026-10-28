/**
 * The tools one of the caller's own local servers offers, for the connector detail sheet.
 *
 * `GET ?id=local:<deviceId>:<server>`. The listing is the one a turn uses: the same
 * `resolveLocalSelection` ownership check (only a paired device of the caller resolves) and the
 * same per-server cache behind `getOpenAiToolsForMcp`, so opening the sheet does not cost a fresh
 * round trip to the machine when a chat just listed it. An id naming somebody else's machine, a
 * machine that is not paired any more or garbage is a 404, like every other local-connectors
 * route: telling those apart would confirm another person's machine exists.
 *
 * A server that cannot be listed right now (machine offline, server disabled, listing failed) is
 * a 200 with `error` set to the reason: the sheet shows it, and the caller did nothing wrong.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { requireLocalConnectors } from "$lib/server/localConnectors";
import { resolveLocalSelection } from "$lib/server/mcp/local";
import { parseLocalConnectorId } from "$lib/server/mcp/localUrl";
import { getOpenAiToolsForMcp } from "$lib/server/mcp/tools";
import type { LocalToolsAnswer } from "$lib/types/LocalConnectors";

export const GET: RequestHandler = async ({ locals, url }) => {
	const { userId } = requireLocalConnectors(locals);
	const id = url.searchParams.get("id") ?? "";
	const ref = parseLocalConnectorId(id);
	if (!ref) error(404, "No such local connector.");

	const { servers, unavailable } = await resolveLocalSelection({ connectorIds: [id], userId });
	if (servers.length === 0 && unavailable.length === 0) error(404, "No such local connector.");
	if (servers.length === 0) {
		return json({ error: unavailable[0].reason } satisfies LocalToolsAnswer);
	}

	const listing = await getOpenAiToolsForMcp(servers, { markUntrusted: false });
	if (listing.unavailable.length > 0) {
		return json({ error: listing.unavailable[0].reason } satisfies LocalToolsAnswer);
	}
	const descriptions = new Map(
		listing.tools.map((tool) => [tool.function.name, tool.function.description])
	);
	return json({
		tools: Object.values(listing.mapping).map((mapped) => ({
			name: mapped.tool,
			...(descriptions.get(mapped.fnName) ? { description: descriptions.get(mapped.fnName) } : {}),
		})),
	} satisfies LocalToolsAnswer);
};
