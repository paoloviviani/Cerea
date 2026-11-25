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

	it("refuses page commands while the user has taken over, and resumes after", async () => {
		const { control, call, out } = rig();
		await call("Target.setAutoAttach", { autoAttach: true, flatten: true });
		const sid = (
			out.find((m) => m.method === "Target.attachedToTarget")!.params as { sessionId: string }
		).sessionId;
		control.set("user");
		const refused = await call("Input.dispatchMouseEvent", {}, sid);
		expect((refused.error as { message: string }).message).toMatch(/taken over/);
		control.set("agent");
		expect((await call("Input.dispatchMouseEvent", {}, sid)).result).toBeTruthy();
	});

	it("creates pages through the host", async () => {
		const { host, call } = rig();
		const r = await call("Target.createTarget", { url: "about:blank" });
		expect((r.result as { targetId: string }).targetId).toBe("N1");
		expect(host.pages).toHaveLength(2);
	});
});
