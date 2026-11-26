import McpAppFrame from "./McpAppFrame.svelte";
import McpAppFrameTestHost from "./McpAppFrameTestHost.svelte";
import { render } from "vitest-browser-svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTheme } from "$lib/switchTheme";
import type { McpAppSnapshot } from "$lib/utils/mcpApp";

/**
 * The host side of an MCP App (docs/dev/adr-mcp-apps.md): the iframe's sandbox, the CSP in its
 * document, and the official bridge answering a page that speaks the protocol. The "page" here is a
 * few lines of inline script that does what an app's SDK does (`ui/initialize`, then `initialized`) and
 * relays everything the host sends back to this window, where the tests read it.
 */

const PAGE = `<!doctype html><html><body><script>
const send = (m) => parent.postMessage(m, "*");
window.addEventListener("message", (e) => {
	const d = e.data;
	if (d && d.__cmd) return send(d.__cmd);
	if (d && d.__nav) { location.href = "data:text/html,<p>elsewhere</p>"; return; }
	parent.postMessage({ __probe: d }, "*");
	if (d && d.id === 1 && d.result) send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
});
send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
	appInfo: { name: "test-page", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
</script></body></html>`;

const app: McpAppSnapshot = {
	connector: "connector:abc",
	server: "Maps",
	tool: "show_map",
	uri: "ui://maps/view",
	sha256: "a".repeat(64),
	size: PAGE.length,
	csp: {
		connectDomains: ["https://api.example.com", "https://evil.example.com; script-src *"],
		resourceDomains: ["https://cdn.example.com"],
	},
};

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111";
const toolResult = { content: [{ type: "text", text: "3 results" }], structuredContent: { n: 3 } };

let probes: Array<Record<string, unknown>> = [];
const onWindowMessage = (event: MessageEvent) => {
	const data = event.data as { __probe?: Record<string, unknown> } | null;
	if (data && typeof data === "object" && "__probe" in data && data.__probe)
		probes.push(data.__probe);
};

function stubFetch(handler?: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({
				url,
				...(typeof init?.body === "string"
					? { body: JSON.parse(init.body) as Record<string, unknown> }
					: {}),
			});
			if (handler) return handler(url, init);
			return new Response(PAGE, { status: 200 });
		})
	);
	return calls;
}

const settle = async (check: () => boolean, ms = 4000) => {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > ms)
			throw new Error(
				"timed out waiting for the page: " + String(document.body.textContent).slice(0, 600)
			);
		await new Promise((r) => setTimeout(r, 20));
	}
};

/** A request the page makes to the host, as the SDK's `App` would send it. */
function pageSends(iframe: HTMLIFrameElement, message: Record<string, unknown>) {
	iframe.contentWindow?.postMessage({ __cmd: message }, "*");
}

const props = {
	app,
	conversationId: "c1",
	toolInput: { query: "pizza", limit: 3 },
	toolResult,
	pageUrl: "/stored-page",
};

async function mounted(sink?: (text: string, from: string) => boolean) {
	const view = sink ? render(McpAppFrameTestHost, { ...props, sink }) : render(McpAppFrame, props);
	await settle(() => view.baseElement.querySelector("iframe")?.getAttribute("srcdoc") != null);
	const iframe = view.baseElement.querySelector("iframe") as HTMLIFrameElement;
	await settle(() => probes.some((p) => p.id === 1 && "result" in p));
	return { view, iframe };
}

