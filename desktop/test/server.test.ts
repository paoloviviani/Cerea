import { describe, expect, it } from "vitest";
import { normalizeAddress, probeServer, ServerError } from "../src/main/server.ts";

const facts = {
	issuer: "https://idp.example.org",
	clientId: "opencode-enrollment",
	gateway: "https://llm.example.org",
};

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
	return async (url: string) => {
		const r = routes[url];
		return {
			status: r ? (r.status ?? 200) : 404,
			headers: { get: () => null },
			text: async () => JSON.stringify(r?.body ?? {}),
		};
	};
}

describe("server address", () => {
	it("is https only, except for this computer", () => {
		expect(normalizeAddress("cerea.example.org")).toBe("https://cerea.example.org");
		expect(normalizeAddress("https://cerea.example.org/chat/")).toBe(
			"https://cerea.example.org/chat"
		);
		expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
		expect(normalizeAddress("http://127.0.0.1:3000/chat")).toBe("http://127.0.0.1:3000/chat");
		expect(() => normalizeAddress("http://cerea.example.org")).toThrow(ServerError);
		expect(() => normalizeAddress("ftp://cerea.example.org")).toThrow(ServerError);
		expect(() => normalizeAddress("https://user:pw@cerea.example.org")).toThrow(ServerError);
		expect(() => normalizeAddress("  ")).toThrow(ServerError);
	});

	it("drops a query and a fragment", () => {
		expect(normalizeAddress("https://c.example/chat?x=1#y")).toBe("https://c.example/chat");
	});
});

describe("probeServer", () => {
	const base = "https://cerea.example.org/chat";
	it("accepts a Cerea, with its name and a same-origin icon", async () => {
		const info = await probeServer(
			base,
			fakeFetch({
				[`${base}/galopin/enroll.json`]: { body: facts },
				[`${base}/manifest.webmanifest`]: {
					body: { name: "Acme Cerea", icons: [{ src: "/chat/icon.png" }] },
				},
			})
		);
		expect(info).toEqual({
			address: base,
			origin: "https://cerea.example.org",
			name: "Acme Cerea",
			icon: "https://cerea.example.org/chat/icon.png",
		});
	});

	it("never shows an icon from another origin, and falls back to the host name", async () => {
		const info = await probeServer(
			base,
			fakeFetch({
				[`${base}/galopin/enroll.json`]: { body: facts },
				[`${base}/manifest.webmanifest`]: {
					body: { name: "X", icons: [{ src: "https://tracker.example/i.png" }] },
				},
			})
		);
		expect(info.icon).toBeUndefined();
		const bare = await probeServer(
			base,
			fakeFetch({ [`${base}/galopin/enroll.json`]: { body: facts } })
		);
		expect(bare.name).toBe("cerea.example.org");
	});

	it("refuses a site that is not a Cerea", async () => {
		await expect(probeServer(base, fakeFetch({}))).rejects.toThrow(/did not answer like a Cerea/);
		await expect(
			probeServer(base, fakeFetch({ [`${base}/galopin/enroll.json`]: { body: { hello: 1 } } }))
		).rejects.toThrow(/not a Cerea/);
		await expect(
			probeServer(base, fakeFetch({ [`${base}/galopin/enroll.json`]: { status: 302 } }))
		).rejects.toThrow(/did not answer/);
	});
});
