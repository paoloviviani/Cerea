import type { ObjectId } from "mongodb";
import type { User } from "./User";

/**
 * Connector lists (see `server/code/sessionConnectors.ts`). Two kinds of row:
 *  - the user's one list: `deviceId "*"`, `sessionId "local-agents"`, with `keys` (connector keys
 *    as the chat's resolver knows them, `base:<name>`, `connector:<id>`, plus
 *    `local:<device>:<server>` for a computer's own server), `appsToo` (apps on the user's
 *    computers may use the list's Cerea connectors; absent means on) and `savedAt` (not
 *    `updatedAt`: the 365-day TTL is on `updatedAt` and a list must not expire);
 *  - a session's narrowing: `off`, the inherited connectors this session turned off. It keyed by
 *    the session's ROOT id (subagents follow their root). `keys` on a non-user row is the retired
 *    per-session opt-in, merged into the user's list at start and then removed.
 * Cerea holds this, never the machine; the resolver (ADR 0104) re-applies the deployment's modes
 * and the user's switches at every list and call.
 */
export interface CodeSessionConnectorsRow {
	_id: ObjectId;
	userId: User["_id"];
	deviceId: string;
	sessionId: string;
	keys?: string[];
	appsToo?: boolean;
	off?: string[];
	createdAt: Date;
	updatedAt?: Date;
	savedAt?: Date;
}
