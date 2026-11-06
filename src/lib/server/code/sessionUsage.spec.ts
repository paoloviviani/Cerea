import { describe, expect, it, vi, beforeEach } from "vitest";

const getMock: ReturnType<typeof vi.fn> = vi.fn();

class FakeGatewayCallFailed extends Error {
	constructor(readonly status: number) {
		super("failed");
	}
}

vi.mock("$lib/server/gatewayServer", () => ({
	gateway: { get: getMock },
	GatewayCallFailed: FakeGatewayCallFailed,
}));
vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { sessionGatewayUsage } = await import("./sessionUsage");

const row = (tag: string, cost: string, requests = 2) => ({
	tag,
	requests,
	prompt_tokens: 1000,
	completion_tokens: 200,
	cached_prompt_tokens: 600,
	cost,
	currency: "EUR",
});

describe("sessionGatewayUsage", () => {
	beforeEach(() => {
		getMock.mockReset();
	});

	it("reads the session's totals under its own tag, with the caller's token", async () => {
		getMock.mockResolvedValue({ tags: [row("ses_1", "0.0420")] });
		const out = await sessionGatewayUsage("tok", "ses_1");
		expect(getMock).toHaveBeenCalledTimes(1);
		expect(getMock.mock.calls[0][0]).toBe("tok");
		expect(getMock.mock.calls[0][1]).toBe("pystino/usage/tags?tag=ses_1");
		expect(out).toEqual({
			currency: "EUR",
			session: {
				requests: 2,
				promptTokens: 1000,
				completionTokens: 200,
				cachedPromptTokens: 600,
				cost: "0.0420",
			},
			window: null,
		});
	});

	it("asks again for the turn's window and returns it beside the session", async () => {
		getMock.mockImplementation(async (_token: string, path: string) =>
			path.includes("since=")
				? { tags: [row("ses_1", "0.0100", 1)] }
				: { tags: [row("ses_1", "0.04")] }
		);
		const since = new Date("2026-11-06T10:00:00Z");
		const until = new Date("2026-11-06T10:05:00Z");
		const out = await sessionGatewayUsage("tok", "ses_1", { since, until });
		const windowPath = getMock.mock.calls
			.map((c) => c[1])
			.find((p: string) => p.includes("since="));
		expect(windowPath).toContain("since=2026-11-06T10%3A00%3A00.000Z");
		expect(windowPath).toContain("until=2026-11-06T10%3A05%3A00.000Z");
		expect(out?.session?.cost).toBe("0.04");
		expect(out?.window?.cost).toBe("0.0100");
		expect(out?.window?.requests).toBe(1);
	});

	it("has no figures for a session the gateway has no rows for", async () => {
		getMock.mockResolvedValue({ tags: [] });
		expect(await sessionGatewayUsage("tok", "ses_2")).toEqual({
			currency: null,
			session: null,
			window: null,
		});
	});

	it("tolerates null fields from the gateway", async () => {
		getMock.mockResolvedValue({ tags: null });
		const out = await sessionGatewayUsage("tok", "ses_2");
		expect(out?.session).toBeNull();
	});

	it("is null for a gateway without tags (404) and for any failure, never throwing", async () => {
		getMock.mockRejectedValueOnce(new FakeGatewayCallFailed(404));
		expect(await sessionGatewayUsage("tok", "ses_1")).toBeNull();
		getMock.mockRejectedValueOnce(new Error("boom"));
		expect(await sessionGatewayUsage("tok", "ses_1")).toBeNull();
	});

	it("does not ask about an id longer than a tag can be", async () => {
		expect(await sessionGatewayUsage("tok", "x".repeat(129))).toBeNull();
		expect(getMock).not.toHaveBeenCalled();
	});
});
