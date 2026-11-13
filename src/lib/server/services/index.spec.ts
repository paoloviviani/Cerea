import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	calls: 0,
	behaviour: {} as Record<string, () => Promise<unknown>>,
}));

vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock("./probes", async () => {
	const result = (name: string) => async () => {
		h.calls += 1;
		return h.behaviour[name] ? h.behaviour[name]() : { health: "ok", note: "gateway_ok" };
	};
	const names = [
		"probeGateway",
		"probeExtractor",
		"probeEmbedding",
		"probeRedaction",
		"probeDocuments",
		"probeOffice",
		"probeFetch",
		"probeSearch",
		"probeImage",
		"probeTranscription",
		"probeMcp",
		"probeBlobs",
		"probeGalopin",
		"probeSchedules",
		"probeMail",
		"probeBrowser",
		"probeLocal",
		"probeSandbox",
	];
	return {
		fetchCatalogue: async () => [],
		...Object.fromEntries(names.map((n) => [n, result(n)])),
	};
});

import { CACHE_MS, PROBE_DEADLINE_MS, resetServicesCache, servicesReport } from "./index";
import { SERVICE_IDS } from "./types";

beforeEach(() => {
	h.calls = 0;
	h.behaviour = {};
	resetServicesCache();
});
afterEach(() => vi.useRealTimers());

describe("services report", () => {
	it("has one row per service, in a fixed order, and strips the gateway's version", async () => {
		h.behaviour.probeGateway = async () => ({ health: "ok", note: "gateway_ok", version: "1.0.0" });
		const report = await servicesReport("t");
		expect(report.rows.map((r) => r.id)).toEqual([...SERVICE_IDS]);
		expect(report.rows[0]).toEqual({ id: "gateway", health: "ok", note: "gateway_ok" });
		expect(report.cached).toBe(false);
	});

	it("remembers for 30 seconds, and refresh runs again", async () => {
		const t0 = 1_000_000;
		await servicesReport("t", { now: t0 });
		const first = h.calls;
		const again = await servicesReport("t", { now: t0 + CACHE_MS - 1 });
		expect(h.calls).toBe(first);
		expect(again.cached).toBe(true);
		await servicesReport("t", { now: t0 + CACHE_MS + 1 });
		expect(h.calls).toBe(first * 2);
		await servicesReport("t", { refresh: true, now: t0 + CACHE_MS + 2 });
		expect(h.calls).toBe(first * 3);
	});

	it("joins a run already under way", async () => {
		const [a, b] = await Promise.all([servicesReport("t"), servicesReport("t", { refresh: true })]);
		expect(a).toBe(b);
	});

	it("a probe that throws becomes one red row, with no error text", async () => {
		h.behaviour.probeBlobs = async () => {
			throw new Error("secret-host.internal refused");
		};
		const report = await servicesReport("t");
		expect(report.rows.find((r) => r.id === "blobs")).toEqual({
			id: "blobs",
			health: "down",
			note: "probe_failed",
		});
		expect(JSON.stringify(report)).not.toContain("secret-host");
		expect(report.rows.filter((r) => r.health === "ok")).toHaveLength(SERVICE_IDS.length - 1);
	});

	it("a probe that hangs is cut off at its deadline", async () => {
		vi.useFakeTimers();
		h.behaviour.probeMail = () => new Promise(() => {});
		const pending = servicesReport("t");
		await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS + 1);
		const report = await pending;
		expect(report.rows.find((r) => r.id === "mail")).toEqual({
			id: "mail",
			health: "down",
			note: "timed_out",
		});
	});
});
