import { describe, expect, it } from "vitest";
import { resolveWebSearch } from "./resolution";

describe("resolveWebSearch", () => {
	it("is unavailable with no granted backend, whatever is configured", () => {
		expect(resolveWebSearch({ envModel: null, storedModel: "exa", granted: [] })).toEqual({
			model: null,
			source: "stored",
			stale: true,
			available: false,
		});
	});

	it("lets the group policy decide when nothing is chosen", () => {
		expect(resolveWebSearch({ envModel: null, storedModel: null, granted: ["exa"] })).toEqual({
			model: null,
			source: "policy",
			stale: false,
			available: true,
		});
	});

	it("names the stored choice when the caller is granted it", () => {
		const r = resolveWebSearch({
			envModel: null,
			storedModel: "linkup",
			granted: ["exa", "linkup"],
		});
		expect(r).toMatchObject({ model: "linkup", source: "stored", stale: false, available: true });
	});

	it("lets the environment win over the stored choice", () => {
		const r = resolveWebSearch({
			envModel: "exa",
			storedModel: "linkup",
			granted: ["exa", "linkup"],
		});
		expect(r).toMatchObject({ model: "exa", source: "env" });
	});

	it("degrades an ungranted choice to the policy and marks it stale", () => {
		const r = resolveWebSearch({ envModel: null, storedModel: "jina", granted: ["exa"] });
		expect(r).toMatchObject({ model: null, stale: true, available: true });
	});
});
