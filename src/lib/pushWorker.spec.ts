import { describe, expect, it } from "vitest";
import {
	notificationOptions,
	parsePayload,
	pickClient,
	safeTarget,
	shouldShow,
} from "./pushWorker";

const payload = (over = {}) => ({
	v: 1 as const,
	title: "t",
	body: "b",
	url: "/chat/code",
	event: "permission",
	...over,
});

describe("parsePayload", () => {
	it("reads what the server sends and ignores unknown fields", () => {
		expect(
			parsePayload(JSON.stringify({ ...payload(), tag: "x", icon: "/i.png", extra: 1 }))
		).toEqual({ ...payload(), tag: "x", icon: "/i.png" });
	});
	it.each([
		null,
		"",
		"not json",
		"[]",
		"null",
		'{"v":2,"title":"t","url":"/"}',
		'{"v":1,"url":"/"}',
	])("refuses %s", (text) => expect(parsePayload(text)).toBeNull());
});

describe("shouldShow", () => {
	const looking = [{ visibilityState: "visible", focused: true }];
	const hidden = [{ visibilityState: "hidden", focused: false }];
	const visibleUnfocused = [{ visibilityState: "visible", focused: false }];

	it("shows with no window, a hidden window, or a visible but unfocused one", () => {
		expect(shouldShow(payload(), [])).toBe(true);
		expect(shouldShow(payload(), hidden)).toBe(true);
		expect(shouldShow(payload(), visibleUnfocused)).toBe(true);
	});
	it("skips while a window is visible and focused", () => {
		expect(shouldShow(payload(), looking)).toBe(false);
		expect(shouldShow(payload(), [...hidden, ...looking])).toBe(false);
	});
	it("always shows the test notification", () => {
		expect(shouldShow(payload({ event: "test" }), looking)).toBe(true);
	});
});

describe("notificationOptions", () => {
	it("carries the url in data, and renotifies a tagged replacement", () => {
		expect(notificationOptions(payload({ tag: "ask-1", icon: "/i.png" }))).toMatchObject({
			body: "b",
			icon: "/i.png",
			tag: "ask-1",
			renotify: true,
			data: { url: "/chat/code" },
		});
		expect(notificationOptions(payload())).not.toHaveProperty("tag");
	});
});

describe("safeTarget", () => {
	const origin = "https://chat.example.org";
	it("keeps a path inside the scope", () => {
		expect(safeTarget("/chat/code?x=1", origin, "/chat/")).toBe(`${origin}/chat/code?x=1`);
		expect(safeTarget("/chat", origin, "/chat/")).toBe(`${origin}/chat`);
	});
	it("falls back to the scope root for another origin, another path, or junk", () => {
		const root = `${origin}/chat/`;
		expect(safeTarget("https://evil.example/chat/", origin, "/chat/")).toBe(root);
		expect(safeTarget("//evil.example/chat/", origin, "/chat/")).toBe(root);
		expect(safeTarget("/other", origin, "/chat/")).toBe(root);
		expect(safeTarget("/chat/../admin", origin, "/chat/")).toBe(root);
		expect(safeTarget(undefined, origin, "/chat/")).toBe(root);
		expect(safeTarget("javascript:alert(1)", origin, "/chat/")).toBe(root);
	});
	it("works with no base path", () => {
		expect(safeTarget("/code", origin, "/")).toBe(`${origin}/code`);
	});
});

describe("pickClient", () => {
	it("prefers a focused window, then a visible one, then any", () => {
		const a = { url: "a", focused: false, visibilityState: "hidden" };
		const b = { url: "b", focused: false, visibilityState: "visible" };
		const c = { url: "c", focused: true, visibilityState: "visible" };
		expect(pickClient([a, b, c])).toBe(c);
		expect(pickClient([a, b])).toBe(b);
		expect(pickClient([a])).toBe(a);
		expect(pickClient([])).toBeUndefined();
	});
});
