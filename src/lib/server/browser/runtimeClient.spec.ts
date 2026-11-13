import { describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError, type BrowserAction } from "./contract";
import { FakeBrowserRuntime, TINY_PNG_BASE64, type FakePage } from "./fakeRuntime";
import { McpBrowserRuntime, type RuntimeCall } from "./runtimeClient";
import { actionDigest } from "./classifier";
import { FAKE_BROWSER_KEY } from "./fakeRuntime";
import { makeGrant } from "./grants";

const pages: FakePage[] = [
	{
		id: "home",
		url: "https://shop.example.com/",
		title: "Shop",
		elements: [
			{ ref: "e1", role: "textbox", name: "Search" },
			{ ref: "e2", role: "button", name: "Search", submits: true },
			{ ref: "e3", role: "button", name: "Pay €120" },
			{
				ref: "e4",
				role: "link",
				name: "invoice.pdf",
				download: true,
				onClick: { download: { name: "invoice.pdf", mime: "application/pdf", content: "%PDF-1" } },
			},
		],
		extract: { tables: [{ headers: ["Item", "Total"], rows: [["Shoe", "120"]] }], lists: [] },
	},
];

function runtime() {
	const fake = new FakeBrowserRuntime(pages);
	return { fake, client: new McpBrowserRuntime(fake.asRuntimeCall()) };
}

describe("McpBrowserRuntime over the wire", () => {
	it("reads a snapshot and a diff", async () => {
		const { client } = runtime();
		const snap = await client.snapshot();
		expect(snap.url).toBe("https://shop.example.com/");
		expect(snap.elements.map((e) => e.ref)).toEqual(["e1", "e2", "e3", "e4"]);
		expect(snap.text).toContain('[e2] button "Search"');
		const diff = await client.diff();
		expect(diff.text).toBe("(no change)");
		expect(diff.navigated).toBe(false);
	});

	it("sends actions and returns per-action results", async () => {
		const { client, fake } = runtime();
		await client.snapshot();
		const actions: BrowserAction[] = [{ type: "fill", ref: "e1", text: "shoes" }];
		const result = await client.act(actions, undefined);
		expect(result.results).toEqual([{ ok: true, outcome: "typed 5 characters" }]);
		expect(fake.calls.at(-1)?.args).toEqual({ actions });
		expect((await client.diff()).changed.map((e) => e.ref)).toEqual(["e1"]);
	});

	it("passes approval grants, and the runtime refuses a commit without a matching one", async () => {
		const { client } = runtime();
		const snap = await client.snapshot();
		const action: BrowserAction = { type: "click", ref: "e3" };
		const refused = await client.act([action], undefined);
		expect(refused.results[0]).toMatchObject({ ok: false, refused: "approval_required" });

		const wrong = await client.act(
			[action],
			[makeGrant(FAKE_BROWSER_KEY, { index: 0, id: "x", digest: "0".repeat(32) })]
		);
		expect(wrong.results[0]).toMatchObject({ ok: false, refused: "approval_mismatch" });

		const digest = actionDigest(action, {
			element: snap.elements.find((e) => e.ref === "e3"),
			currentUrl: snap.url,
		});
		const done = await client.act(
			[action],
			[makeGrant(FAKE_BROWSER_KEY, { index: 0, id: "approval-1", digest })]
		);
		expect(done.results[0]).toMatchObject({ ok: true });
	});

	it("refuses an expired grant, and one with a bad signature", async () => {
		const { client } = runtime();
		const snap = await client.snapshot();
		const action: BrowserAction = { type: "click", ref: "e3" };
		const digest = actionDigest(action, {
			element: snap.elements.find((e) => e.ref === "e3"),
			currentUrl: snap.url,
		});
		const expired = makeGrant(
			FAKE_BROWSER_KEY,
			{ index: 0, id: "a", digest },
			Date.now() - 11 * 60_000
		);
		expect((await client.act([action], [expired])).results[0]).toMatchObject({
			refused: "approval_expired",
		});
		const forged = { ...makeGrant(FAKE_BROWSER_KEY, { index: 0, id: "a", digest }), id: "b" };
		expect((await client.act([action], [forged])).results[0]).toMatchObject({
			refused: "approval_mismatch",
		});
	});

	it("refuses a non-web address in navigate", async () => {
		const { client } = runtime();
		const result = await client.act([{ type: "navigate", url: "javascript:alert(1)" }], undefined);
		expect(result.results[0]).toMatchObject({ ok: false, refused: "scheme_refused" });
	});

	it("extracts structured data", async () => {
		const { client, fake } = runtime();
		expect(await client.extract({ ref: "e1", mode: "tables" })).toEqual({
			tables: [{ headers: ["Item", "Total"], rows: [["Shoe", "120"]] }],
			lists: [],
		});
		expect(fake.calls.at(-1)).toEqual({ tool: "extract", args: { ref: "e1", mode: "tables" } });
	});

	it("reads a screenshot from an MCP image block", async () => {
		const { client } = runtime();
		expect(await client.screenshot("e3")).toEqual({ mime: "image/png", base64: TINY_PNG_BASE64 });
	});

	it("ends the task, and pings the channel when asked to keep it alive", async () => {
		const { fake } = runtime();
		const ping = vi.fn(async () => {});
		const client = new McpBrowserRuntime(fake.asRuntimeCall(), ping);
		expect(await client.endTask()).toEqual({ closed: true });
		expect(fake.calls.at(-1)).toEqual({ tool: "end_task", args: {} });
		await client.keepAlive();
		expect(ping).toHaveBeenCalledTimes(1);
		// With no pinger it is a no-op, not an error.
		await new McpBrowserRuntime(fake.asRuntimeCall()).keepAlive();
	});

	it("lists tabs, keeps the last page on end_task and resumes it, over the wire", async () => {
		const { client, fake } = runtime();
		expect((await client.tabs()).tabs.length).toBeGreaterThan(0);
		const ended = await client.endTask({ keep: true });
		expect(fake.calls.at(-1)).toEqual({ tool: "end_task", args: { keep: true } });
		expect(ended.closed).toBe(false);
		const token = ended.kept?.token ?? "";
		expect(token).not.toBe("");
		expect(await client.resume(token)).toMatchObject({ changed: false });
		await expect(client.resume("gone")).rejects.toBeInstanceOf(BrowserRuntimeError);
	});

	it("accepts a table with no ref", async () => {
		const call: RuntimeCall = async () => ({
			text: JSON.stringify({ tables: [{ headers: ["A"], rows: [["1"]] }] }),
			isError: false,
		});
		const result = await new McpBrowserRuntime(call).extract({});
		expect(result.tables[0].ref).toBeUndefined();
		expect(result.lists).toEqual([]);
	});

	it("collects downloads", async () => {
		const { client } = runtime();
		const snap = await client.snapshot();
		const action: BrowserAction = { type: "click", ref: "e4" };
		const digest = actionDigest(action, {
			element: snap.elements.find((e) => e.ref === "e4"),
			currentUrl: snap.url,
		});
		const acted = await client.act(
			[action],
			[makeGrant(FAKE_BROWSER_KEY, { index: 0, id: "a", digest })]
		);
		// Each file says which action made it and the grant that action ran under.
		expect(acted.downloads).toEqual([
			{ name: "invoice.pdf", mime: "application/pdf", actionIndex: 0, grantId: "a" },
		]);
		const { files } = await client.download();
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({
			name: "invoice.pdf",
			mime: "application/pdf",
			size: 6,
			actionIndex: 0,
			grantId: "a",
		});
		expect(Buffer.from(files[0].base64 ?? "", "base64").toString()).toBe("%PDF-1");
		expect((await client.download()).files).toEqual([]);
	});

	it("prefers structured content over text", async () => {
		const call: RuntimeCall = vi.fn(async () => ({
			text: "not json",
			isError: false,
			structured: { url: "https://a.test/", title: "A", text: "x", elements: [] },
		}));
		const snap = await new McpBrowserRuntime(call).snapshot();
		expect(snap.title).toBe("A");
	});
});

