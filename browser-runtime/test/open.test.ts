import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { openResultSchema } from "../src/contract.ts";
import { rig, type Rig } from "./helpers.ts";

describe("open: a page of its own, no task", () => {
	let r: Rig;
	before(async () => {
		r = await rig();
	});
	after(() => r.close());

	const open = async (args: Record<string, unknown> = {}) => r.call("open", args);

	it("opens an address as a user's page and returns a token that resumes it", async () => {
		const res = await open({ url: `${r.fx.base}/form` });
		assert.equal(res.isError, undefined);
		const body = openResultSchema.parse(res.structuredContent);
		assert.equal(body.url, `${r.fx.base}/form`);
		assert.ok(body.token.length >= 20);
		// It is the user's, not the task's: a tab listed with mine false.
		const tab = (await r.tabs()).tabs.find((t) => t.id === body.id)!;
		assert.equal(tab.mine, false);
		const refused = await r.act([{ type: "use_tab", tab: tab.id }]);
		assert.equal(refused.results[0].refused, "approval_required");
		// The token resumes it with no grant, once.
		const resumed = (await r.call("resume", { token: body.token })).structuredContent as {
			url: string;
			changed: boolean;
		};
		assert.equal(resumed.url, `${r.fx.base}/form`);
		assert.equal(resumed.changed, false);
		assert.equal((await r.snapshot()).url, `${r.fx.base}/form`);
		assert.equal((await r.call("resume", { token: body.token })).isError, true);
		await r.session.endTask();
	});

	it("opens a blank page when no address is given", async () => {
		const body = openResultSchema.parse((await open()).structuredContent);
		assert.equal(body.url, "about:blank");
		assert.equal((await r.call("resume", { token: body.token })).isError, undefined);
		await r.session.endTask();
	});

	it("refuses schemes other than http(s) and about:blank", async () => {
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"data:text/html,x",
			"ftp://x/",
		]) {
			const res = await open({ url });
			assert.equal(res.isError, true, url);
		}
		assert.equal((await open({ url: "not a url" })).isError, true);
		assert.equal((await open({ url: "about:blank" })).isError, undefined);
	});

	it("refuses a denied site, before loading it", async () => {
		const before = (await r.tabs()).tabs.length;
		const res = await open({ url: `${r.fx.base}/form`, deny: ["127.0.0.1", "localhost"] });
		assert.equal(res.isError, true);
		assert.equal((await r.tabs()).tabs.length, before, "no page was left open");
	});

	it("refuses a redirect that lands on a denied site and closes the page", async () => {
		const before = (await r.tabs()).tabs.length;
		// 127.0.0.1 is allowed, but it redirects to localhost, which is denied.
		const res = await open({ url: `${r.fx.base}/to-other`, deny: ["localhost"] });
		assert.equal(res.isError, true);
		assert.equal((await r.tabs()).tabs.length, before);
	});

	it("reports an address that cannot be loaded and leaves nothing open", async () => {
		const before = (await r.tabs()).tabs.length;
		const res = await open({ url: "http://127.0.0.1:1/" });
		assert.equal(res.isError, true);
		assert.match(JSON.stringify(res.content), /Could not load/);
		assert.equal((await r.tabs()).tabs.length, before);
	});
});
