import { describe, expect, it } from "vitest";
import {
	CdpBridge,
	type DownloadEvent,
	type Json,
	type PageTarget,
	type TargetHost,
	type Transport,
} from "../src/main/cdpBridge.ts";
import { Control } from "../src/main/control.ts";

class FakePage implements PageTarget {
	sent: { method: string; params: Json; child?: string }[] = [];
	cbs: ((m: string, p: Json, s?: string) => void)[] = [];
	attached = false;
	constructor(readonly id: string) {}
	async send(method: string, params: Json, child?: string) {
		this.sent.push({ method, params, child });
		return { echoed: method };
	}
	onEvent(cb: (m: string, p: Json, s?: string) => void) {
		this.cbs.push(cb);
		return () => {};
	}
	onDetach() {
		return () => {};
	}
	attach() {
		this.attached = true;
	}
	detach() {
		this.attached = false;
	}
	initialNavigate() {}
	url() {
		return "https://page.example/";
	}
	title() {
		return "Page";
	}
}

class FakeHost implements TargetHost {
	pages = [new FakePage("A")];
	created: ((t: PageTarget) => void)[] = [];
	targets() {
		return this.pages;
	}
	async create() {
		const p = new FakePage(`N${this.pages.length}`);
		this.pages.push(p);
		return p;
	}
	close(id: string) {
		this.pages = this.pages.filter((p) => p.id !== id);
	}
	activate() {}
	onTargetCreated(cb: (t: PageTarget) => void) {
		this.created.push(cb);
		return () => {};
	}
	onTargetDestroyed() {
		return () => {};
	}
	setDownloadDir() {}
	onDownload(_cb: (d: DownloadEvent) => void) {
		return () => {};
	}
	bounds() {
		return { left: 0, top: 0, width: 800, height: 600 };
	}
}

function rig() {
	const host = new FakeHost();
	const control = new Control();
	const bridge = new CdpBridge(host, control);
	const out: Json[] = [];
	let recv: (d: string) => void = () => {};
	const transport: Transport = {
		send: (d) => out.push(JSON.parse(d)),
		onMessage: (cb) => (recv = cb),
		onClose: () => {},
		close: () => {},
	};
	bridge.connect(transport);
	let id = 0;
	const call = async (method: string, params: Json = {}, sessionId?: string) => {
		const mine = ++id;
		recv(JSON.stringify({ id: mine, method, params, ...(sessionId ? { sessionId } : {}) }));
		for (let i = 0; i < 50; i++) {
			await new Promise((r) => setTimeout(r, 2));
			const r = out.find((m) => m.id === mine);
			if (r) return r;
		}
		throw new Error("no reply");
	};
	return { host, control, call, out };
}

