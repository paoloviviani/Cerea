import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";

/**
 * How many versions of one artifact the deployment keeps (C122). 0 is unlimited.
 *
 * The environment (`ARTIFACT_MAX_VERSIONS`, empty or 0 = unlimited) is the default; the
 * administrator's value, once it has ever been set, overrides it in either direction
 * (the same pattern as the sharing toggle). It lives on the sharing settings' global row.
 */
export const MAX_ARTIFACT_VERSIONS_LIMIT = 1000;

/** `value` as a limit: a whole number from 1 to the ceiling, anything else (empty, 0, junk) is unlimited. */
export function parseMaxVersions(value: string | number | null | undefined): number {
	const parsed = typeof value === "number" ? value : parseInt(String(value ?? "").trim(), 10);
	if (!Number.isInteger(parsed) || parsed <= 0) return 0;
	return Math.min(parsed, MAX_ARTIFACT_VERSIONS_LIMIT);
}

export function maxVersionsEnvDefault(): number {
	return parseMaxVersions(config.ARTIFACT_MAX_VERSIONS);
}

const CACHE_MS = 3000;
let cached: { at: number; value: number | undefined } | undefined;

/** What the administrator chose, or undefined when it was never set. */
async function savedChoice(): Promise<number | undefined> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	try {
		const row = await collections.shareSettings.findOne({ _id: "global" });
		cached = { at: Date.now(), value: row?.maxArtifactVersions };
		return cached.value;
	} catch {
		return undefined;
	}
}

export async function maxArtifactVersions(): Promise<number> {
	return parseMaxVersions((await savedChoice()) ?? maxVersionsEnvDefault());
}

/** Whether the administrator's value is what applies (rather than the environment's). */
export async function maxVersionsOverridden(): Promise<boolean> {
	return (await savedChoice()) !== undefined;
}

/** Set the administrator's value (0 = unlimited), or `null` to go back to the environment's. */
export async function setMaxArtifactVersions(value: number | null): Promise<void> {
	await collections.shareSettings.updateOne(
		{ _id: "global" },
		value === null
			? { $unset: { maxArtifactVersions: "" }, $set: { updatedAt: new Date() } }
			: { $set: { maxArtifactVersions: value, updatedAt: new Date() } },
		{ upsert: true }
	);
	cached = undefined;
}

/** For tests: forget the cached value. */
export function forgetMaxVersionsCache(): void {
	cached = undefined;
}
