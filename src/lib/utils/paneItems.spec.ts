import { describe, expect, it } from "vitest";
import type { ArtifactRegistry } from "./artifacts";
import type { FileArtifactRegistry } from "./fileArtifacts";
import { collectPaneItems, isPaneItemSelected } from "./paneItems";

function textRegistry(): ArtifactRegistry {
	return {
		artifacts: new Map([
			[
				"app",
				{
					identifier: "app",
					versions: [
						{
							identifier: "app",
							type: "html",
							title: "App",
							content: "<html></html>",
							complete: true,
							op: "create",
							version: 1,
							messageId: "m1",
						},
					],
				},
			],
		]),
		byMessageOp: new Map(),
	};
}

function fileRegistry(): FileArtifactRegistry {
	return {
		artifacts: new Map([
			[
				"report.pdf",
				{
					name: "report.pdf",
					versions: [{ name: "report.pdf", size: 9, sha256: "s1", version: 1, messageId: "m2" }],
				},
			],
		]),
	};
}

describe("collectPaneItems with file artifacts", () => {
	it("lists the file after the text artifact, in message order", () => {
		const items = collectPaneItems(
			[{ id: "m1" }, { id: "m2" }],
			textRegistry(),
			[],
			fileRegistry()
		);
		expect(items).toEqual([
			{ kind: "artifact", identifier: "app", label: "App" },
			{ kind: "file", name: "report.pdf", label: "report.pdf" },
		]);
	});

	it("works without a file registry", () => {
		const items = collectPaneItems([{ id: "m1" }], textRegistry(), []);
		expect(items).toEqual([{ kind: "artifact", identifier: "app", label: "App" }]);
	});

	it("selects a file item when the artifact view shows its name", () => {
		const item = { kind: "file", name: "report.pdf", label: "report.pdf" } as const;
		expect(isPaneItemSelected(item, { view: "artifact", identifier: "report.pdf" })).toBe(true);
		expect(isPaneItemSelected(item, { view: "artifact", identifier: "app" })).toBe(false);
		expect(isPaneItemSelected(item, { view: "preview", identifier: "report.pdf" })).toBe(false);
	});
});
