import { describe, expect, it } from "vitest";
import { indexErrorForUser } from "./indexError";

describe("indexErrorForUser", () => {
	it("turns a gateway quota refusal into one plain sentence", () => {
		const raw =
			"Quota exceeded. global per user limit of 0.500000000000 cost per month exceeded (current 0.500225765)";
		const shown = indexErrorForUser(raw);
		expect(shown).toMatch(/^Not indexed: the usage allowance had run out/);
		expect(shown).not.toMatch(/0\.5000|cost per month|current/);
		expect(indexErrorForUser(`429 ${raw}`)).toBe(shown);
	});

	it("leaves other errors and empty values as they are", () => {
		expect(indexErrorForUser("Indexing failed.")).toBe("Indexing failed.");
		expect(indexErrorForUser("")).toBeNull();
		expect(indexErrorForUser(null)).toBeNull();
	});
});
