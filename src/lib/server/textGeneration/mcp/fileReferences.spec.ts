import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/execution/fileVersions", () => ({ branchOf: vi.fn(async () => undefined) }));
vi.mock("../builtinTools/conversationFiles", () => ({ findConversationFile: vi.fn() }));

const {
	resolveFileReferences,
	hasFileRefs,
	withFileRefNotes,
	MAX_FILE_REF_BYTES,
	MAX_FILE_REF_TOTAL_BYTES,
} = await import("./fileReferences");

const mine = new ObjectId();
const theirs = new ObjectId();

type Stored = { owner: ObjectId; bytes: Buffer };
function lookupOf(files: Record<string, Stored>, withheld: string[] = []) {
	return vi.fn(async (conversationId: ObjectId, name: string, _options?: { source?: string }) => {
		if (withheld.includes(name)) {
			return {
				ok: false as const,
				error:
					"This file was withheld by the privacy rule 'no-health'. Its content must not be read, extracted or processed by any means.",
			};
		}
		const file = files[name];
		// Mirrors findConversationFile: only the asking conversation's store is searched.
		if (!file || !file.owner.equals(conversationId)) {
			return { ok: false as const, error: `No file named "${name}" in this conversation.` };
		}
		return {
			ok: true as const,
			name,
			bytes: file.bytes,
			sha256: "x",
			origin: "output" as const,
			tool: "sandbox",
			version: 1,
			versionCount: 1,
			currentVersion: 1,
		};
	});
}

const svg = "<svg>é€</svg>";
const files = {
	"diagram.svg": { owner: mine, bytes: Buffer.from(svg, "utf8") },
	"logo.png": { owner: mine, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]) },
	"secret.txt": { owner: theirs, bytes: Buffer.from("not yours") },
	"health.txt": { owner: mine, bytes: Buffer.from("diagnosis") },
};
const ctx = { conversationId: mine, messageId: "m1" };

