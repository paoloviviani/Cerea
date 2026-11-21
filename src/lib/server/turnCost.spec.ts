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

const { turnGatewayCost, turnTag, turnTagHeader } = await import("./turnCost");

const ID = "11111111-1111-4111-8111-111111111111";
const CONV = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbb";
const NEW = { conversationId: CONV, scopedTag: true };
const OLD = { conversationId: CONV };
const row = (cost: unknown, extra: Record<string, unknown> = {}) => ({
	tag: turnTag(CONV, ID),
	requests: 2,
	cost,
	currency: "EUR",
	...extra,
});
const noSleep = vi.fn(async () => {});

describe("turn tags", () => {
	it("stamps turn:<conversation id>:<message id>, and nothing without both", () => {
		expect(turnTagHeader(ID, CONV)).toEqual({ "x-pystino-tag": `turn:${CONV}:${ID}` });
		expect(turnTagHeader(undefined, CONV)).toEqual({});
		expect(turnTagHeader(ID, undefined)).toEqual({});
		expect(turnTag(CONV, ID).length).toBeLessThanOrEqual(128);
	});
});

describe("turnGatewayCost", () => {
	beforeEach(() => {
		getMock.mockReset();
		noSleep.mockClear();
	});

	it("reads the turn's total under its tag with the caller's token", async () => {
		getMock.mockResolvedValue({ tags: [row("0.0042")] });
		const out = await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep });
		expect(getMock).toHaveBeenCalledTimes(1);
		expect(getMock.mock.calls[0][0]).toBe("tok");
		expect(getMock.mock.calls[0][1]).toBe(`pystino/usage/tags?tag=turn%3A${CONV}%3A${ID}`);
		expect(out).toEqual({ status: "ok", cost: "0.0042", currency: "EUR", requests: 2 });
		expect(noSleep).not.toHaveBeenCalled();
	});

	it("tolerates nulls everywhere the gateway may send them", async () => {
		getMock.mockResolvedValue({
			tags: [null, row("0.5", { requests: null, currency: null }), { tag: null, cost: null }],
		});
		expect(await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).toEqual({
			status: "ok",
			cost: "0.5",
			currency: null,
			requests: 0,
		});
		getMock.mockResolvedValue({ tags: null });
		expect((await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).status).toBe("pending");
		getMock.mockResolvedValue(null);
		expect((await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).status).toBe(
			"unavailable"
		);
	});

	it("accepts a numeric cost and rejects one that is not a plain decimal", async () => {
		getMock.mockResolvedValue({ tags: [row(0.25)] });
		expect(await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).toMatchObject({
			cost: "0.25",
		});
		getMock.mockResolvedValue({ tags: [row("1e-3")] });
		expect((await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).status).toBe(
			"unavailable"
		);
	});

	it("asks once more after the delay when nothing has settled, then gives up", async () => {
		getMock.mockResolvedValue({ tags: [] });
		const out = await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep, retryDelayMs: 2000 });
		expect(out).toEqual({ status: "pending" });
		expect(getMock).toHaveBeenCalledTimes(2);
		expect(noSleep).toHaveBeenCalledWith(2000);
	});

	it("returns the figure when the retry finds it", async () => {
		getMock.mockResolvedValueOnce({ tags: [] }).mockResolvedValueOnce({ tags: [row("0.01")] });
		const out = await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep });
		expect(out).toMatchObject({ status: "ok", cost: "0.01" });
		expect(getMock).toHaveBeenCalledTimes(2);
	});

	it("is unavailable, without retrying, for a gateway without tags or none at all", async () => {
		for (const status of [404, 503, 500]) {
			getMock.mockReset();
			getMock.mockRejectedValue(new FakeGatewayCallFailed(status));
			expect(await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).toEqual({
				status: "unavailable",
			});
			expect(getMock).toHaveBeenCalledTimes(1);
		}
	});
});

describe("tags are unique to the conversation (C156)", () => {
	beforeEach(() => {
		getMock.mockReset();
	});
	it("two conversations holding the same message id read separate costs", async () => {
		getMock.mockImplementation(async (...args: string[]) => {
			const path = args[1];
			const tag = decodeURIComponent(path.split("tag=")[1]);
			return {
				tags: [{ tag, requests: 1, cost: tag.includes(CONV) ? "1.00" : "9.00", currency: "EUR" }],
			};
		});
		const mine = await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep });
		const theirs = await turnGatewayCost("tok", ID, {
			conversationId: OTHER,
			scopedTag: true,
			sleep: noSleep,
		});
		expect(mine).toMatchObject({ cost: "1.00" });
		expect(theirs).toMatchObject({ cost: "9.00" });
	});

	it("an unflagged (legacy) turn still shows its cost under the legacy tag", async () => {
		getMock.mockImplementation(async (...args: string[]) => {
			const path = args[1];
			const tag = decodeURIComponent(path.split("tag=")[1]);
			return tag === `turn:${ID}`
				? { tags: [{ tag, requests: 1, cost: "0.50", currency: "EUR" }] }
				: { tags: [] };
		});
		expect(await turnGatewayCost("tok", ID, { ...OLD, sleep: noSleep })).toMatchObject({
			status: "ok",
			cost: "0.50",
		});
	});

	it("never reads the legacy tag for a flagged message, even with no usage under the new tag", async () => {
		getMock.mockImplementation(async (...args: string[]) => {
			const path = args[1];
			const tag = decodeURIComponent(path.split("tag=")[1]);
			return tag === `turn:${ID}`
				? { tags: [{ tag, requests: 1, cost: "7.00", currency: "EUR" }] }
				: { tags: [] };
		});
		expect((await turnGatewayCost("tok", ID, { ...NEW, sleep: noSleep })).status).toBe("pending");
		expect(getMock.mock.calls.some(([, path]) => String(path).includes(`tag=turn%3A${ID}`))).toBe(
			false
		);
	});
});
