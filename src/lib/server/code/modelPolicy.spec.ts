import { describe, expect, it } from "vitest";
import { allowsModel, filterModels } from "./modelPolicy";

const open = { policy: { allowFreeModels: true } } as never;
const gatewayOnly = { policy: { allowFreeModels: false } } as never;
const CUSTOM = "custom:0123456789abcdef01234567";

describe("the /code panel and custom models", () => {
	it("never drives a machine onto a custom model, even one that allows free models", () => {
		expect(allowsModel(open, CUSTOM)).toBe(false);
		expect(allowsModel(gatewayOnly, CUSTOM)).toBe(false);
	});

	it("hides them from a listing and counts them as hidden", () => {
		const listed = [{ id: "pystino/a" }, { id: CUSTOM }, { id: "opencode/free" }];
		expect(filterModels(open, listed)).toEqual({
			models: [{ id: "pystino/a" }, { id: "opencode/free" }],
			hidden: 1,
		});
	});

	it("leaves ordinary models as they were", () => {
		expect(allowsModel(open, "opencode/free")).toBe(true);
		expect(allowsModel(gatewayOnly, "opencode/free")).toBe(false);
		expect(allowsModel(gatewayOnly, "pystino/a")).toBe(true);
	});
});
