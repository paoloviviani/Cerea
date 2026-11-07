import { config } from "$lib/server/config";
import { sanitizeOrgDefaults, type OrgSlideDefaults } from "$lib/utils/slides/themes";

/**
 * The organisation's brand variables for slide decks (ADR 0111): an
 * accent colour and a logo, set under Administration -> Assistant. Off (empty)
 * unless saved. Stored as JSON in the chat's `config` collection like the
 * other admin switches; every value is validated on the way in and again here,
 * so a hand-edited environment value cannot carry anything but the three knobs.
 */
export function slideDefaults(): OrgSlideDefaults {
	const raw = config.getSaved("CHAT_SLIDES_DEFAULTS") ?? config.CHAT_SLIDES_DEFAULTS ?? "";
	if (!raw.trim()) return {};
	try {
		return sanitizeOrgDefaults(JSON.parse(raw));
	} catch {
		return {};
	}
}
