import { describe, expect, it } from "vitest";

import vectors from "./normalizeEmailVectors.json";
import { isTrustedEmail, normalizeEmail } from "./normalizeEmail";

describe("normalizeEmail / isTrustedEmail against the shared vectors", () => {
	for (const vector of vectors.vectors as {
		input: string;
		normalized: string | null;
		trusted: boolean;
	}[]) {
		it(`${JSON.stringify(vector.input)}`, () => {
			if (vector.normalized !== null) {
				expect(normalizeEmail(vector.input)).toBe(vector.normalized);
			}
			expect(isTrustedEmail(vector.input)).toBe(vector.trusted);
		});
	}
});
