import { describe, expect, it } from "vitest";
import { connectorNameKey, connectorNameTaken, sameConnectorName } from "./connectorName";

describe("connector names (C169)", () => {
	it("clash after trimming, collapsing whitespace and case-folding", () => {
		expect(sameConnectorName("Notion", "notion")).toBe(true);
		expect(sameConnectorName("  Notion ", "NOTION")).toBe(true);
		expect(sameConnectorName("My   Notes", "my notes")).toBe(true);
		expect(sameConnectorName("My\tNotes", "my notes")).toBe(true);
		expect(connectorNameKey("Café")).toBe(connectorNameKey("Café"));
	});
	it("do not clash when they differ", () => {
		expect(sameConnectorName("Notion", "Notion 2")).toBe(false);
		expect(sameConnectorName("MyNotes", "My Notes")).toBe(false);
	});
	it("words the refusal with the name as shown", () => {
		expect(connectorNameTaken("  Notion  ")).toBe(
			'A connector named "Notion" already exists. Choose another name.'
		);
	});
});
