import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";

export interface User extends Timestamps {
	_id: ObjectId;

	username?: string;
	name: string;
	email?: string;
	avatarUrl: string | undefined;
	hfUserId: string;
	/** The OIDC issuer that minted `hfUserId` (absent on accounts from before it was recorded). */
	issuer?: string;
	/** The previous `sub`, when a login moved this account to a new issuer. */
	migratedFromSub?: string;
	isAdmin?: boolean;
	isEarlyAccess?: boolean;
}
