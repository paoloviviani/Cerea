import { describe, expect, it } from "vitest";
import { credentialLikeParams, stripAddress } from "./connectorUrl";

describe("connector addresses", () => {
	it("strips the query, the fragment and userinfo", () => {
		expect(stripAddress("https://user:pw@api.example.test:8443/mcp?apiKey=SECRET#x")).toBe(
			"https://api.example.test:8443/mcp"
		);
		expect(stripAddress("not an address")).toBe("not an address");
	});

	it("names the query parameters that look like a key", () => {
		expect(credentialLikeParams("https://a.test/mcp?apiKey=1&page=2&access_token=3")).toEqual([
			"apiKey",
			"access_token",
		]);
		expect(credentialLikeParams("https://a.test/mcp?page=2")).toEqual([]);
		expect(credentialLikeParams("nope")).toEqual([]);
	});
});