describe("resolveFileReferences", () => {
	it("swaps a text reference for the file's UTF-8 content", async () => {
		const r = await resolveFileReferences(
			{ path: "a.svg", content: { $file: "diagram.svg" } },
			ctx,
			lookupOf(files)
		);
		expect(r).toMatchObject({ ok: true, args: { path: "a.svg", content: svg }, resolved: 1 });
	});

	it("swaps a base64 reference for the file's bytes as base64", async () => {
		const r = await resolveFileReferences(
			{ content: { $file: "logo.png", encoding: "base64" } },
			ctx,
			lookupOf(files)
		);
		expect(r).toMatchObject({
			ok: true,
			args: { content: files["logo.png"].bytes.toString("base64") },
			resolved: 1,
		});
	});

	it("resolves references nested in objects and arrays, and does not mutate the input", async () => {
		const input = {
			files: [
				{ path: "a", content: { $file: "diagram.svg" } },
				{ path: "b", content: "plain" },
			],
			meta: { deep: { logo: { $file: "logo.png", encoding: "base64" } } },
		};
		const before = JSON.stringify(input);
		const r = await resolveFileReferences(input, ctx, lookupOf(files));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.resolved).toBe(2);
		expect(r.args).toEqual({
			files: [
				{ path: "a", content: svg },
				{ path: "b", content: "plain" },
			],
			meta: { deep: { logo: files["logo.png"].bytes.toString("base64") } },
		});
		// The call as the model made it (what the card and the stored message keep) is unchanged.
		expect(JSON.stringify(input)).toBe(before);
	});

	it("never rewrites a plain string, even one that looks like a reference or a file name", async () => {
		const lookup = lookupOf(files);
		const args = {
			a: "diagram.svg",
			b: "file:diagram.svg",
			c: 'Use {"$file": "diagram.svg"} where a string goes, or "$file" alone',
			d: { file: "diagram.svg" },
			e: '{"not": "a reference"}',
			f: '{"$file": broken json',
		};
		const r = await resolveFileReferences(args, ctx, lookup);
		expect(r).toEqual({ ok: true, args, resolved: 0, notes: [] });
		expect(lookup).not.toHaveBeenCalled();
		expect(hasFileRefs(args)).toBe(false);
		expect(hasFileRefs({ x: [{ $file: "a" }] })).toBe(true);
	});

	it("answers an unknown file with an error and no content", async () => {
		const r = await resolveFileReferences({ c: { $file: "nope.svg" } }, ctx, lookupOf(files));
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.error).toContain('"nope.svg"');
	});

	it("does not resolve another conversation's file", async () => {
		const r = await resolveFileReferences({ c: { $file: "secret.txt" } }, ctx, lookupOf(files));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("No file named");
			expect(r.error).not.toContain("not yours");
		}
	});

	it("does not resolve a file a privacy rule withheld", async () => {
		const r = await resolveFileReferences(
			{ c: { $file: "health.txt" } },
			ctx,
			lookupOf(files, ["health.txt"])
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("withheld by the privacy rule 'no-health'");
			expect(r.error).not.toContain("diagnosis");
		}
	});

	it("refuses a file over the size limit and a call whose references add up to too much", async () => {
		const big = { owner: mine, bytes: Buffer.alloc(MAX_FILE_REF_BYTES + 1, 97) };
		const one = await resolveFileReferences({ c: { $file: "big" } }, ctx, lookupOf({ big }));
		expect(one.ok).toBe(false);
		if (!one.ok) expect(one.error).toContain("over the 8.0 MB limit");

		const mid = { owner: mine, bytes: Buffer.alloc(MAX_FILE_REF_BYTES, 97) };
		expect(MAX_FILE_REF_TOTAL_BYTES).toBeLessThan(3 * MAX_FILE_REF_BYTES);
		const many = await resolveFileReferences(
			{ a: { $file: "m1" }, b: { $file: "m2" }, c: { $file: "m3" } },
			ctx,
			lookupOf({ m1: mid, m2: mid, m3: mid })
		);
		expect(many.ok).toBe(false);
		if (!many.ok) expect(many.error).toContain("add up to more than");
	});

	it("tells the model to use base64 for a binary file read as text", async () => {
		const r = await resolveFileReferences({ c: { $file: "logo.png" } }, ctx, lookupOf(files));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('"encoding": "base64"');
	});

	it("rejects a malformed reference", async () => {
		const lookup = lookupOf(files);
		for (const bad of [
			{ $file: 3 },
			{ $file: "diagram.svg", encoding: "hex" },
			{ $file: "diagram.svg", extra: 1 },
			{ $file: "  " },
		]) {
			const r = await resolveFileReferences({ c: bad }, ctx, lookup);
			expect(r.ok).toBe(false);
		}
		expect(lookup).not.toHaveBeenCalled();
	});

	it("needs a conversation", async () => {
		const r = await resolveFileReferences(
			{ c: { $file: "diagram.svg" } },
			undefined,
			lookupOf(files)
		);
		expect(r.ok).toBe(false);
	});
	describe("source selection", () => {
		it("asks the lookup for the version each form means", async () => {
			const lookup = lookupOf(files);
			const sourceOf = async (ref: Record<string, unknown>) => {
				lookup.mockClear();
				const r = await resolveFileReferences({ c: ref }, ctx, lookup);
				expect(r.ok).toBe(true);
				return lookup.mock.calls[0][2].source;
			};
			expect(await sourceOf({ $file: "/mnt/data/diagram.svg" })).toBe("mounted");
			expect(await sourceOf({ $file: "diagram.svg" })).toBe("mounted");
			expect(await sourceOf({ $file: "/mnt/data/diagram.svg", original: true })).toBe("attachment");
			expect(await sourceOf({ $file: "/mnt/output/diagram.svg" })).toBe("output");
			// The name sent is without the root.
			expect(lookup.mock.calls[0][1]).toBe("diagram.svg");
		});

		it("refuses `original` under /mnt/output and a non-boolean `original`", async () => {
			const lookup = lookupOf(files);
			for (const bad of [
				{ $file: "/mnt/output/diagram.svg", original: true },
				{ $file: "/mnt/data/diagram.svg", original: "yes" },
			]) {
				const r = await resolveFileReferences({ c: bad }, ctx, lookup);
				expect(r.ok).toBe(false);
			}
			expect(lookup).not.toHaveBeenCalled();
		});

		it("refuses paths outside the two roots and `..`", async () => {
			const lookup = lookupOf(files);
			for (const bad of [
				"/etc/passwd",
				"/mnt/other/a.svg",
				"/mnt/data/../output/a.svg",
				"../a.svg",
				"/mnt/data/",
				"/mnt/output/x/../../a.svg",
			]) {
				const r = await resolveFileReferences({ c: { $file: bad } }, ctx, lookup);
				expect(r.ok, bad).toBe(false);
			}
			expect(lookup).not.toHaveBeenCalled();
		});
	});

	describe("stringified references", () => {
		it("refuses a string that is a JSON reference, anywhere in the arguments", async () => {
			const lookup = lookupOf(files);
			for (const text of [
				'{"$file": "/mnt/data/cerea-architecture.svg"}',
				'  {"$file": "diagram.svg", "encoding": "base64"}\n',
			]) {
				const r = await resolveFileReferences(
					{ files: [{ path: "a.svg", content: text }] },
					ctx,
					lookup
				);
				expect(r.ok).toBe(false);
				if (!r.ok) {
					expect(r.error).toContain("files[0].content");
					expect(r.error).toContain("not a string");
				}
			}
			expect(lookup).not.toHaveBeenCalled();
		});

		it("lets ordinary strings that mention $file pass through untouched", async () => {
			const args = {
				a: 'const x = {"$file": "d"}; // more',
				b: '{"other": "$file"}',
				c: "$file",
			};
			const r = await resolveFileReferences(args, ctx, lookupOf(files));
			expect(r).toMatchObject({ ok: true, args, resolved: 0 });
		});
	});

	it("notes, for each reference, the file that was sent", async () => {
		const r = await resolveFileReferences(
			{ files: [{ content: { $file: "/mnt/output/diagram.svg" } }] },
			ctx,
			lookupOf({ "diagram.svg": { owner: mine, bytes: Buffer.alloc(96733, 97) } })
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.notes).toEqual([
			"[file reference] files[0].content ← /mnt/output/diagram.svg (current version: produced by code, 96,733 bytes, sha256 x…)",
		]);
		expect(withFileRefNotes("done", r.notes)).toBe(`done\n${r.notes[0]}`);
		expect(withFileRefNotes("done", [])).toBe("done");
	});
});
