import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `.env` is the defaults file. Two things must stay true, or it rots into a
 * list of settings nobody reads and a code base that reads settings nobody can
 * find:
 *
 * - every variable *set* in `.env` is read somewhere in `src/`;
 * - every setting `src/` reads from the configuration is listed in `.env`,
 *   either set (it has a default) or commented out as `# NAME=` (it has no
 *   safe default, or an empty value would override one set in the
 *   environment).
 */

const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

/**
 * Read from the environment but not part of the application's configuration,
 * so they are not listed in `.env`: set by the runtime, the build or the
 * container, or by a test harness.
 */
const NOT_CONFIGURATION = new Set([
	"BASE_URL", // Vite
	"MODE", // Vite
	"PORT", // the HTTP server's port, read from the process environment
	"PUBLIC_VERSION", // injected by the build
	"LD_LIBRARY_PATH", // the container's library path
	"XDG_CACHE_HOME", // the container's cache directory
]);

/**
 * Set in `.env` but read outside `src/`: by the Dockerfile or the adapter
 * rather than by application code.
 */
const READ_OUTSIDE_SRC = new Set(["APP_BASE", "BODY_SIZE_LIMIT"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			sourceFiles(path, out);
		} else if (/\.(ts|svelte)$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) {
			if (!relative(SRC, path).split("/").includes("__tests__")) out.push(path);
		}
	}
	return out;
}

const READ_PATTERNS = [
	/\b(?:config|publicConfig|publicEnv|serverEnv|env|configStore)\.([A-Z][A-Z0-9_]{2,})\b/g,
	/\b(?:config|publicConfig|env)\??\.get\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
	/Reflect\.get\(\s*\w+,\s*["']([A-Z][A-Z0-9_]+)["']/g,
	/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
];

function variablesRead(): Set<string> {
	const read = new Set<string>();
	for (const file of sourceFiles(SRC)) {
		const text = readFileSync(file, "utf8");
		for (const pattern of READ_PATTERNS) {
			for (const match of text.matchAll(pattern)) read.add(match[1]);
		}
	}
	return read;
}

function envFile(): { set: Set<string>; listed: Set<string> } {
	const set = new Set<string>();
	const listed = new Set<string>();
	for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
		const active = line.match(/^([A-Z][A-Z0-9_]*)=/);
		if (active) {
			set.add(active[1]);
			listed.add(active[1]);
			continue;
		}
		const commented = line.match(/^#\s*([A-Z][A-Z0-9_]*)=/);
		if (commented) listed.add(commented[1]);
	}
	return { set, listed };
}

describe(".env", () => {
	const read = variablesRead();
	const { set, listed } = envFile();

	it("sets only variables the code reads", () => {
		const unread = [...set].filter((name) => !read.has(name) && !READ_OUTSIDE_SRC.has(name));
		expect(unread).toEqual([]);
	});

	it("lists every setting the code reads", () => {
		const unlisted = [...read].filter((name) => !listed.has(name) && !NOT_CONFIGURATION.has(name));
		expect(unlisted.sort()).toEqual([]);
	});

	it("sets no duplicate variable", () => {
		const names = readFileSync(join(ROOT, ".env"), "utf8")
			.split("\n")
			.map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
			.filter((name): name is string => Boolean(name));
		const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
		expect(duplicates).toEqual([]);
	});
});
