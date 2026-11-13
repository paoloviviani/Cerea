import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ version: null as string | null }));
vi.mock("$lib/utils/appVersion", () => ({ APP_VERSION: "0.51.2" }));
vi.mock("./probes", () => ({
	probeGateway: async () => ({ health: "ok", note: "gateway_ok", version: h.version }),
}));

import { checkForUpdates, isNewer, parseVersion } from "./updates";

let fetchMock: ReturnType<typeof vi.fn>;
const release = (tag: string, url?: string) =>
	new Response(
		JSON.stringify({ tag_name: tag, html_url: url ?? `https://github.com/x/y/releases/tag/${tag}` })
	);

beforeEach(() => {
	h.version = null;
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

describe("version comparison", () => {
	it("parses with or without v, and compares numerically", () => {
		expect(parseVersion("v0.52.0")).toEqual([0, 52, 0]);
		expect(parseVersion("nope")).toBeNull();
		expect(isNewer("0.52.0", "0.51.2")).toBe(true);
		expect(isNewer("0.10.0", "0.9.9")).toBe(true);
		expect(isNewer("0.51.2", "0.51.2")).toBe(false);
		expect(isNewer("0.51.1", "0.51.2")).toBe(false);
		expect(isNewer("junk", "0.51.2")).toBe(false);
	});
});

describe("check for updates", () => {
	const byRepo = (answers: Record<string, () => Response | Promise<Response>>) =>
		fetchMock.mockImplementation(async (url: string) => {
			const repo = Object.keys(answers).find((r) => String(url).includes(r));
			return answers[repo as string]();
		});

	it("reports a newer release with its page, and the same version as up to date", async () => {
		h.version = "0.33.2";
		byRepo({
			"paoloviviani/Cerea/": () =>
				release("v0.52.0", "https://github.com/paoloviviani/Cerea/releases/tag/v0.52.0"),
			"paoloviviani/Pystino/": () => release("v0.33.2"),
		});
		const report = await checkForUpdates("t");
		expect(report.cerea).toEqual({
			running: "0.51.2",
			state: "available",
			latest: "0.52.0",
			url: "https://github.com/paoloviviani/Cerea/releases/tag/v0.52.0",
		});
		expect(report.pystino).toMatchObject({ running: "0.33.2", state: "current", latest: "0.33.2" });
	});

	it("sends only a plain GET with a generic User-Agent, and nothing about the deployment", async () => {
		byRepo({
			"paoloviviani/Cerea/": () => release("v0.51.2"),
			"paoloviviani/Pystino/": () => release("v0.33.2"),
		});
		await checkForUpdates("secret-token");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchMock.mock.calls) {
			expect(String(url)).toMatch(
				/^https:\/\/api\.github\.com\/repos\/paoloviviani\/(Cerea|Pystino)\/releases\/latest$/
			);
			expect(init.method).toBeUndefined();
			expect(init.body).toBeUndefined();
			expect(JSON.stringify(init.headers)).not.toContain("secret-token");
			expect(init.headers["user-agent"]).toBe("cerea-update-check");
			expect(init.headers.authorization).toBeUndefined();
		}
	});

	it("an unknown Pystino version still shows the latest, as unknown", async () => {
		byRepo({
			"paoloviviani/Cerea/": () => release("v0.51.2"),
			"paoloviviani/Pystino/": () => release("v0.34.0"),
		});
		const report = await checkForUpdates("t");
		expect(report.pystino).toMatchObject({ running: null, state: "unknown", latest: "0.34.0" });
	});

	it("offline is an answer, not an error", async () => {
		fetchMock.mockRejectedValue(new TypeError("fetch failed"));
		const report = await checkForUpdates("t");
		expect(report.cerea.state).toBe("offline");
		expect(report.pystino.state).toBe("offline");
	});

	it("rate limited (403 or 429) and other failures are told apart", async () => {
		byRepo({
			"paoloviviani/Cerea/": () => new Response("{}", { status: 403 }),
			"paoloviviani/Pystino/": () => new Response("{}", { status: 429 }),
		});
		let report = await checkForUpdates("t");
		expect([report.cerea.state, report.pystino.state]).toEqual(["rate_limited", "rate_limited"]);
		byRepo({
			"paoloviviani/Cerea/": () => new Response("{}", { status: 500 }),
			"paoloviviani/Pystino/": () => new Response("not json"),
		});
		report = await checkForUpdates("t");
		expect([report.cerea.state, report.pystino.state]).toEqual(["unknown", "unknown"]);
	});

	it("rejects lookalike hosts, other repos and non-https links", async () => {
		for (const bad of [
			"https://github.com.evil.example/paoloviviani/Cerea/releases/tag/v9.0.0",
			"https://evil.example/https://github.com/paoloviviani/Cerea/releases/",
			"https://github.com/someone/else/releases/tag/v9.0.0",
			"http://github.com/paoloviviani/Cerea/releases/tag/v9.0.0",
			"not a url",
		]) {
			byRepo({
				"paoloviviani/Cerea/": () => release("v9.0.0", bad),
				"paoloviviani/Pystino/": () => release("v0.33.2"),
			});
			expect((await checkForUpdates("t")).cerea.url).toBe(
				"https://github.com/paoloviviani/Cerea/releases/tag/v9.0.0"
			);
		}
	});

	it("never links outside the project's own release pages", async () => {
		byRepo({
			"paoloviviani/Cerea/": () => release("v9.0.0", "https://evil.example/x"),
			"paoloviviani/Pystino/": () => release("v0.33.2"),
		});
		const report = await checkForUpdates("t");
		expect(report.cerea.url).toBe("https://github.com/paoloviviani/Cerea/releases/tag/v9.0.0");
	});
});
