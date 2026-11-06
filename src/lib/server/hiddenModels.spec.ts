import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ saved: undefined as string | undefined, env: "" }));
vi.mock("$lib/server/config", () => ({
	config: {
		getSaved: () => state.saved,
		get HIDDEN_MODELS() {
			return state.env;
		},
	},
}));

import { hiddenModelIds, isUnlistedForUsers, parseHiddenModels } from "./hiddenModels";

beforeEach(() => {
	state.saved = undefined;
	state.env = "";
});

describe("hidden models", () => {
	it("parses comma and newline lists, dropping blanks and repeats", () => {
		expect(parseHiddenModels(" a, b\n,a,, ")).toEqual(["a", "b"]);
		expect(parseHiddenModels(undefined)).toEqual([]);
	});

	it("a saved value wins, even empty; else the environment", () => {
		state.env = "env";
		expect(hiddenModelIds()).toEqual(["env"]);
		state.saved = "saved";
		expect(hiddenModelIds()).toEqual(["saved"]);
		state.saved = "";
		expect(hiddenModelIds()).toEqual([]);
	});

	it("hidden counts as unlisted for users, except the default model", () => {
		state.saved = "small,big";
		expect(isUnlistedForUsers({ id: "small" }, "big")).toBe(true);
		expect(isUnlistedForUsers({ id: "big" }, "big")).toBe(false);
		expect(isUnlistedForUsers({ id: "other" }, "big")).toBe(false);
		expect(isUnlistedForUsers({ id: "old", unlisted: true }, "big")).toBe(true);
	});
});
