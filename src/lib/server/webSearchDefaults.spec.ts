/**
 * Defaults-vs-state for web search and MCP connectors.
 *
 * Settings hold *defaults*, a chat holds *per-chat state*; new chats inherit
 * the defaults, and nothing done inside a chat ever writes back to them.
 * Precedence chain (settled): per-chat state > project defaults (when in a
 * project) > app settings / workspace MCP defaults > off.
 */

import { describe, it, expect } from "vitest";
import { resolveWebSearchEnabled, resolveInitialConnectorIds } from "./webSearchDefaults";

describe("resolveWebSearchEnabled", () => {
	it("is off when nothing is set anywhere", () => {
		expect(resolveWebSearchEnabled({})).toBe(false);
	});

	it("per-chat true wins over everything unset", () => {
		expect(resolveWebSearchEnabled({ conversationWebSearch: true })).toBe(true);
	});

	it("per-chat false overrides project and app defaults of true", () => {
		expect(
			resolveWebSearchEnabled({
				conversationWebSearch: false,
				projectDefault: true,
				settingsEnabled: true,
			})
		).toBe(false);
	});

	it("per-chat true overrides project and app defaults of false", () => {
		expect(
			resolveWebSearchEnabled({
				conversationWebSearch: true,
				projectDefault: false,
				settingsEnabled: false,
			})
		).toBe(true);
	});

	it("project default applies when the chat leaves it unset", () => {
		expect(resolveWebSearchEnabled({ projectDefault: true })).toBe(true);
		expect(resolveWebSearchEnabled({ projectDefault: false, settingsEnabled: true })).toBe(false);
	});

	it("app default applies when chat and project leave it unset", () => {
		expect(resolveWebSearchEnabled({ settingsEnabled: true })).toBe(true);
		expect(resolveWebSearchEnabled({ settingsEnabled: false })).toBe(false);
	});

	it("toggling in one chat does not change the default or other chats", () => {
		// The default both chats inherited.
		const appDefault = true;
		// Chat A turns it off: per-chat state, resolved against the same default.
		const chatA = resolveWebSearchEnabled({
			conversationWebSearch: false,
			settingsEnabled: appDefault,
		});
		// Chat B never touched anything: still the default.
		const chatB = resolveWebSearchEnabled({ settingsEnabled: appDefault });
		expect(chatA).toBe(false);
		expect(chatB).toBe(true);
	});
});

describe("resolveInitialConnectorIds", () => {
	it("project defaults win when the project names any", () => {
		expect(
			resolveInitialConnectorIds({
				projectDefaults: ["conn-a"],
				workspaceDefaults: ["conn-b", "conn-c"],
			})
		).toEqual(["conn-a"]);
	});

	it("workspace defaults apply when the project leaves them unset", () => {
		expect(resolveInitialConnectorIds({ workspaceDefaults: ["conn-b", "conn-c"] })).toEqual([
			"conn-b",
			"conn-c",
		]);
		expect(resolveInitialConnectorIds({})).toEqual([]);
	});

	it("returns a copy: mutating the selection never mutates a default", () => {
		const project = ["conn-a"];
		const workspace = ["conn-b"];
		const selection = resolveInitialConnectorIds({
			projectDefaults: project,
			workspaceDefaults: workspace,
		});
		selection.push("conn-evil");
		expect(project).toEqual(["conn-a"]);
		expect(workspace).toEqual(["conn-b"]);
	});
});
