import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";

/**
 * Whether artifact share links are on (ADR 0120).
 *
 * The environment (`ARTIFACT_SHARING_ENABLED`, on unless exactly `false`) is the
 * default; the administrator's toggle, once it has ever been set, overrides it
 * in either direction. Off hides Share, refuses the API and makes every
 * existing link answer "not available", while the rows are kept: turning it back
 * on restores them.
 */
export function sharingEnvDefault(): boolean {
	return config.ARTIFACT_SHARING_ENABLED !== "false";
}

const CACHE_MS = 3000;
let cached: { at: number; value: boolean | undefined } | undefined;

/** What the administrator chose, or undefined when the toggle was never set. */
async function savedChoice(): Promise<boolean | undefined> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	// An unreadable row means "never set": the environment's default stands.
	try {
		const row = await collections.shareSettings.findOne({ _id: "global" });
		cached = { at: Date.now(), value: row?.enabled };
		return cached.value;
	} catch {
		return undefined;
	}
}

export async function sharingEnabled(): Promise<boolean> {
	return (await savedChoice()) ?? sharingEnvDefault();
}

export async function setSharingEnabled(enabled: boolean): Promise<void> {
	await collections.shareSettings.updateOne(
		{ _id: "global" },
		{ $set: { enabled, updatedAt: new Date() } },
		{ upsert: true }
	);
	cached = undefined;
}

/** For tests: forget the cached toggle. */
export function forgetSharingSettingsCache(): void {
	cached = undefined;
}
