import { describe, expect, it } from "vitest";
import { homeUrl, isAtHome, homeButtonVisible } from "../src/shared/home.ts";

const addr = "https://cerea.example.org";

describe("the profile's home page in the panel", () => {
	it("appends /chat to the profile's address", () => {
		expect(homeUrl(addr)).toBe("https://cerea.example.org/chat");
	});
	it("is the address itself when it already carries the base path", () => {
		expect(homeUrl("https://cerea.example.org/chat")).toBe("https://cerea.example.org/chat");
	});
	it("strips a trailing slash before appending", () => {
		expect(homeUrl("https://cerea.example.org/")).toBe("https://cerea.example.org/chat");
		expect(homeUrl("https://cerea.example.org/chat/")).toBe("https://cerea.example.org/chat");
	});
	it("keeps a loopback address intact", () => {
		expect(homeUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/chat");
	});
	it("does not mistake a prefix for the chat path", () => {
		expect(homeUrl("https://cerea.example.org/chatty")).toBe(
			"https://cerea.example.org/chatty/chat"
		);
	});
});

describe("isAtHome", () => {
	it("matches the home page, ignoring its query, hash and trailing slash", () => {
		expect(isAtHome("https://cerea.example.org/chat", addr)).toBe(true);
		expect(isAtHome("https://cerea.example.org/chat?tab=1#bottom", addr)).toBe(true);
		expect(isAtHome("https://cerea.example.org/chat/", addr)).toBe(true);
	});
	it("is not fooled by other paths, other origins or bad URLs", () => {
		expect(isAtHome("https://cerea.example.org/chat/c/1", addr)).toBe(false);
		expect(isAtHome("https://cerea.example.org/", addr)).toBe(false);
		expect(isAtHome("https://other.example.org/chat", addr)).toBe(false);
		expect(isAtHome("", addr)).toBe(false);
		expect(isAtHome("not a url", addr)).toBe(false);
	});
	it("compares against the address that already carries the base path", () => {
		expect(isAtHome("https://cerea.example.org/chat", "https://cerea.example.org/chat")).toBe(true);
		expect(isAtHome("https://cerea.example.org/", "https://cerea.example.org/chat")).toBe(false);
	});
});

describe("homeButtonVisible", () => {
	it("shows when the panel is away from home and hides when it is there", () => {
		expect(homeButtonVisible("https://other.example.org/page", addr)).toBe(true);
		expect(homeButtonVisible("https://cerea.example.org/chat", addr)).toBe(false);
	});
	it("hides when the panel has no page, and when the profile has no home", () => {
		expect(homeButtonVisible(undefined, addr)).toBe(false);
		expect(homeButtonVisible("https://other.example.org/page", undefined)).toBe(false);
	});
});
