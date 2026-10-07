/**
 * The id scheme for custom models, shared by server and browser.
 *
 * `custom:<24-hex ObjectId>`. The prefix is collision-proof against the
 * catalogue: gateway model ids are provider/model slugs and the gateway never
 * hands out an id containing a colon followed by 24 hex digits, and the
 * server additionally refuses to resolve a `custom:` id that is not in the
 * caller's own list, so a catalogue id could never be mistaken for one.
 */
export const CUSTOM_MODEL_PREFIX = "custom:";

const CUSTOM_ID = /^custom:([0-9a-f]{24})$/;

export function isCustomModelId(id: string | undefined | null): id is string {
	return typeof id === "string" && CUSTOM_ID.test(id);
}

export function customModelId(objectId: string): string {
	return `${CUSTOM_MODEL_PREFIX}${objectId}`;
}

/** The ObjectId hex inside a custom id, or undefined for anything else. */
export function customModelObjectId(id: string | undefined | null): string | undefined {
	if (typeof id !== "string") return undefined;
	return CUSTOM_ID.exec(id)?.[1];
}
