import type { ObjectId } from "mongodb";
import type { User } from "./User";

/**
 * One browser or installed app that a person turned notifications on for.
 *
 * Owner-keyed (`userId`, never a session: a push needs somebody to be
 * notified, and an anonymous cookie is not one), erased with the account and
 * moved on a merge (`identity/userKeyedCollections.ts`). The `endpoint` is the
 * push service's address for this browser and is unique across the whole
 * collection, so subscribing again from the same browser replaces its row
 * instead of piling up duplicates, and a browser that changes hands (a second
 * person signing in on it) is re-owned rather than notified twice.
 *
 * `p256dh` and `auth` are the browser's public key and shared secret for
 * encrypting payloads (RFC 8291). They are what makes the endpoint a
 * capability, so they never leave the server: the API sends the device list
 * with a label and dates only.
 */
export interface PushSubscriptionRow {
	_id: ObjectId;
	userId: User["_id"];
	endpoint: string;
	p256dh: string;
	auth: string;
	/** What the person sees in the device list ("Chrome on Android"). */
	label: string;
	createdAt: Date;
	/** The last time this browser told us it still holds the subscription. */
	lastSeenAt: Date;
	/** The last delivery the push service accepted, if any. */
	lastPushAt?: Date;
}
