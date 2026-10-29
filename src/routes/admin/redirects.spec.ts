/**
 * The admin sections that were folded into the Web and Assistant tabs: their
 * old addresses still answer, with a permanent redirect to the new tab and the
 * section's anchor, so bookmarks and links in old documents keep working.
 */
import { describe, expect, it } from "vitest";

import { load as webSearch } from "./web-search/+page.server";
import { load as fetching } from "./fetch/+page.server";
import { load as instructions } from "./instructions/+page.server";
import { load as delegation } from "./delegation/+page.server";
import { load as voice } from "./voice/+page.server";

async function target(load: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await load();
	} catch (thrown) {
		return thrown as { status: number; location: string };
	}
	throw new Error("expected a redirect");
}

describe("old admin addresses", () => {
	it.each([
		["web-search", webSearch, "/admin/web#web-search"],
		["fetch", fetching, "/admin/web#fetch"],
		["instructions", instructions, "/admin/assistant#instructions"],
		["delegation", delegation, "/admin/assistant#sub-agents"],
		["voice", voice, "/admin/assistant#voice"],
	])("/admin/%s redirects to %s", async (_old, load, expected) => {
		const result = await target(load as never);
		expect(result.status).toBe(308);
		expect(result.location).toBe(expected);
	});
});
