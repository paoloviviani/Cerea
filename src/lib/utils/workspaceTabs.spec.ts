import { describe, expect, it } from "vitest";
import { workspaceRedirect } from "./workspaceTabs";

const redirect = (query: string) => workspaceRedirect(new URL(`http://x/workspace${query}`));

describe("workspaceRedirect", () => {
	it("sends the Local connectors tab to the machines section of Connectors", () => {
		expect(redirect("?tab=local")).toBe("?tab=mcp#on-your-machines");
	});

	it("sends the Custom models tab to its section of Models", () => {
		expect(redirect("?tab=custom")).toBe("?tab=models#custom-models");
	});

	it("keeps a custom model's id as `custom`, so it opens in its own section", () => {
		expect(redirect("?tab=custom&id=custom%3Aabc")).toBe(
			"?tab=models&custom=custom%3Aabc#custom-models"
		);
	});

	it("leaves every current address alone", () => {
		expect(redirect("")).toBeNull();
		expect(redirect("?tab=models&id=a%2Fb")).toBeNull();
		expect(redirect("?tab=mcp")).toBeNull();
		expect(redirect("?tab=kb&id=x")).toBeNull();
		expect(redirect("?tab=nonsense")).toBeNull();
	});
});
