import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSentComposerDraft } from "./composerDraft";

const KEY = "cerea:composer-draft:code:d:a";

describe("clearSentComposerDraft", () => {
	const store = new Map<string, string>();
	const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	beforeEach(() => {
		store.clear();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => void store.set(k, v),
				removeItem: (k: string) => void store.delete(k),
			},
		});
	});
	afterEach(() => {
		if (original) Object.defineProperty(globalThis, "localStorage", original);
		else delete (globalThis as { localStorage?: unknown }).localStorage;
	});

	it("removes the draft when it is the sent text", () => {
		store.set(KEY, "hello");
		clearSentComposerDraft(KEY, "hello");
		expect(store.has(KEY)).toBe(false);
	});

	it("ignores surrounding whitespace on either side", () => {
		store.set(KEY, "hello ");
		clearSentComposerDraft(KEY, "  hello");
		expect(store.has(KEY)).toBe(false);
	});

	it("keeps newer text stored under the key", () => {
		store.set(KEY, "the next message");
		clearSentComposerDraft(KEY, "hello");
		expect(store.get(KEY)).toBe("the next message");
	});

	it("is a no-op when nothing is stored", () => {
		expect(() => clearSentComposerDraft(KEY, "hello")).not.toThrow();
		expect(store.size).toBe(0);
	});
});
