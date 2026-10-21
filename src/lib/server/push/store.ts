import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { isValidUrl } from "$lib/server/urlSafety";
import type { PushSubscriptionRow } from "$lib/types/PushSubscription";
import { b64urlDecode } from "./webpush";

/** A person's browsers beyond this are the oldest dropped: a bound on what one
 * account can make this server send to. */
export const MAX_DEVICES_PER_USER = 10;
const MAX_ENDPOINT_LENGTH = 2048;

export class SubscriptionError extends Error {}

export interface SubscriptionInput {
	endpoint: string;
	p256dh: string;
	auth: string;
	userAgent?: string | null;
}

/** "Chrome on Android" from a user agent: enough to tell a person's devices apart. */
export function deviceLabel(userAgent: string | null | undefined): string {
	const ua = userAgent ?? "";
	const os = /iPhone|iPad|iPod/.test(ua)
		? "iOS"
		: /Android/.test(ua)
			? "Android"
			: /Windows/.test(ua)
				? "Windows"
				: /Mac OS X|Macintosh/.test(ua)
					? "macOS"
					: /CrOS/.test(ua)
						? "ChromeOS"
						: /Linux|X11/.test(ua)
							? "Linux"
							: "";
	const browser = /Edg\//.test(ua)
		? "Edge"
		: /OPR\/|Opera/.test(ua)
			? "Opera"
			: /Firefox\//.test(ua)
				? "Firefox"
				: /Chrome\/|CriOS\//.test(ua)
					? "Chrome"
					: /Safari\//.test(ua)
						? "Safari"
						: "";
	if (browser && os) return `${browser} on ${os}`;
	return browser || os || "Browser";
}

function validate(input: SubscriptionInput): void {
	if (typeof input.endpoint !== "string" || input.endpoint.length > MAX_ENDPOINT_LENGTH) {
		throw new SubscriptionError("The subscription's address is not valid.");
	}
	// https only, and nothing that points inside this deployment's network:
	// the endpoint is chosen by the browser, so by the person, and the server
	// will POST to it.
	if (!isValidUrl(input.endpoint)) {
		throw new SubscriptionError("The subscription's address is not valid.");
	}
	let p256dh: Buffer;
	let auth: Buffer;
	try {
		p256dh = b64urlDecode(input.p256dh);
		auth = b64urlDecode(input.auth);
	} catch {
		throw new SubscriptionError("The subscription's keys are not valid.");
	}
	if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) {
		throw new SubscriptionError("The subscription's keys are not valid.");
	}
}

/**
 * Remember a browser for a person. The endpoint is the key: the same browser
 * subscribing again updates its row, and a browser last used by somebody
 * else is moved to whoever subscribes now, so one device never notifies two
 * accounts.
 */
export async function saveSubscription(
	userId: ObjectId,
	input: SubscriptionInput
): Promise<PushSubscriptionRow> {
	validate(input);
	const now = new Date();
	const row = await collections.pushSubscriptions.findOneAndUpdate(
		{ endpoint: input.endpoint },
		{
			$set: {
				userId,
				p256dh: input.p256dh,
				auth: input.auth,
				label: deviceLabel(input.userAgent),
				lastSeenAt: now,
			},
			$setOnInsert: { _id: new ObjectId(), endpoint: input.endpoint, createdAt: now },
		},
		{ upsert: true, returnDocument: "after", includeResultMetadata: false }
	);
	if (!row) throw new SubscriptionError("The subscription could not be saved.");

	const mine = await collections.pushSubscriptions
		.find({ userId })
		.sort({ createdAt: 1 })
		.project<{ _id: ObjectId }>({ _id: 1 })
		.toArray();
	const excess = mine.slice(0, Math.max(0, mine.length - MAX_DEVICES_PER_USER));
	if (excess.length > 0) {
		await collections.pushSubscriptions.deleteMany({
			_id: { $in: excess.map((r) => r._id) },
			// Never the one just saved, even if its clock is oldest.
			endpoint: { $ne: input.endpoint },
		});
	}
	return row;
}

export function listSubscriptions(userId: ObjectId): Promise<PushSubscriptionRow[]> {
	return collections.pushSubscriptions.find({ userId }).sort({ createdAt: 1 }).toArray();
}

/** Owner-scoped: another person's id removes nothing and says so. */
export async function removeSubscription(userId: ObjectId, id: string): Promise<boolean> {
	if (!ObjectId.isValid(id)) return false;
	const { deletedCount } = await collections.pushSubscriptions.deleteOne({
		_id: new ObjectId(id),
		userId,
	});
	return deletedCount === 1;
}

/** A browser the push service says is gone, whoever owned it. */
export async function removeByEndpoint(endpoint: string): Promise<void> {
	await collections.pushSubscriptions.deleteOne({ endpoint });
}

export function endpointFingerprint(endpoint: string): string {
	return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

/** What the browser is told about a device: never the endpoint or keys. */
export interface DeviceView {
	id: string;
	label: string;
	/** A short hash of the endpoint, so a browser can recognise its own row
	 * (it knows its endpoint) without the list ever carrying it. */
	fingerprint: string;
	createdAt: string;
	lastPushAt: string | null;
}

export function deviceView(row: PushSubscriptionRow): DeviceView {
	return {
		id: row._id.toString(),
		label: row.label,
		fingerprint: endpointFingerprint(row.endpoint),
		createdAt: row.createdAt.toISOString(),
		lastPushAt: row.lastPushAt?.toISOString() ?? null,
	};
}
