import type { RequestHandler } from "@sveltejs/kit";
import type { MCPServer } from "$lib/types/Tool";
import { requireAdmin } from "$lib/server/admin";
import {
	baseKey,
	isEnabled,
	loadPolicies,
	loadSwitches,
	policyIn,
} from "$lib/server/mcp/deploymentModes";
import { getMcpServers } from "$lib/server/mcp/registry";

/**
 * The `.env` servers, as Workspace shows them (ADR 0104): each with how the
 * deployment offers it (`on` or `locked`) and whether this person has it on.
 * One the administrator switched off is not listed; `?admin=1` (administrators
 * only) lists those too, with `alwaysLoaded`, for the admin page.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const admin = url.searchParams.get("admin") === "1";
	if (admin) await requireAdmin(locals);
	const policies = await loadPolicies();
	const switches = await loadSwitches(locals.user?._id);

	const mcpServers: MCPServer[] = getMcpServers().flatMap((server): MCPServer[] => {
		const key = baseKey(server.name);
		const policy = policyIn(policies, key);
		if (policy.mode === "off" && !admin) return [];
		return [
			{
				id: `base-${server.name}`, // Stable ID based on name
				key,
				name: server.name,
				url: server.url,
				type: "base" as const,
				mode: policy.mode,
				enabled: isEnabled(key, policy, switches),
				...(admin ? { alwaysLoaded: policy.alwaysLoaded } : {}),
				// headers intentionally omitted
				isLocked: policy.mode === "locked",
				status: undefined, // Status determined client-side via health check
			},
		];
	});
	return Response.json(mcpServers);
};
