import type { MCPServer } from "$lib/types/Tool";
import { config } from "$lib/server/config";
import { baseKey, loadModes, modeIn } from "$lib/server/mcp/deploymentModes";

export async function GET() {
	// Parse MCP_SERVERS environment variable
	const mcpServersEnv = config.MCP_SERVERS || "[]";

	let servers: Array<{ name: string; url: string; headers?: Record<string, string> }> = [];

	try {
		servers = JSON.parse(mcpServersEnv);
		if (!Array.isArray(servers)) {
			servers = [];
		}
	} catch (error) {
		console.error("Failed to parse MCP_SERVERS env variable:", error);
		servers = [];
	}

	// What the deployment offers: an `off` server is not listed to anyone (the admin page reads
	// its own list, with every mode), and `mode` tells the client whether a switch is shown.
	const modes = await loadModes();
	const mcpServers: MCPServer[] = servers.flatMap((server): MCPServer[] => {
		const mode = modeIn(modes, baseKey(server.name));
		if (mode === "off") return [];
		return [
			{
				id: `base-${server.name}`, // Stable ID based on name
				name: server.name,
				url: server.url,
				type: "base" as const,
				mode,
				// headers intentionally omitted
				isLocked: false, // Base servers can be toggled by users
				status: undefined, // Status determined client-side via health check
			},
		];
	});

	return Response.json(mcpServers);
}
