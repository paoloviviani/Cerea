/**
 * One browser task at a time on a machine, as a lease on the device row (ADR 0116).
 *
 * In memory it would only hold within one server process; a second pod, or a restart that lost
 * the set, would run two tasks in one browser. The lease is a field on the device document taken
 * with one atomic update: it is free when absent or past its `until`, and the holder renews it
 * while the task runs, so a crashed holder frees the machine within a minute on its own.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";

export const LEASE_TTL_MS = 60_000;
const RENEW_EVERY_MS = 20_000;

export interface Lease {
	release(): Promise<void>;
}

export interface LeaseStore {
	acquire(deviceId: string, userId: ObjectId, holder: string): Promise<Lease | null>;
}

export const mongoLeaseStore: LeaseStore = {
	async acquire(deviceId, userId, holder) {
		const _id = new ObjectId(deviceId);
		const now = Date.now();
		const taken = await collections.codeDevices.updateOne(
			{
				_id,
				userId,
				$or: [
					{ browserLease: { $exists: false } },
					{ "browserLease.until": { $lt: new Date(now) } },
				],
			},
			{ $set: { browserLease: { holder, until: new Date(now + LEASE_TTL_MS) } } }
		);
		if (taken.modifiedCount !== 1) return null;
		const timer = setInterval(() => {
			void collections.codeDevices
				.updateOne(
					{ _id, userId, "browserLease.holder": holder },
					{ $set: { "browserLease.until": new Date(Date.now() + LEASE_TTL_MS) } }
				)
				.catch(() => undefined);
		}, RENEW_EVERY_MS);
		timer.unref?.();
		return {
			async release() {
				clearInterval(timer);
				await collections.codeDevices
					.updateOne(
						{ _id, userId, "browserLease.holder": holder },
						{ $unset: { browserLease: "" } }
					)
					.catch(() => undefined);
			},
		};
	},
};

/** An in-process store for tests of callers that need no database. */
export function memoryLeaseStore(): LeaseStore {
	const held = new Set<string>();
	return {
		async acquire(deviceId) {
			if (held.has(deviceId)) return null;
			held.add(deviceId);
			return { release: async () => void held.delete(deviceId) };
		},
	};
}
