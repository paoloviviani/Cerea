import { describe, expect, it } from "vitest";
import { agentDisplayTitle, folderName } from "./codeAgentTitle";

describe("folderName", () => {
	it("is the last segment of a path", () => {
		expect(folderName("/home/paolo/repos/cloud_stuff")).toBe("cloud_stuff");
		expect(folderName("/home/paolo/repos/cloud_stuff/")).toBe("cloud_stuff");
		expect(folderName("C:\\Users\\p\\proj")).toBe("proj");
		expect(folderName("")).toBe("");
		expect(folderName(null)).toBe("");
	});
});

describe("agentDisplayTitle", () => {
	it("keeps a real title", () => {
		expect(agentDisplayTitle(" Fix login ", { name: "x" }, "New session")).toBe("Fix login");
	});
	it("never shows the whole folder path", () => {
		const ws = { name: "/home/paolo/repos/cloud_stuff", path: "/home/paolo/repos/cloud_stuff" };
		expect(agentDisplayTitle("", ws, "New session")).toBe("cloud_stuff");
		expect(agentDisplayTitle(undefined, { name: "api", path: "/srv/api" }, "New session")).toBe(
			"api"
		);
	});
	it("falls back to the generic label", () => {
		expect(agentDisplayTitle("", undefined, "New session")).toBe("New session");
	});
});
