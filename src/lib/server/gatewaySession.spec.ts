import { describe, expect, it } from "vitest";
import { forgetGatewaySession, gatewaySessionCheck } from "./gatewaySession";

function fakeFetch(status: number, body: unknown = {}) {
	let calls = 0;
	const impl = (async () => {
		calls++;
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
	return { impl, calls: () => calls };
}

const base = { baseUrl: "http://gateway:8000/v1", userToken: true };

describe("gatewaySessionCheck", () => {
	it("reads admin and groups from /v1/me and caches them for a minute", async () => {
		const fetch = fakeFetch(200, { is_admin: true, groups: ["ops"] });
		let now = 1_000_000;
		const opts = { ...base, fetchImpl: fetch.impl, now: () => now };
		expect(await gatewaySessionCheck("s1", "tok", opts)).toEqual({
			valid: true,
			isAdmin: true,
			groups: ["ops"],
		});
		await gatewaySessionCheck("s1", "tok", opts);
		expect(fetch.calls()).toBe(1);
		now += 61_000;
		await gatewaySessionCheck("s1", "tok", opts);
		expect(fetch.calls()).toBe(2);
		forgetGatewaySession("s1");
	});

	it("says the session is over on a 401", async () => {
		const answer = await gatewaySessionCheck("s2", "tok", {
			...base,
			fetchImpl: fakeFetch(401).impl,
		});
		expect(answer).toEqual({ valid: false });
		forgetGatewaySession("s2");
	});

	it("fails open when the gateway is unreachable or erroring", async () => {
		const broken = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		expect(await gatewaySessionCheck("s3", "tok", { ...base, fetchImpl: broken })).toBeNull();
		expect(
			await gatewaySessionCheck("s4", "tok", { ...base, fetchImpl: fakeFetch(502).impl })
		).toBeNull();
	});

	it("asks nobody without a gateway, a user token or a token", async () => {
		const fetch = fakeFetch(200);
		expect(
			await gatewaySessionCheck("s5", "tok", {
				baseUrl: "",
				userToken: true,
				fetchImpl: fetch.impl,
			})
		).toBeNull();
		expect(
			await gatewaySessionCheck("s5", "tok", { ...base, userToken: false, fetchImpl: fetch.impl })
		).toBeNull();
		expect(await gatewaySessionCheck("s5", "", { ...base, fetchImpl: fetch.impl })).toBeNull();
		expect(fetch.calls()).toBe(0);
	});
});
