/**
 * Cerea's contract and the runtime's `browser-runtime/src/extensions.ts` agree. The runtime keeps
 * its own copy of the contract (synced from `contract.ts`); once the two are merged this checks
 * that the `use_tab` digest, the tools and the new fields are the same on both sides. Skipped on a
 * branch without the runtime.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { actionDigest } from "./classifier";
import {
	RUNTIME_TOOLS,
	browserActionSchema,
	tabsResultSchema,
	endTaskResultSchema,
} from "./contract";

const extensions = resolve(process.cwd(), "browser-runtime/src/extensions.ts");

describe.skipIf(!existsSync(extensions))("the runtime's extensions", () => {
	it("agree with the contract", async () => {
		const ext = await import(/* @vite-ignore */ extensions);
		const tab = { id: "t1", url: "https://flights.example.com/s#frag", title: "Flights" };
		expect(ext.useTabDigest(tab)).toBe(
			actionDigest({ type: "use_tab", tab: "t1" }, { currentUrl: "https://x.test/", tab })
		);
		expect(RUNTIME_TOOLS).toEqual(expect.arrayContaining([ext.TABS_TOOL, "resume", "end_task"]));
		const sample = { type: "use_tab", tab: "t1" };
		expect(browserActionSchema.safeParse(sample).success).toBe(true);
		expect(ext.useTabActionSchema.safeParse(sample).success).toBe(true);
		const tabs = { tabs: [{ id: "a", title: "t", url: "https://x.test/", mine: false }] };
		expect(tabsResultSchema.safeParse(tabs).success).toBe(
			ext.tabsResultSchema.safeParse(tabs).success
		);
		expect(
			endTaskResultSchema.safeParse({
				closed: false,
				kept: { token: "k", id: "1", title: "t", url: "u" },
			}).success
		).toBe(true);
	});
});
