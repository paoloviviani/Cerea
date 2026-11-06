import type { ObjectId } from "mongodb";
import type { User } from "./User";

/**
 * Which connectors a coding-agent session may use (ADR 0108, item 3: the MCP reverse path).
 * Default none: a session has a row only once its user switched something on. `keys` are
 * connector keys as the chat's resolver knows them (`base:<name>`, `connector:<id>`), plus
 * `local:<device>:<server>` for a server on the session's own machine. Cerea holds this, never
 * the machine: a machine can only name what a user opted in, and the resolver (ADR 0104)
 * re-applies the deployment's modes and the user's switches at every list and call.
 * Keyed by the session's ROOT id (subagents follow their root).
 */
export interface CodeSessionConnectorsRow {
	_id: ObjectId;
	userId: User["_id"];
	deviceId: string;
	sessionId: string;
	keys: string[];
	createdAt: Date;
	updatedAt: Date;
}
