/**
 * The gate the browser endpoints share (ADR 0116, C109): a signed-in user, the deployment switch
 * (a 404 when off, so the feature reads as absent), and the user's own ready computers.
 */
import { error } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { browseMachinesFor, type BrowseMachine } from "./availability";
import { mongoChoiceStore, type ChoiceStore } from "./machineChoice";
import { browserEnabled } from "./settings";

export function requireBrowserUse(locals: App.Locals): { userId: ObjectId } {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	if (!browserEnabled()) error(404, "Browser use is not turned on here.");
	return { userId: locals.user._id };
}

export interface BrowserComputer extends BrowseMachine {
	/** The user's default for browsing. */
	default: boolean;
	/** The computer this conversation already uses. */
	current: boolean;
}

/** The ready computers, the default first, then by name. */
export async function readyComputers(
	locals: App.Locals,
	userId: ObjectId,
	conversationId?: string,
	store: ChoiceStore = mongoChoiceStore
): Promise<BrowserComputer[]> {
	const ready = await browseMachinesFor(locals);
	if (ready.length === 0) return [];
	const [defaultId, currentId] = await Promise.all([
		store.defaultDevice(userId).catch(() => undefined),
		conversationId
			? store.conversationDevice(userId, conversationId).catch(() => undefined)
			: undefined,
	]);
	return ready
		.map((m) => ({ ...m, default: m.id === defaultId, current: m.id === currentId }))
		.sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
}