describe("McpAppFrame", () => {
	beforeEach(() => {
		probes = [];
		window.addEventListener("message", onWindowMessage);
	});
	afterEach(() => {
		window.removeEventListener("message", onWindowMessage);
		vi.unstubAllGlobals();
		setTheme("light");
	});

	it("renders the page in a sandbox with an opaque origin, never allow-same-origin", async () => {
		stubFetch();
		const { iframe } = await mounted();

		const sandbox = iframe.getAttribute("sandbox") ?? "";
		expect(sandbox.split(/\s+/)).toEqual(["allow-scripts"]);
		// Nothing delegated to the page either (no clipboard, camera, fullscreen).
		expect(iframe.hasAttribute("allow")).toBe(false);
		expect(sandbox).not.toContain("allow-same-origin");
		expect(sandbox).not.toContain("allow-popups");
		expect(sandbox).not.toContain("allow-top-navigation");
		expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
	});

	it("puts the CSP built from the declared domains first in the page's document", async () => {
		stubFetch();
		const { iframe } = await mounted();

		const srcdoc = iframe.getAttribute("srcdoc") ?? "";
		expect(
			srcdoc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')
		).toBe(true);
		expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(srcdoc.indexOf("<script>"));
		expect(srcdoc).toContain("connect-src https://api.example.com;");
		expect(srcdoc).toContain("script-src 'unsafe-inline' https://cdn.example.com;");
		// The injected value never reached a header.
		expect(srcdoc).not.toContain("evil.example.com");
	});

	it("answers the page's handshake and then sends the tool input and result", async () => {
		stubFetch();
		await mounted();
		await settle(() => probes.some((p) => p.method === "ui/notifications/tool-result"));

		const methods = probes.map((p) => p.method).filter(Boolean);
		expect(methods.indexOf("ui/notifications/tool-input")).toBeLessThan(
			methods.indexOf("ui/notifications/tool-result")
		);
		const input = probes.find((p) => p.method === "ui/notifications/tool-input") as {
			params: { arguments: unknown };
		};
		expect(input.params.arguments).toEqual({ query: "pizza", limit: 3 });
		const result = probes.find((p) => p.method === "ui/notifications/tool-result") as {
			params: { content: unknown[] };
		};
		expect(result.params.content).toEqual(toolResult.content);
		const init = probes.find((p) => p.id === 1) as {
			result: { hostContext: { theme: string; availableDisplayModes: string[] } };
		};
		expect(init.result.hostContext.theme).toBe("light");
		expect(init.result.hostContext.availableDisplayModes).toEqual(["inline", "fullscreen"]);
	});

	it("tells the page when the theme changes", async () => {
		stubFetch();
		await mounted();
		await settle(() => probes.some((p) => p.method === "ui/notifications/tool-result"));

		setTheme("dark");
		await settle(() => probes.some((p) => p.method === "ui/notifications/host-context-changed"));

		const change = probes.find((p) => p.method === "ui/notifications/host-context-changed") as {
			params: { theme: string };
		};
		expect(change.params.theme).toBe("dark");
	});

	it("follows the page's size, within limits", async () => {
		stubFetch();
		const { iframe } = await mounted();

		pageSends(iframe, {
			jsonrpc: "2.0",
			method: "ui/notifications/size-changed",
			params: { width: 300, height: 400 },
		});
		await settle(() => iframe.style.height === "400px");

		pageSends(iframe, {
			jsonrpc: "2.0",
			method: "ui/notifications/size-changed",
			params: { width: 300, height: 99999 },
		});
		await settle(() => iframe.style.height === "720px");
	});

	describe("full screen", () => {
		const request = (iframe: HTMLIFrameElement, id: number, mode: string) =>
			pageSends(iframe, {
				jsonrpc: "2.0",
				id,
				method: "ui/request-display-mode",
				params: { mode },
			});
		const modeAnswer = (id: number) =>
			(probes.find((p) => p.id === id)?.result as { mode?: string } | undefined)?.mode;

		it("goes full screen on the page's request only after the user's own input, and back", async () => {
			stubFetch();
			const { view, iframe } = await mounted();
			const card = view.baseElement.querySelector("[data-testid='mcp-app']") as HTMLElement;

			// No input on the card: refused, and the answer says the mode it is still in.
			request(iframe, 7, "fullscreen");
			await settle(() => modeAnswer(7) !== undefined);
			expect(modeAnswer(7)).toBe("inline");
			expect(card.className).not.toContain("fixed");

			// The user pressed on the card a moment ago: allowed.
			card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			request(iframe, 8, "fullscreen");
			await settle(() => modeAnswer(8) === "fullscreen");
			await settle(() => card.className.includes("fixed"));

			// Leaving with the close button is the user's own: the page cannot come straight back.
			(
				view.baseElement.querySelector("button[aria-label='Close full screen']") as HTMLElement
			).click();
			await settle(() => !card.className.includes("fixed"));
			card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			request(iframe, 9, "fullscreen");
			await settle(() => modeAnswer(9) !== undefined);
			expect(modeAnswer(9)).toBe("inline");
			expect(card.className).not.toContain("fixed");

			// The card's own expand button always works.
			(view.baseElement.querySelector("button[aria-label='Full screen']") as HTMLElement).click();
			await settle(() => card.className.includes("fixed"));
		});

		it("gives the window to one card at a time and keeps the lock right through the hand-over", async () => {
			stubFetch();
			document.body.style.overflow = "scroll";
			try {
				const a = render(McpAppFrame, props);
				const b = render(McpAppFrame, props);
				const cardOf = (v: { baseElement: HTMLElement; container: HTMLElement }) =>
					v.container.querySelector("[data-testid='mcp-app']") as HTMLElement;
				const expand = (v: { container: HTMLElement }) =>
					v.container.querySelector("button[aria-label='Full screen']") as HTMLElement;
				const locked = () =>
					document.documentElement.hasAttribute("data-app-fullscreen") &&
					document.body.style.overflow === "hidden";

				expand(a).click();
				await settle(() => cardOf(a).className.includes("fixed"));
				expect(locked()).toBe(true);

				expand(b).click();
				await settle(() => cardOf(b).className.includes("fixed"));
				await settle(() => !cardOf(a).className.includes("fixed"));
				expect(locked()).toBe(true);

				(
					b.container.querySelector("button[aria-label='Close full screen']") as HTMLElement
				).click();
				await settle(() => !cardOf(b).className.includes("fixed"));
				await settle(() => !document.documentElement.hasAttribute("data-app-fullscreen"));
				expect(document.body.style.overflow).toBe("scroll");
			} finally {
				document.body.style.overflow = "";
			}
		});

		it("keeps Tab inside the layer: the header and the frame, round and round", async () => {
			stubFetch();
			const { view, iframe } = await mounted();
			(view.baseElement.querySelector("button[aria-label='Full screen']") as HTMLElement).click();
			const close = await vi.waitFor(() => {
				const el = view.baseElement.querySelector("button[aria-label='Close full screen']");
				if (!el) throw new Error("not open");
				return el as HTMLElement;
			});
			await settle(() => document.activeElement === close);
			const traps = view.baseElement.querySelectorAll<HTMLElement>("[data-testid='mcp-app-trap']");
			expect(traps).toHaveLength(2);
			// Tabbing on from the frame lands on the end sentinel, which hands the focus to the header...
			traps[1].focus();
			expect(document.activeElement).toBe(close);
			// ... and Shift+Tab back from the header lands on the start sentinel, which hands it to the frame.
			traps[0].focus();
			expect(document.activeElement).toBe(iframe);
			expect(view.baseElement.querySelector("[role='dialog'][aria-modal='true']")).not.toBeNull();
		});
	});

	it("asks the user before a page's tool call runs, and says it is the page asking", async () => {
		let attempts = 0;
		const calls = stubFetch((url) => {
			if (!url.endsWith("/mcp-app/call")) return new Response(PAGE, { status: 200 });
			attempts += 1;
			return attempts === 1
				? new Response(
						JSON.stringify({
							ok: false,
							code: "approval_required",
							message: "approval",
							approval: { id: APPROVAL_ID },
						}),
						{ status: 409 }
					)
				: new Response(
						JSON.stringify({ ok: true, result: { content: [{ type: "text", text: "done" }] } }),
						{ status: 200 }
					);
		});
		const { view, iframe } = await mounted();

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 9,
			method: "tools/call",
			params: { name: "refresh", arguments: { id: 1 } },
		});
		await settle(() => view.baseElement.querySelector("[data-testid='mcp-app-approval']") !== null);

		const card = view.baseElement.querySelector("[data-testid='mcp-app-approval']") as HTMLElement;
		expect(card.textContent).toContain("The view from Maps wants to call refresh.");
		// Nothing ran yet: the one call so far was refused for want of approval.
		expect(calls.filter((c) => c.url.endsWith("/mcp-app/call"))).toHaveLength(1);
		expect(calls.find((c) => c.url.endsWith("/mcp-app/call"))?.body).toMatchObject({
			connector: "connector:abc",
			tool: "refresh",
		});

		const allow = Array.from(card.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Allow once")
		) as HTMLButtonElement;
		// Anti-clickjacking: a click in the first moments does nothing.
		expect(allow.disabled).toBe(true);
		allow.click();
		await new Promise((r) => setTimeout(r, 50));
		expect(calls.filter((c) => c.url.endsWith("/mcp-app/call"))).toHaveLength(1);
		await settle(() => !allow.disabled);
		allow.click();
		await settle(() => probes.some((p) => p.id === 9 && "result" in p));

		const retried = calls.filter((c) => c.url.endsWith("/mcp-app/call"))[1];
		expect(retried.body).toMatchObject({
			approval: { id: APPROVAL_ID, choice: "once" },
			tool: "refresh",
		});
	});

	it("gives the page an error when the user denies the call", async () => {
		const calls = stubFetch((url) =>
			url.endsWith("/mcp-app/call")
				? new Response(
						JSON.stringify({
							ok: false,
							code: "approval_required",
							approval: { id: APPROVAL_ID },
						}),
						{ status: 409 }
					)
				: new Response(PAGE, { status: 200 })
		);
		const { view, iframe } = await mounted();

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "delete_all", arguments: {} },
		});
		await settle(() => view.baseElement.querySelector("[data-testid='mcp-app-approval']") !== null);
		(
			Array.from(view.baseElement.querySelectorAll("button")).find(
				(b) => b.textContent?.trim() === "Deny"
			) as HTMLElement
		).click();
		await settle(() => probes.some((p) => p.id === 11 && "result" in p));

		const answer = probes.find((p) => p.id === 11) as { result: { isError?: boolean } };
		expect(answer.result.isError).toBe(true);
		// The denial is told to the server too, so its one waiting slot is freed.
		await settle(() => calls.filter((c) => c.url.endsWith("/mcp-app/call")).length === 2);
		expect(calls.filter((c) => c.url.endsWith("/mcp-app/call"))[1].body).toMatchObject({
			approval: { id: APPROVAL_ID, choice: "deny" },
		});
	});

	it("queues calls that need approval: one card at a time, each in its turn, and refuses past three waiting", async () => {
		stubFetch((url, init) =>
			url.endsWith("/mcp-app/call")
				? // A denial is answered as the server answers it; only the first ask needs approval.
					JSON.parse(String(init?.body)).approval
					? new Response(JSON.stringify({ ok: false, code: "denied", message: "denied" }), {
							status: 403,
						})
					: new Response(
							JSON.stringify({
								ok: false,
								code: "approval_required",
								approval: { id: APPROVAL_ID },
							}),
							{ status: 409 }
						)
				: new Response(PAGE, { status: 200 })
		);
		const { view, iframe } = await mounted();
		const card = () => view.baseElement.querySelector("[data-testid='mcp-app-approval']");
		const call = (id: number, name: string) =>
			pageSends(iframe, {
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name, arguments: {} },
			});

		call(20, "a");
		await settle(() => card() !== null);
		call(21, "b");
		call(22, "c");
		await settle(() => (card()?.textContent ?? "").includes("+2"));
		// A fourth call, with three already waiting, is refused at once.
		call(23, "d");
		await settle(() => probes.some((p) => p.id === 23 && "result" in p));
		expect(
			(probes.find((p) => p.id === 23) as { result: { isError?: boolean } }).result.isError
		).toBe(true);
		expect(view.baseElement.querySelectorAll("[data-testid='mcp-app-approval']")).toHaveLength(1);
		expect(card()?.textContent).toContain("a");

		// Denying the first brings up the next, and its call was not failed in the meantime.
		const deny = () =>
			[...(card()?.querySelectorAll("button") ?? [])].find((b) =>
				/deny/i.test(b.textContent ?? "")
			) as HTMLButtonElement;
		deny().click();
		await settle(() => (card()?.textContent ?? "").includes("+1"));
		expect(probes.some((p) => p.id === 21 && "result" in p)).toBe(false);
		deny().click();
		await settle(() => card() !== null && !(card()?.textContent ?? "").includes("+"));
	});

	it("starts a card far below the screen only when it comes near, and keeps it running after", async () => {
		const calls = stubFetch();
		const spacer = document.createElement("div");
		spacer.style.height = "6000px";
		// Before the component's own container in the body, so the card renders far below the screen.
		document.body.prepend(spacer);
		try {
			const view = render(McpAppFrame, props);
			await new Promise((r) => setTimeout(r, 300));
			// Far from the screen: no fetch of the page, no iframe, only the card.
			expect(calls.filter((c) => c.url === "/stored-page")).toHaveLength(0);
			expect(view.baseElement.querySelector("iframe")).toBeNull();
			expect(view.baseElement.querySelector("[data-testid='mcp-app']")).not.toBeNull();

			view.container.scrollIntoView();
			await settle(() => view.baseElement.querySelector("iframe") !== null);
			expect(calls.filter((c) => c.url === "/stored-page")).toHaveLength(1);
			const iframe = view.baseElement.querySelector("iframe");

			// Scrolled away again: still the same frame, not started over (that would reload the page).
			window.scrollTo(0, 0);
			await new Promise((r) => setTimeout(r, 300));
			expect(view.baseElement.querySelector("iframe")).toBe(iframe);
			expect(calls.filter((c) => c.url === "/stored-page")).toHaveLength(1);
		} finally {
			spacer.remove();
		}
	});

	it("does not give the page its document until the card is laid out, and then tells it the size", async () => {
		const calls = stubFetch();
		const view = render(McpAppFrame, props);
		// Hidden before the first layout, as a folded row is.
		view.container.style.display = "none";
		await new Promise((r) => setTimeout(r, 400));
		expect(calls.filter((c) => c.url === "/stored-page")).toHaveLength(0);
		expect(view.baseElement.querySelector("iframe")).toBeNull();
		expect(probes).toHaveLength(0);

		view.container.style.display = "";
		await settle(() => probes.some((p) => p.method === "ui/notifications/tool-result"));
		const init = probes.find((p) => p.id === 1) as {
			result: { hostContext: { containerDimensions?: { width?: number } } };
		};
		expect(init.result.hostContext.containerDimensions?.width).toBeGreaterThan(0);
		const iframe = view.baseElement.querySelector("iframe");
		expect(iframe?.clientWidth).toBeGreaterThan(0);
	});

	it("keeps a started card alive when it is hidden and shown again: no new fetch, frame or data", async () => {
		const calls = stubFetch();
		const { view, iframe } = await mounted();
		await settle(() => probes.some((p) => p.method === "ui/notifications/tool-result"));
		const sent = () => probes.filter((p) => p.method === "ui/notifications/tool-input").length;
		const before = sent();

		view.container.style.display = "none";
		await new Promise((r) => setTimeout(r, 400));
		view.container.style.display = "";
		await new Promise((r) => setTimeout(r, 600));

		expect(view.baseElement.querySelector("iframe")).toBe(iframe);
		expect(calls.filter((c) => c.url === "/stored-page")).toHaveLength(1);
		expect(sent()).toBe(before);
		expect(view.baseElement.querySelector("[data-testid='mcp-app-closed']")).toBeNull();
		// Still talking: the page answers a request after the round trip.
		pageSends(iframe, { jsonrpc: "2.0", id: 40, method: "ping" });
		await settle(() => probes.some((p) => p.id === 40 && "result" in p));
	});

	describe("diagnostics", () => {
		const diag = (iframe: HTMLIFrameElement, kind: string, message: string, source = "") =>
			pageSends(iframe, { cereaDiag: { kind, message, source, line: 3 } });
		const link = (view: { baseElement: HTMLElement }) =>
			[...view.baseElement.querySelectorAll("button")].find((b) =>
				/show details/i.test(b.textContent ?? "")
			);

		it("does not show the link for a healthy page's ResizeObserver noise, in either spelling", async () => {
			stubFetch();
			const { view, iframe } = await mounted();
			diag(iframe, "error", "ResizeObserver loop completed with undelivered notifications.");
			diag(iframe, "error", "ResizeObserver loop limit exceeded");
			await new Promise((r) => setTimeout(r, 400));
			expect(link(view)).toBeUndefined();
		});

		it("shows the link for a real error only, and keeps warnings inside the opened panel", async () => {
			stubFetch();
			const { view, iframe } = await mounted();
			pageSends(iframe, {
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "warning", data: "slow layer" },
			});
			await new Promise((r) => setTimeout(r, 400));
			expect(link(view)).toBeUndefined();

			diag(iframe, "error", "boom");
			await settle(() => link(view) !== undefined);
			link(view)?.click();
			await settle(
				() => view.baseElement.querySelector("[data-testid='mcp-app-details']") !== null
			);
			const text = view.baseElement.querySelector("[data-testid='mcp-app-details']")?.textContent;
			expect(text).toContain("boom");
			expect(text).toContain("slow layer");
		});

		it("ignores a diagnostics message from any window but the card's own frame", async () => {
			stubFetch();
			const { view } = await mounted();
			window.postMessage(
				{ cereaDiag: { kind: "error", message: "forged", source: "", line: 1 } },
				"*"
			);
			await new Promise((r) => setTimeout(r, 400));
			expect(link(view)).toBeUndefined();
		});

		it("tells the server the kind and source of a failure, never its text", async () => {
			const calls = stubFetch();
			const { iframe } = await mounted();
			diag(
				iframe,
				"csp",
				"connect-src blocked https://x.example/p?secret=1",
				"https://x.example/a.js?q=2"
			);
			await settle(() => calls.some((c) => c.url.endsWith("/mcp-app/diag")), 6000);
			const body = calls.find((c) => c.url.endsWith("/mcp-app/diag"))?.body as {
				connector: string;
				uri: string;
				errors: Array<Record<string, unknown>>;
			};
			expect(body.connector).toBe(app.connector);
			expect(body.uri).toBe(app.uri);
			expect(body.errors).toEqual([{ kind: "csp", source: "https://x.example/a.js?q=2" }]);
			expect(JSON.stringify(body)).not.toContain("secret");
		});

		it("does not report the page's own logs to the server", async () => {
			const calls = stubFetch();
			const { iframe } = await mounted();
			pageSends(iframe, {
				jsonrpc: "2.0",
				method: "notifications/message",
				params: { level: "error", data: "private text" },
			});
			await new Promise((r) => setTimeout(r, 2200));
			expect(calls.some((c) => c.url.endsWith("/mcp-app/diag"))).toBe(false);
		});
	});

	it("tells the page its new width when the card is resized", async () => {
		stubFetch();
		const { view } = await mounted();
		await settle(() => probes.some((p) => p.method === "ui/notifications/tool-result"));
		const before = view.container.clientWidth;
		view.container.style.width = `${Math.max(200, before - 120)}px`;
		await settle(() =>
			probes.some(
				(p) =>
					p.method === "ui/notifications/host-context-changed" &&
					typeof (p.params as { containerDimensions?: { width?: number } })?.containerDimensions
						?.width === "number"
			)
		);
	});

	it("closes the page and its bridge when the page navigates itself away", async () => {
		stubFetch();
		const { view, iframe } = await mounted();

		// The page's own handler navigates it (to a data: document, as a link or a script would).
		iframe.contentWindow?.postMessage({ __nav: true }, "*");
		await settle(() => view.baseElement.querySelector("[data-testid='mcp-app-closed']") !== null);

		expect(view.baseElement.querySelector("iframe")).toBeNull();
		expect(view.baseElement.textContent).toContain("closed");
	});

	it("puts a page's message in front of the user as a suggestion and never writes it anywhere", async () => {
		stubFetch();
		const drafts: Array<[string, string]> = [];
		const { view, iframe } = await mounted((text, from) => {
			drafts.push([text, from]);
			return true;
		});

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 12,
			method: "ui/message",
			params: {
				role: "user",
				content: [{ type: "text", text: "  Tell me more about the 2nd pin  " }],
			},
		});
		await settle(() => probes.some((p) => p.id === 12 && "result" in p));

		expect(drafts).toEqual([["Tell me more about the 2nd pin", "Maps"]]);
		expect(view.baseElement.querySelector("[data-testid='mcp-app-note']")?.textContent).toContain(
			"above your message box"
		);
	});

	it("refuses a message when the chat declines the suggestion (one per ten seconds)", async () => {
		stubFetch();
		const { iframe } = await mounted(() => false);

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 30,
			method: "ui/message",
			params: { role: "user", content: [{ type: "text", text: "again" }] },
		});
		await settle(() => probes.some((p) => p.id === 30 && "result" in p));

		expect(
			(probes.find((p) => p.id === 30) as { result: { isError?: boolean } }).result.isError
		).toBe(true);
	});

	it("refuses a link that is not http(s), and asks before opening one that is", async () => {
		stubFetch();
		const { view, iframe } = await mounted();

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 13,
			method: "ui/open-link",
			params: { url: "javascript:alert(1)" },
		});
		await settle(() => probes.some((p) => p.id === 13 && "result" in p));
		expect(
			(probes.find((p) => p.id === 13) as { result: { isError?: boolean } }).result.isError
		).toBe(true);

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 14,
			method: "ui/open-link",
			params: { url: "https://example.org/docs" },
		});
		await settle(() => document.body.textContent?.includes("example.org") ?? false);
		// Nothing is answered until the user decides.
		expect(probes.some((p) => p.id === 14)).toBe(false);
		(document.querySelector("button[aria-label='Close']") as HTMLElement | null)?.click();
		void view;
	});

	it("renders nothing when the stored page cannot be read", async () => {
		stubFetch(() => new Response("gone", { status: 404 }));
		const view = render(McpAppFrame, props);
		await new Promise((r) => setTimeout(r, 200));

		expect(view.baseElement.querySelector("iframe")).toBeNull();
		expect(view.baseElement.querySelector("[data-testid='mcp-app']")).toBeNull();
	});

	it("refuses a request that has no handler, such as reading a resource", async () => {
		stubFetch();
		const { iframe } = await mounted();

		pageSends(iframe, {
			jsonrpc: "2.0",
			id: 15,
			method: "resources/read",
			params: { uri: "ui://anything" },
		});
		await settle(() => probes.some((p) => p.id === 15));

		expect(probes.find((p) => p.id === 15)).toHaveProperty("error");
	});
});