describe("CDP bridge", () => {
	it("only attaches to the pages the host lists", async () => {
		const { call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const attached = out.filter((m) => m.method === "Target.attachedToTarget");
		expect(attached).toHaveLength(1);
		expect((attached[0].params as { targetInfo: { targetId: string } }).targetInfo.targetId).toBe(
			"A"
		);
	});

	it("forwards a page-level command to its page and refuses unknown sessions", async () => {
		const { host, call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		const ok = await call("Runtime.evaluate", { expression: "1" }, sid);
		expect(ok.result).toEqual({ echoed: "Runtime.evaluate" });
		expect(host.pages[0].sent.at(-1)!.method).toBe("Runtime.evaluate");
		const bad = await call("Runtime.evaluate", {}, "not-a-session");
		expect((bad.error as { message: string }).message).toMatch(/No session/);
	});

	it("has no way to make or drop browser contexts, nor to run browser-wide commands", async () => {
		const { call } = rig();
		for (const m of [
			"Target.createBrowserContext",
			"Target.disposeBrowserContext",
			"Browser.crash",
			"SystemInfo.getInfo",
			"Storage.getCookies",
			"Network.getAllCookies",
		]) {
			expect((await call(m)).error, m).toBeTruthy();
		}
	});

	it("cannot close a target the host does not list", async () => {
		const { call } = rig();
		const r = await call("Target.closeTarget", { targetId: "cerea-window" });
		expect((r.error as { message: string }).message).toMatch(/No target/);
	});

	it("has no session for the runtime while the user has taken over, and a fresh one after", async () => {
		const { control, call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		control.set("user");
		expect(
			((await call("Input.dispatchMouseEvent", {}, sid)).error as { message: string }).message
		).toMatch(/No session/);
		control.set("agent");
		const sid2 = (
			out.filter((m) => m.method === "Target.attachedToTarget").at(-1)!.params as {
				sessionId: string;
			}
		).sessionId;
		expect(sid2).not.toBe(sid);
		expect((await call("Input.dispatchMouseEvent", {}, sid2)).result).toBeTruthy();
	});

	it("creates pages through the host", async () => {
		const { host, call } = rig();
		const r = await call("Target.createTarget", { url: "about:blank" });
		expect((r.result as { targetId: string }).targetId).toBe("N1");
		expect(host.pages).toHaveLength(2);
	});

	it("refuses Target.* on a page session, so no other web contents can be listed or attached", async () => {
		const { call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		for (const [m, params] of [
			["Target.getTargets", {}],
			["Target.attachToTarget", { targetId: "ui", flatten: true }],
			["Target.setDiscoverTargets", { discover: true }],
			["Target.createTarget", { url: "about:blank" }],
			["Target.closeTarget", { targetId: "ui" }],
			["Browser.close", {}],
			["Storage.getCookies", {}],
			["SystemInfo.getInfo", {}],
			["IO.read", { handle: "x" }],
			["Tracing.start", {}],
			["Debugger.enable", {}],
			["DOM.setFileInputFiles", { files: ["/etc/passwd"] }],
		] as const) {
			const r = await call(m, params as never, sid);
			expect((r.error as { message: string } | undefined)?.message, m).toMatch(/not available/);
		}
		// what a page does need still passes
		for (const m of [
			"Page.enable",
			"Runtime.evaluate",
			"Input.dispatchMouseEvent",
			"Fetch.enable",
			"Target.setAutoAttach",
		]) {
			expect((await call(m, {}, sid)).result, m).toBeTruthy();
		}
	});

	it("registers a child session only for a frame or worker of a panel page", async () => {
		const { host, call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		const page = host.pages[0];
		const emit = (params: Json, child?: string) =>
			page.cbs.forEach((cb) => cb("Target.attachedToTarget", params, child));
		// a page-type target attached under this page (what Target.attachToTarget would have made) is dropped and detached
		emit({ sessionId: "evil", targetInfo: { type: "page", targetId: "ui" } });
		expect(
			out.some((m) => (m.params as { sessionId?: string } | undefined)?.sessionId === "evil")
		).toBe(false);
		expect(
			page.sent.some(
				(x) =>
					x.method === "Target.detachFromTarget" &&
					(x.params as { sessionId: string }).sessionId === "evil"
			)
		).toBe(true);
		expect(
			(await call("Runtime.evaluate", { expression: "window.cerea" }, "evil")).error
		).toBeTruthy();
		// an iframe is registered, and commands on it are filtered like the page's
		emit({ sessionId: "frame1", targetInfo: { type: "iframe", targetId: "f" } });
		expect(
			out.some((m) => (m.params as { sessionId?: string } | undefined)?.sessionId === "frame1")
		).toBe(true);
		expect((await call("Runtime.enable", {}, "frame1")).result).toBeTruthy();
		expect(page.sent.at(-1)!.child).toBe("frame1");
		expect(
			((await call("Target.getTargets", {}, "frame1")).error as { message: string }).message
		).toMatch(/not available/);
		// a page's Target.* events other than attach and detach never reach the runtime
		page.cbs.forEach((cb) => cb("Target.targetCreated", { targetInfo: { targetId: "ui" } }));
		expect(out.some((m) => m.method === "Target.targetCreated")).toBe(false);
	});

	it("opens only web pages: navigation and createTarget are checked", async () => {
		const { call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		for (const url of [
			"file:///etc/hostname",
			"javascript:1",
			"chrome://gpu",
			"data:text/html,x",
		]) {
			expect(
				((await call("Page.navigate", { url }, sid)).error as { message: string }).message,
				url
			).toMatch(/Only web pages/);
			expect(
				((await call("Target.createTarget", { url })).error as { message: string }).message,
				url
			).toMatch(/Only web pages/);
		}
		expect((await call("Page.navigate", { url: "https://a.example/" }, sid)).result).toBeTruthy();
	});

	it("cuts the runtime off while the user drives, and attaches again on hand-back", async () => {
		const { host, control, call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		const page = host.pages[0];
		control.set("user");
		expect(
			out.some(
				(m) =>
					m.method === "Target.detachedFromTarget" &&
					(m.params as { sessionId: string }).sessionId === sid
			)
		).toBe(true);
		expect(page.attached).toBe(false);
		// events of what the user does are not forwarded, and a new tab is not attached
		const before = out.length;
		page.cbs.forEach((cb) =>
			cb("Network.requestWillBeSent", { request: { url: "https://private.example/" } })
		);
		const fresh = await host.create();
		host.created.forEach((cb) => cb(fresh));
		expect(out.length).toBe(before);
		expect(fresh.attached).toBe(false);
		expect(
			((await call("Runtime.evaluate", {}, sid)).error as { message: string }).message
		).toMatch(/No session/);
		control.set("agent");
		const attached = out.filter((m) => m.method === "Target.attachedToTarget");
		expect(attached.length).toBe(3); // the first one, and both tabs again
		expect(page.attached).toBe(true);
	});
});
