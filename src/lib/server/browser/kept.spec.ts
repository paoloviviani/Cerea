import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { LENT_IDLE_MS, SCOPE_MAX_MS, memoryKeptStore } from "./kept";
import { scopeKey, scopeOrigin } from "./siteScope";

const user = new ObjectId();

describe("the site allowance's lifetime", () => {
	it("is per conversation and renewed by use, and lapses when idle", async () => {
		let t = 1_000_000;
		const store = memoryKeptStore(() => t);
		await store.scopeAdd("d1", user, "c1", "https://a.test|click:unclassified");
		expect(await store.scopeHas("d1", user, "c1", "https://a.test|click:unclassified")).toBe(true);
		expect(await store.scopeHas("d1", user, "c2", "https://a.test|click:unclassified")).toBe(false);
		expect(await store.scopeHas("d1", user, "c1", "https://b.test|click:unclassified")).toBe(false);
		// Used within the hour: still there, and the hour starts again.
		t += LENT_IDLE_MS - 1;
		expect(await store.scopeHas("d1", user, "c1", "https://a.test|click:unclassified")).toBe(true);
		t += LENT_IDLE_MS - 1;
		expect(await store.scopeHas("d1", user, "c1", "https://a.test|click:unclassified")).toBe(true);
		t += LENT_IDLE_MS + 1;
		expect(await store.scopeHas("d1", user, "c1", "https://a.test|click:unclassified")).toBe(false);
	});

	it("has a total cap however often it is used", async () => {
		let t = 0;
		const store = memoryKeptStore(() => t);
		await store.scopeAdd("d1", user, "c1", "k");
		while (t < SCOPE_MAX_MS) {
			t += LENT_IDLE_MS - 1;
			await store.scopeHas("d1", user, "c1", "k");
		}
		t += 1;
		expect(await store.scopeHas("d1", user, "c1", "k")).toBe(false);
	});
});

describe("which asks may be allowed for a site", () => {
	const commit = (reason: string) => ({ class: "commit" as const, reason: reason as never });
	const button = (name: string, hint?: string) => ({
		ref: "e1",
		role: "button",
		name,
		...(hint ? { hint } : {}),
	});
	const click = { type: "click" as const, ref: "e1" };
	it("offers a bare-symbol button, keyed on that control", () => {
		const plus = scopeKey(click, commit("unclassified"), button("+"));
		expect(plus).toMatch(/^click:unclassified:[0-9a-f]{16}$/);
		expect(scopeKey(click, commit("unclassified"), button("", "+"))).toBe(plus);
		expect(scopeKey(click, commit("unclassified"), button("⋯"))).not.toBe(plus);
	});
	it("never offers a button named in another script, or with no element", () => {
		expect(scopeKey(click, commit("unclassified"), button("Оплатить"))).toBeUndefined();
		expect(scopeKey(click, commit("unclassified"), button("購入する"))).toBeUndefined();
		expect(scopeKey(click, commit("unclassified"), button("+ Оплатить"))).toBeUndefined();
		expect(scopeKey(click, commit("unclassified"))).toBeUndefined();
	});
	it("keys a key press on its canonical chord, and offers no paste, Enter or non-chord", () => {
		const key = (k: string) => scopeKey({ type: "press", key: k }, commit("unknown-element"));
		expect(key("F5")).toBe("press:f5");
		expect(key("Alt+F4")).toBe("press:alt+f4");
		expect(key("Control+Alt+F4")).toBe(key("Alt+Control+F4"));
		expect(key("Ctrl+Alt+F4")).toBe(key("Control+Alt+F4"));
		expect(key("Control+v")).toBeUndefined();
		expect(key("Shift+Insert")).toBeUndefined();
		expect(key("Foo+F5")).toBeUndefined();
		expect(key("Control+Enter")).toBeUndefined();
		expect(key("Alt+Space")).toBeUndefined();
	});
	it("never offers a hard commit, Enter, or a read", () => {
		for (const reason of ["submit", "verb", "download", "new-domain", "user-tab", "bad-url"]) {
			expect(scopeKey(click, commit(reason), button("+")), reason).toBeUndefined();
		}
		expect(scopeKey({ type: "press", key: "Enter" }, commit("unknown-element"))).toBeUndefined();
		expect(scopeKey({ type: "press", key: " " }, commit("unknown-element"))).toBeUndefined();
		expect(scopeKey(click, { class: "read" }, button("+"))).toBeUndefined();
	});
	it("takes the origin of a web page only", () => {
		expect(scopeOrigin("https://a.test:8443/x?y=1")).toBe("https://a.test:8443");
		expect(scopeOrigin("about:blank")).toBeUndefined();
	});
});
