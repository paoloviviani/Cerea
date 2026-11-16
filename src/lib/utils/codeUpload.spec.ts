import { describe, it, expect } from "vitest";
import { batchProblem, dirOf, itemsFromDrop, itemsFromFiles, joinPath } from "./codeUpload";

const file = (name: string, size = 1) => {
	const f = new File([""], name);
	Object.defineProperty(f, "size", { value: size });
	return f;
};

describe("itemsFromFiles", () => {
	it("keeps a folder pick's relative path and a plain pick's name", () => {
		const nested = file("b.txt");
		Object.defineProperty(nested, "webkitRelativePath", { value: "proj/sub/b.txt" });
		expect(itemsFromFiles([file("a.txt"), nested]).map((i) => i.rel)).toEqual([
			"a.txt",
			"proj/sub/b.txt",
		]);
	});
});

describe("itemsFromDrop", () => {
	const fileEntry = (name: string) => ({
		isFile: true,
		isDirectory: false,
		name,
		file: (ok: (f: File) => void) => ok(file(name)),
	});
	const dirEntry = (name: string, children: unknown[][]) => {
		let batch = 0;
		return {
			isFile: false,
			isDirectory: true,
			name,
			// readEntries answers in batches until it answers none.
			createReader: () => ({
				readEntries: (ok: (e: unknown[]) => void) => ok(children[batch++] ?? []),
			}),
		};
	};
	const drop = (entries: unknown[]) =>
		({
			items: entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })),
			files: [],
		}) as unknown as DataTransfer;

	it("walks dropped folders recursively, in every readEntries batch, keeping relative paths", async () => {
		const tree = dirEntry("proj", [
			[fileEntry("a.txt"), dirEntry("sub", [[fileEntry("b.txt")], [fileEntry("c.txt")]])],
			[fileEntry("d.txt")],
		]);
		const items = await itemsFromDrop(drop([tree, fileEntry("loose.txt")]));
		expect(items.map((i) => i.rel)).toEqual([
			"proj/a.txt",
			"proj/sub/b.txt",
			"proj/sub/c.txt",
			"proj/d.txt",
			"loose.txt",
		]);
	});

	it("falls back to the plain file list when the browser has no entries", async () => {
		const data = { items: [], files: [file("x.txt")] } as unknown as DataTransfer;
		expect((await itemsFromDrop(data)).map((i) => i.rel)).toEqual(["x.txt"]);
	});
});

describe("batchProblem", () => {
	it("is null within 5,000 files and 2 GB, and names the limit otherwise", () => {
		const items = (n: number, size = 1) =>
			Array.from({ length: n }, (_, i) => ({ file: file(`f${i}`, size), rel: `f${i}` }));
		expect(batchProblem(items(5000))).toBeNull();
		expect(batchProblem(items(5001))).toMatchObject({ kind: "too_many", count: 5001, limit: 5000 });
		expect(batchProblem(items(11, 200 * 1024 * 1024))).toMatchObject({ kind: "too_big" });
	});
});

describe("paths", () => {
	it("joins under the open folder and splits a parent", () => {
		expect(joinPath(".", "a/b.txt")).toBe("a/b.txt");
		expect(joinPath("src", "a/b.txt")).toBe("src/a/b.txt");
		expect(dirOf("src/a/b.txt")).toBe("src/a");
		expect(dirOf("b.txt")).toBe(".");
	});
});
