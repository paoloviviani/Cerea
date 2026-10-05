/**
 * The deployment's web-search backend choice, set on the admin Web search
 * screen and kept in the chat's own Mongo (the `knowledgeConfig` document, as
 * `extractorModel` is). Written with a targeted `$set` rather than the
 * knowledge service's whole-document replace: web search must stay
 * configurable with the knowledge pipeline switched off.
 */
import { createHash } from "node:crypto";

import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { findSearchModelIds } from "$lib/server/textGeneration/builtinTools/gatewaySearchTool";
import { resolveWebSearch, type WebSearchResolution } from "./resolution";

export function envWebSearchModel(): string | null {
	return config.WEB_SEARCH_MODEL?.trim() || null;
}

export async function storedWebSearchModel(): Promise<string | null> {
	const row = await collections.knowledgeConfig.findOne({});
	return row?.webSearchModel?.trim() || null;
}

export async function writeWebSearchModel(model: string | null): Promise<void> {
	await collections.knowledgeConfig.updateOne(
		{},
		{
			$set: { webSearchModel: model, updatedAt: new Date() },
			$setOnInsert: { createdAt: new Date() },
		},
		{ upsert: true }
	);
}

const CACHE_MS = 30_000;
const granted = new Map<string, { at: number; ids: Promise<string[]> }>();

/** The caller's granted search backends, remembered briefly per token so a
 * navigation, a turn and the composer do not each ask the gateway. */
export function cachedSearchModelIds(token: string, now = Date.now()): Promise<string[]> {
	const key = createHash("sha256").update(token).digest("hex");
	const hit = granted.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit.ids;
	const ids = findSearchModelIds(token);
	granted.set(key, { at: now, ids });
	if (granted.size > 500) {
		for (const [k, v] of granted) if (now - v.at >= CACHE_MS) granted.delete(k);
	}
	return ids;
}

export function clearSearchModelCache(): void {
	granted.clear();
}

/** This caller's backend resolution: the choice, and whether search is usable at all. */
export async function resolveWebSearchFor(
	token: string | undefined
): Promise<WebSearchResolution & { granted: string[] }> {
	const ids = token ? await cachedSearchModelIds(token) : [];
	// A stored read only when no env value decides, and never fatal: a Mongo
	// hiccup means "policy decides", not a failed turn.
	let stored: string | null = null;
	if (!envWebSearchModel()) {
		try {
			stored = await storedWebSearchModel();
		} catch {
			stored = null;
		}
	}
	return {
		...resolveWebSearch({ envModel: envWebSearchModel(), storedModel: stored, granted: ids }),
		granted: ids,
	};
}
