import { describe, expect, it } from "vitest";
import { reconcileById } from "./reconcileById";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe("reconcileById", () => {
	it("returns the very same array when nothing changed", () => {
		const prev = [row("a", { n: { x: 1 } }), row("b")];
		const next = [row("a", { n: { x: 1 } }), row("b")];
		expect(reconcileById(prev, next)).toBe(prev);
	});

	it("keeps the old object for an unchanged row and takes the new one for a changed row", () => {
		const prev = [row("a"), row("b", { title: "old" })];
		const next = [row("a"), row("b", { title: "new" })];
		const out = reconcileById(prev, next);
		expect(out).not.toBe(prev);
		expect(out[0]).toBe(prev[0]);
		expect(out[1]).toBe(next[1]);
	});

	it("sees a change nested inside a row", () => {
		const prev = [row("a", { meta: { tags: ["x", { deep: 1 }] } })];
		const next = [row("a", { meta: { tags: ["x", { deep: 2 }] } })];
		expect(reconcileById(prev, next)[0]).toBe(next[0]);
	});

	it("follows the fresh order, reusing the old objects", () => {
		const prev = [row("a"), row("b"), row("c")];
		const next = [row("c"), row("a"), row("b")];
		const out = reconcileById(prev, next);
		expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
		expect(out[0]).toBe(prev[2]);
		expect(out[1]).toBe(prev[0]);
		expect(out[2]).toBe(prev[1]);
	});

	it("drops a removed row and adds a new one", () => {
		const prev = [row("a"), row("b")];
		const next = [row("b"), row("z")];
		const out = reconcileById(prev, next);
		expect(out.map((r) => r.id)).toEqual(["b", "z"]);
		expect(out[0]).toBe(prev[1]);
		expect(out[1]).toBe(next[1]);
	});

	it("handles an empty list on either side", () => {
		const prev = [row("a")];
		expect(reconcileById(prev, [])).toEqual([]);
		const empty: { id: string }[] = [];
		expect(reconcileById(empty, [])).toBe(empty);
	});
});
