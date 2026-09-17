import { describe, expect, it, vi, beforeEach } from "vitest";

const gatewayPostMock: ReturnType<typeof vi.fn> = vi.fn();

const { GatewayCallFailed } = vi.hoisted(() => {
	class GatewayCallFailed extends Error {
		constructor(
			readonly status: number,
			message: string
		) {
			super(message);
			this.name = "GatewayCallFailed";
		}
	}
	return { GatewayCallFailed };
});

vi.mock("$lib/server/gatewayServer", () => ({
	GatewayCallFailed,
	gateway: { get: vi.fn(), post: gatewayPostMock, del: vi.fn() },
}));

const { verifyUrlBySearch } = await import("./fetchVerification");

beforeEach(() => gatewayPostMock.mockReset());

describe("verifyUrlBySearch", () => {
	// `mockImplementationOnce`, not `mockResolvedValue`/`mockRejectedValue`: this suite mixes
	// resolved and rejected results across sequential tests sharing one mock, and the
	// persistent-default form leaks its previous test's outcome across the `mockReset` in
	// `beforeEach` in that combination.
	it("matches when the exact URL is a fresh search result", async () => {
		gatewayPostMock.mockImplementationOnce(() =>
			Promise.resolve({
				results: [{ url: "https://example.test/a" }, { url: "https://example.test/b" }],
			})
		);
		const outcome = await verifyUrlBySearch({ url: "https://example.test/a", token: "t" });
		expect(outcome).toEqual({ matched: true });
	});

	it("matches through the reviewed GitHub raw/blob equivalence, not model discretion", async () => {
		gatewayPostMock.mockImplementationOnce(() =>
			Promise.resolve({
				results: [{ url: "https://github.com/octocat/hello/blob/main/README.md" }],
			})
		);
		const outcome = await verifyUrlBySearch({
			url: "https://raw.githubusercontent.com/octocat/hello/main/README.md",
			token: "t",
		});
		expect(outcome).toEqual({ matched: true });
	});

	it("fails closed with evidence when nothing in the results matches", async () => {
		gatewayPostMock.mockImplementationOnce(() =>
			Promise.resolve({
				results: [{ url: "https://example.test/unrelated" }],
			})
		);
		const outcome = await verifyUrlBySearch({ url: "https://example.test/a", token: "t" });
		expect(outcome.matched).toBe(false);
		if (outcome.matched) throw new Error("unreachable");
		expect(outcome.evidence).toContain("https://example.test/a");
		expect(outcome.evidence).toContain("https://example.test/unrelated");
		expect(outcome.evidence).toContain("None of these results named the requested URL");
	});

	it("fails closed with evidence when the search backend itself fails", async () => {
		gatewayPostMock.mockImplementationOnce(() =>
			Promise.reject(new GatewayCallFailed(404, "no search policy for this group"))
		);
		const outcome = await verifyUrlBySearch({ url: "https://example.test/a", token: "t" });
		expect(outcome.matched).toBe(false);
		if (outcome.matched) throw new Error("unreachable");
		expect(outcome.evidence).toContain("no search policy for this group");
	});

	it("never computes the match from the model's say-so, only from what the search actually returned", async () => {
		gatewayPostMock.mockImplementationOnce(() => Promise.resolve({ results: [] }));
		const outcome = await verifyUrlBySearch({ url: "https://example.test/a", token: "t" });
		expect(outcome).toEqual({
			matched: false,
			evidence: expect.stringContaining("(no results)"),
		});
		expect(gatewayPostMock).toHaveBeenCalledTimes(1);
	});
});
