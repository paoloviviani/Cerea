import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({
	messages: [] as unknown[],
	sizes: new Map<string, number>(),
	downloads: [] as string[],
	refuse: new Set<string>(),
}));

vi.mock("$lib/server/database", () => ({
	collections: {
		conversations: {
			findOne: vi.fn(async () => ({ createdAt: new Date(1000), messages: state.messages })),
		},
	},
}));
vi.mock("$lib/server/execution/fileVersions", () => ({ branchOf: vi.fn(async () => undefined) }));
vi.mock("$lib/server/files/downloadFile", () => ({
	storedSizes: vi.fn(async () => state.sizes),
	downloadFile: vi.fn(async (sha: string) => {
		state.downloads.push(sha);
		// Like the real one: a withheld stored entry is refused here too.
		if (state.refuse.has(sha)) throw new Error("withheld by the privacy rule");
		return { type: "base64", name: sha, value: Buffer.from(`bytes-of-${sha}`).toString("base64") };
	}),
}));

import { attachmentsToStage } from "./sandboxStage";

const id = new ObjectId();
const msg = (files: unknown[], at = 1000) => ({
	id: `m${at}`,
	from: "user",
	createdAt: new Date(at),
	files,
});
const file = (name: string, sha: string, extra: Record<string, unknown> = {}) => ({
	type: "hash",
	name,
	value: sha,
	mime: "text/csv",
	...extra,
});

beforeEach(() => {
	state.messages = [];
	state.sizes = new Map();
	state.downloads = [];
	state.refuse = new Set();
});

describe("attachmentsToStage", () => {
	it("plans the same names the browser mounts, with the extracted text beside the original", async () => {
		state.messages = [msg([file("data.csv", "h1", { extracted: { value: "t1" } })])];
		state.sizes = new Map([
			["h1", 10],
			["t1", 5],
		]);
		const staged = await attachmentsToStage(id);
		expect(staged.map((s) => s.name)).toEqual(["data.csv", "data.csv.md"]);
		expect(staged.map((s) => s.identity)).toEqual(["hash:h1", "hash:t1"]);
	});

	it("reads bytes only when a file is loaded", async () => {
		state.messages = [msg([file("a.csv", "h1")])];
		state.sizes = new Map([["h1", 3]]);
		const [staged] = await attachmentsToStage(id);
		expect(state.downloads).toEqual([]);
		expect(Buffer.from(await staged.load()).toString()).toBe("bytes-of-h1");
		expect(state.downloads).toEqual(["h1"]);
	});

	it("never stages a file a privacy rule withheld: not planned, and not readable", async () => {
		state.messages = [
			msg([
				file("secret.pdf", "h2", { withheld: { rule: "no-pdf" } }),
				file("ok.csv", "h1"),
				file("late.csv", "h3"),
			]),
		];
		state.sizes = new Map([
			["h1", 1],
			["h2", 1],
			["h3", 1],
		]);
		state.refuse.add("h3"); // withheld on the stored entry only
		const staged = await attachmentsToStage(id);
		expect(staged.map((s) => s.name)).toEqual(["ok.csv", "late.csv"]);
		expect(staged.some((s) => s.name === "secret.pdf")).toBe(false);
		await expect(staged[1].load()).rejects.toThrow(/withheld/);
	});

	it("leaves out a file with no stored size and one over the per-file cap", async () => {
		state.messages = [msg([file("a.csv", "h1"), file("huge.bin", "h2"), file("gone.csv", "h3")])];
		state.sizes = new Map([
			["h1", 1],
			["h2", 21 * 1024 * 1024],
		]);
		expect((await attachmentsToStage(id)).map((s) => s.name)).toEqual(["a.csv"]);
	});

	it("stops at the conversation's total", async () => {
		const mb = 1024 * 1024;
		state.messages = [msg(Array.from({ length: 7 }, (_, i) => file(`f${i}.bin`, `h${i}`)))];
		state.sizes = new Map(Array.from({ length: 7 }, (_, i) => [`h${i}`, 19 * mb] as const));
		// 100 MB total: five 19 MB files fit, the sixth would not.
		expect((await attachmentsToStage(id)).map((s) => s.name)).toEqual([
			"f0.bin",
			"f1.bin",
			"f2.bin",
			"f3.bin",
			"f4.bin",
		]);
	});

	it("is empty for a conversation with no attachments, and skips pasted text", async () => {
		expect(await attachmentsToStage(id)).toEqual([]);
		state.messages = [msg([file("note", "h1", { mime: "application/vnd.chatui.clipboard" })])];
		state.sizes = new Map([["h1", 1]]);
		expect(await attachmentsToStage(id)).toEqual([]);
	});

	it("names two different files of one name apart, and mounts the same bytes once", async () => {
		state.messages = [msg([file("a.csv", "h1"), file("a.csv", "h2"), file("b.csv", "h1")])];
		state.sizes = new Map([
			["h1", 1],
			["h2", 1],
		]);
		expect((await attachmentsToStage(id)).map((s) => s.name)).toEqual(["a.csv", "a (2).csv"]);
	});
});
