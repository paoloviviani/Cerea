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
	it("offers an unreadable button and an unknown key, not a paste", () => {
		expect(scopeKey({ type: "click", ref: "e1" }, commit("unclassified"))).toBe(
			"click:unclassified"
		);
		expect(scopeKey({ type: "press", key: "F5" }, commit("unknown-element"))).toBe("press:f5");
		expect(
			scopeKey({ type: "press", key: "Control+v" }, commit("unknown-element"))
		).toBeUndefined();
		expect(
			scopeKey({ type: "press", key: "Shift+Insert" }, commit("unknown-element"))
		).toBeUndefined();
	});
	it("never offers a hard commit, Enter, or a read", () => {
		for (const reason of ["submit", "verb", "download", "new-domain", "user-tab", "bad-url"]) {
			expect(scopeKey({ type: "click", ref: "e1" }, commit(reason)), reason).toBeUndefined();
		}
		expect(scopeKey({ type: "press", key: "Enter" }, commit("unknown-element"))).toBeUndefined();
		expect(scopeKey({ type: "press", key: " " }, commit("unknown-element"))).toBeUndefined();
		expect(scopeKey({ type: "click", ref: "e1" }, { class: "read" })).toBeUndefined();
	});
	it("takes the origin of a web page only", () => {
		expect(scopeOrigin("https://a.test:8443/x?y=1")).toBe("https://a.test:8443");
		expect(scopeOrigin("about:blank")).toBeUndefined();
	});
});
