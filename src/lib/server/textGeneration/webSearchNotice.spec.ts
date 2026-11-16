import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	granted: ["search-a"] as string[],
	settings: { webSearchEnabled: undefined as boolean | undefined },
	project: undefined as { defaultWebSearch?: boolean } | undefined,
}));

vi.mock("$lib/server/webSearch/config", () => ({
	resolveWebSearchFor: async () => ({ granted: mocks.granted, model: null }),
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		settings: { findOne: async () => mocks.settings },
		projects: { findOne: async () => mocks.project },
	},
}));

import {
	WEB_SEARCH_NEEDS_TOOLS_LINE,
	WEB_SEARCH_OFF_LINE,
	webSearchNoticeFor,
	webSearchNoticeLine,
} from "./webSearchNotice";

describe("webSearchNoticeLine", () => {
	it("tells a tool-less model that search is on but it cannot search", () => {
		expect(webSearchNoticeLine({ enabled: true, granted: true, toolsEnabled: false })).toBe(
			"Web search is on, but this model cannot use tools, so it cannot search. Pick a model that supports tools."
		);
	});
	it("points a tool-capable model at the switch when search is off", () => {
		expect(webSearchNoticeLine({ enabled: false, granted: true, toolsEnabled: true })).toBe(
			WEB_SEARCH_OFF_LINE
		);
		expect(WEB_SEARCH_OFF_LINE).toContain("switch in the composer");
	});
	it("says nothing when search works, or nothing is granted", () => {
		expect(
			webSearchNoticeLine({ enabled: true, granted: true, toolsEnabled: true })
		).toBeUndefined();
		expect(
			webSearchNoticeLine({ enabled: true, granted: false, toolsEnabled: false })
		).toBeUndefined();
		expect(
			webSearchNoticeLine({ enabled: false, granted: false, toolsEnabled: true })
		).toBeUndefined();
		expect(
			webSearchNoticeLine({ enabled: false, granted: true, toolsEnabled: false })
		).toBeUndefined();
	});
});

describe("webSearchNoticeFor", () => {
	const locals = { user: { _id: "u" }, token: "t" } as never;
	const noTools = { model: { supportsTools: false }, locals } as never;
	const tools = { model: { supportsTools: true }, locals } as never;

	it("uses the chat, then project, then app default", async () => {
		mocks.granted = ["s"];
		mocks.settings = { webSearchEnabled: undefined };
		mocks.project = undefined;
		expect(await webSearchNoticeFor(tools, {})).toBe(WEB_SEARCH_OFF_LINE);
		mocks.settings = { webSearchEnabled: true };
		expect(await webSearchNoticeFor(noTools, {})).toBe(WEB_SEARCH_NEEDS_TOOLS_LINE);
		expect(await webSearchNoticeFor(noTools, { webSearch: false })).toBeUndefined();
		mocks.settings = { webSearchEnabled: undefined };
		mocks.project = { defaultWebSearch: true };
		expect(await webSearchNoticeFor(noTools, { projectId: "p" as never })).toBe(
			WEB_SEARCH_NEEDS_TOOLS_LINE
		);
	});
	it("lets forceTools win and skips when no backend is granted", async () => {
		mocks.project = undefined;
		mocks.settings = { webSearchEnabled: true };
		expect(
			await webSearchNoticeFor(
				{ model: { supportsTools: true }, forceTools: false, locals } as never,
				{}
			)
		).toBe(WEB_SEARCH_NEEDS_TOOLS_LINE);
		mocks.granted = [];
		expect(await webSearchNoticeFor(noTools, {})).toBeUndefined();
	});
});