describe("McpBrowserRuntime failures", () => {
	it("names a tool error the runtime reported", async () => {
		const call: RuntimeCall = async () => ({ text: "page crashed", isError: true });
		await expect(new McpBrowserRuntime(call).snapshot()).rejects.toMatchObject({
			kind: "tool",
			message: expect.stringContaining("page crashed"),
		});
	});

	it("rejects an answer that is not JSON, or not the contract's shape", async () => {
		const notJson: RuntimeCall = async () => ({ text: "hello", isError: false });
		await expect(new McpBrowserRuntime(notJson).snapshot()).rejects.toMatchObject({
			kind: "protocol",
		});
		const wrongShape: RuntimeCall = async () => ({
			text: JSON.stringify({ url: 1 }),
			isError: false,
		});
		await expect(new McpBrowserRuntime(wrongShape).diff()).rejects.toMatchObject({
			kind: "protocol",
		});
	});

	it("reports an unreachable machine as unavailable", async () => {
		const call: RuntimeCall = async () => {
			throw new Error("channel closed");
		};
		const err = await new McpBrowserRuntime(call).snapshot().catch((e) => e);
		expect(err).toBeInstanceOf(BrowserRuntimeError);
		expect(err.kind).toBe("unavailable");
		expect(err.message).toContain("channel closed");
	});

	it("lets an abort through untouched", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		const call: RuntimeCall = async () => {
			throw new Error("aborted");
		};
		const err = await new McpBrowserRuntime(call).snapshot(controller.signal).catch((e) => e);
		expect(err).not.toBeInstanceOf(BrowserRuntimeError);
	});

	it("does not trust a screenshot that is neither an image block nor the contract's JSON", async () => {
		const call: RuntimeCall = async () => ({ text: "<html>", isError: false });
		await expect(new McpBrowserRuntime(call).screenshot()).rejects.toBeInstanceOf(
			BrowserRuntimeError
		);
	});

	it("rejects a malformed approval or action before the runtime sees it", async () => {
		const { fake } = runtime();
		const call = fake.asRuntimeCall();
		const res = await call("act", { actions: [{ type: "hack" }] });
		expect(res.isError).toBe(true);
	});

	it("opens a page, and sends an empty deny list to open and tabs so the runtime clears an old one", async () => {
		const { client, fake } = runtime();
		const opened = await client.open({ url: "https://shop.example.com/", deny: [] });
		expect(opened).toMatchObject({ url: "https://shop.example.com/" });
		expect(opened.token.length).toBeGreaterThan(0);
		await client.tabs({ deny: [] });
		await client.tabs();
		expect(fake.calls.map((c) => [c.tool, c.args])).toEqual([
			["open", { url: "https://shop.example.com/", deny: [] }],
			["tabs", { deny: [] }],
			["tabs", {}],
		]);
		await expect(client.open({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
			BrowserRuntimeError
		);
	});
});
