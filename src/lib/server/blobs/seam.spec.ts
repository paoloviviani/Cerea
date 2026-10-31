/**
 * The seam holds: every stored file goes through `BlobStore`. A new blob user
 * calls `collections.blobStore`; it never opens a `GridFSBucket`, never reads
 * or writes `files.files`, `files.chunks` or `codeOutputs.*` itself, and never
 * builds an S3 client. Only `src/lib/server/blobs/` (and the migration script,
 * which by its nature reads GridFS and writes S3) may.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../..");
const SCAN = ["src", "scripts"];
const ALLOWED = [join("src", "lib", "server", "blobs") + sep, join("scripts", "blobs-migrate.mjs")];
const FORBIDDEN = [
	/\bGridFSBucket\b/,
	/["'`](files|codeOutputs)\.(files|chunks)["'`]/,
	/@aws-sdk\/(client-s3|lib-storage)/,
];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|js|mjs|svelte)$/.test(name)) out.push(path);
	}
	return out;
}

describe("the blob-store seam", () => {
	it("is the only way code touches GridFS or S3", () => {
		const offenders: string[] = [];
		for (const dir of SCAN) {
			for (const file of walk(join(ROOT, dir))) {
				const rel = relative(ROOT, file);
				if (rel === join("src", "lib", "server", "blobs", "seam.spec.ts")) continue;
				if (ALLOWED.some((allowed) => rel.startsWith(allowed))) continue;
				const text = readFileSync(file, "utf-8");
				for (const pattern of FORBIDDEN) {
					if (pattern.test(text)) offenders.push(`${rel}: ${pattern}`);
				}
			}
		}
		expect(
			offenders,
			"use `collections.blobStore` (src/lib/server/blobs), never GridFS or S3 directly"
		).toEqual([]);
	});
});
