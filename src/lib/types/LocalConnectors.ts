import type { McpLocalView } from "./McpConnector";

/** One server of a machine, as the Local connectors tab shows it. */
export interface LocalServerView {
	/** `local:<deviceId>:<server>`: what the chat's selection and the MCP panel call it. */
	id: string;
	name: string;
	transport: McpLocalView["transport"];
	description?: string;
	/** `offline` whatever the server's last known state, while its machine is not connected. */
	state: McpLocalView["state"];
	detail?: string;
	allowedTools?: string[];
}

/** One of the person's machines that serves local connectors (ADR 0102). */
export interface LocalMachineView {
	id: string;
	name: string;
	/** `pending` waits for the person's approval; nothing is offered to the chat before it. */
	status: "pending" | "paired";
	/** `agent` is a coding-agent machine that also has an `mcp.json`: paired and managed in the
	 * Agents panel, listed here only for its servers. */
	mode: "connectors" | "agent";
	online: boolean;
	createdAt: string;
	lastSeenAt?: string;
	pairedAt?: string;
	/** When the servers below were last read from the machine. */
	serversAt?: string;
	servers: LocalServerView[];
}
