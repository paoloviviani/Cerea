import superjson from "superjson";
import { describe, expect, it, vi, beforeEach } from "vitest";

const usageMock = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/code/sessionUsage", () => ({ sessionGatewayUsage: usageMock }));
vi.mock("$lib/server/codeDevices", () => ({
	requireCodeAgents: vi.fn(async () => undefined),
	getPairedDevice: vi.fn(async () => ({ _id: { toString: () => "dev" } })),
}));

const { GET } = await import("./+server");

function call(id: string, query = "device=dev", token: string | undefined = "tok") {
	return GET({
		params: { id },
		locals: { token } as unknown as App.Locals,
		url: new URL(`http://x/api/v2/code/agents/${id}/usage?${query}`),
	} as unknown as Parameters<typeof GET>[0]);
}

describe("GET agents/:id/usage", () => {
	beforeEach(() => {
		usageMock.mockReset();
	});

	it("answers with the gateway's figures for the session", async () => {
		usageMock.mockResolvedValue({ currency: "EUR", session: { cost: "1" }, window: null });
		const res = await call("ses_1");
		expect(superjson.parse(await res.text())).toEqual({
			available: true,
			currency: "EUR",
			session: { cost: "1" },
			window: null,
		});
		expect(usageMock).toHaveBeenCalledWith("tok", "ses_1", undefined);
	});

	it("turns 'how long ago' into instants on this server's clock", async () => {
		usageMock.mockResolvedValue({ currency: "EUR", session: null, window: null });
		const before = Date.now();
		await call("ses_1", "device=dev&sinceAgoMs=60000&untilAgoMs=10000");
		const { since, until } = usageMock.mock.calls[0][2] as { since: Date; until: Date };
		expect(before - since.getTime()).toBeGreaterThanOrEqual(59_000);
		expect(before - since.getTime()).toBeLessThan(62_000);
		expect(since.getTime()).toBeLessThan(until.getTime());
	});

	it("is unavailable without an OIDC token or when the gateway has nothing", async () => {
		expect(superjson.parse(await (await call("ses_1", "device=dev", undefined)).text())).toEqual({
			available: false,
		});
		usageMock.mockResolvedValue(null);
		expect(superjson.parse(await (await call("ses_1")).text())).toEqual({ available: false });
	});

	it("refuses a bad id or duration", async () => {
		await expect(call("bad id!")).rejects.toMatchObject({ status: 400 });
		await expect(call("ses_1", "device=dev&sinceAgoMs=-5")).rejects.toMatchObject({
			status: 400,
		});
		await expect(call("ses_1", "device=dev&sinceAgoMs=abc")).rejects.toMatchObject({
			status: 400,
		});
	});
});
