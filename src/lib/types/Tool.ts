export enum ToolResultStatus {
	Success = "success",
	Error = "error",
}

export interface ToolCall {
	name: string;
	parameters: Record<string, string | number | boolean>;
	toolId?: string;
}

export interface ToolResultSuccess {
	status: ToolResultStatus.Success;
	call: ToolCall;
	outputs: Record<string, unknown>[];
	display?: boolean;
	/** The output is content from outside (a page, a document, a connector's data); set when the call ran. */
	external?: boolean;
}

export interface ToolResultError {
	status: ToolResultStatus.Error;
	call: ToolCall;
	message: string;
	display?: boolean;
}

export type ToolResult = ToolResultSuccess | ToolResultError;

export interface ToolFront {
	_id: string;
	name: string;
	displayName?: string;
	description?: string;
	color?: string;
	icon?: string;
	type?: "config" | "community";
	isOnByDefault?: boolean;
	isLocked?: boolean;
	mimeTypes?: string[];
	timeToUseMS?: number;
}

// MCP Server types
export interface KeyValuePair {
	key: string;
	value: string;
}

export type ServerStatus = "connected" | "connecting" | "disconnected" | "error";

export interface MCPTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface MCPServer {
	id: string;
	name: string;
	url: string;
	/** "base": deployment-configured (MCP_SERVERS). The user-added "custom"
	 * half is gone — connectors are how a person brings a server (ADR 0064). */
	type: "base";
	/** The key a switch is stored under (`base:<name>`). */
	key?: string;
	/** How the deployment offers it (ADR 0104): `locked` has no switch. `off` only for administrators. */
	mode?: "off" | "on" | "locked";
	/** Whether this person's turns use it: its mode and their own switch together. */
	enabled?: boolean;
	/** Administrators only: loaded from the start of every turn. */
	alwaysLoaded?: boolean;
	headers?: KeyValuePair[];
	env?: KeyValuePair[];
	status?: ServerStatus;
	isLocked?: boolean;
	tools?: MCPTool[];
	errorMessage?: string;
	// Indicates server reports or appears to require OAuth or other auth
	authRequired?: boolean;
}
