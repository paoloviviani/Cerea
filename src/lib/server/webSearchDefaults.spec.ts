/**
 * Whether web search is on for a turn: the user's opt-out (Settings), then a
 * project that turns it off, otherwise on. There is no per-chat switch.
 */

import { describe, it, expect } from "vitest";
import { resolveWebSearchEnabled } from "./webSearchDefaults";

describe("resolveWebSearchEnabled", () => {
	it("is on when nothing is set anywhere (the user's setting is an opt-out)", () => {
		expect(resolveWebSearchEnabled({})).toBe(true);
		expect(resolveWebSearchEnabled({ settingsEnabled: null, projectDefault: null })).toBe(true);
	});

	it("is on when the user's setting is on", () => {
		expect(resolveWebSearchEnabled({ settingsEnabled: true })).toBe(true);
	});

	it("the user's opt-out wins over everything, project default included", () => {
		expect(resolveWebSearchEnabled({ settingsEnabled: false })).toBe(false);
		expect(resolveWebSearchEnabled({ settingsEnabled: false, projectDefault: true })).toBe(false);
	});

	it("a project that turns it off turns it off for the user who left it on", () => {
		expect(resolveWebSearchEnabled({ projectDefault: false })).toBe(false);
		expect(resolveWebSearchEnabled({ projectDefault: false, settingsEnabled: true })).toBe(false);
		expect(resolveWebSearchEnabled({ projectDefault: true, settingsEnabled: true })).toBe(true);
	});
});
