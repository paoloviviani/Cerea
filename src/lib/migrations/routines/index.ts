import type { ObjectId } from "mongodb";

import type { Database } from "$lib/server/database";
import {
	MIGRATION_REENABLE_GRANT_EXPIRED,
	reenableGrantExpiredSchedules,
} from "./reenableGrantExpiredSchedules";

export interface Migration {
	_id: ObjectId;
	name: string;
	up: (client: Database) => Promise<boolean>;
	down?: (client: Database) => Promise<boolean>;
	runForFreshInstall?: "only" | "never"; // leave unspecified to run for both
	runEveryTime?: boolean;
}

export const migrations: Migration[] = [
	{
		_id: MIGRATION_REENABLE_GRANT_EXPIRED,
		name: "Re-enable chat schedules switched off for an expired background grant",
		up: async (client) => {
			await reenableGrantExpiredSchedules(client.getCollections());
			return true;
		},
		runForFreshInstall: "never",
	},
];
