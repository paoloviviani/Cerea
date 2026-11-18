import { describe, expect, it } from "vitest";
import { engineKey, engineLabel } from "./engineLabel";

describe("engineLabel", () => {
	it("names Mistral Vibe for the id it gives itself over ACP", () => {
		expect(engineLabel("acp:@mistralai/mistral-vibe")).toBe("Mistral Vibe");
		expect(engineKey("acp:@mistralai/mistral-vibe")).toBe("vibe");
	});

	it("keeps opencode and goose as they are called", () => {
		expect(engineLabel("opencode")).toBe("opencode");
		expect(engineLabel("acp:goose")).toBe("goose");
		expect(engineKey("acp:goose")).toBe("goose");
	});

	it("shows another ACP agent by its own name, without the protocol prefix", () => {
		expect(engineLabel("acp:pi-acp")).toBe("pi-acp");
		expect(engineKey("acp:pi-acp")).toBe("other");
	});

	it("has nothing for no provider", () => {
		expect(engineLabel(undefined)).toBeUndefined();
		expect(engineLabel("")).toBeUndefined();
		expect(engineKey(null)).toBe("other");
	});
});
