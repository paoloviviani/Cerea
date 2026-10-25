#!/usr/bin/env node
/**
 * The i18n guard (same shape as the console's, so the two apps feel alike).
 *
 * Four things go wrong when a catalogue is filled in by hand, and each is
 * silent at the moment it happens:
 *
 * 1. a screen calls `m["settings.title"]()` and the key is not in en.json:
 *    nothing throws, the reader sees the key where a word was;
 * 2. en.json keeps a message no code uses any more: translators are asked to
 *    translate words nobody reads;
 * 3. en.json grows a message and a generated or translated catalogue does not
 *    follow (en-XA stops revealing the string it exists to reveal; a real
 *    locale is missing a key or lost a `{placeholder}`);
 * 4. a screen declared converted spells a word out in its template, which no
 *    type can catch and which a translation will leave behind.
 *
 *     npm run i18n:check        (also part of `npm run lint`)
 *
 * The checks are deliberately textual. A proper AST extractor would find more
 * and break on every formatter upgrade; the point is to fail the build on the
 * mistakes that actually happen, and to be readable when it does.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPseudoLocale, serialise } from "./pseudo-locale.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const SRC = join(APP, "src");
const MESSAGES = join(APP, "messages");
const GENERATED = join(SRC, "lib", "paraglide");

/**
 * Directories and files whose `.svelte` templates have been through the
 * conversion, and so may not carry hard-coded user-visible text.
 *
 * A list rather than a rule over the whole tree because the rule cannot be
 * right: `aria-label="Close"` and `data-testid="users-row"` are both string
 * props and only one is a word a translator needs. The list is the honest
 * version: an area is converted when somebody says so, in the same commit that
 * converts it. THIS LIST GROWS: converting a directory means adding it here.
 * A directory entry covers everything below it.
 */
export const CONVERTED = [
	"src/routes/settings",
	"src/lib/components/settings",
	"src/lib/components/DeleteAllConversationsModal.svelte",
	"src/lib/components/code",
	"src/lib/components/workspace",
	"src/routes/code",
	"src/routes/workspace",
];

/** Props whose string value is read by a person, one way or another. */
const TEXT_PROPS = ["title", "placeholder", "aria-label", "alt", "label", "aria-description"];

const HAS_LETTERS = /[A-Za-z]/;

/**
 * A line that says it means to keep its text. Some words are not words: the
 * product's name, a command somebody has to type, a value the API sent. Say so
 * out loud on the line, or the line before it, where the next reader sees it:
 * `<!-- i18n: literal -->` (templates) or `// i18n: literal` (scripts).
 * `i18n: server text` is the same for words that came off the wire.
 */
const LITERAL = /i18n: (literal|server text)/;

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function walk(dir, accept) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const path = join(dir, entry.name);
			if (path === GENERATED) return [];
			if (entry.isDirectory()) return walk(path, accept);
			return accept(entry.name) ? [path] : [];
		})
	);
	return files.flat();
}

// Tests are not "use": a key only a test asks for is still dead in the app.
const isSource = (name) =>
	/\.(ts|svelte|js)$/.test(name) && !name.endsWith(".d.ts") && !/\.(test|spec)\./.test(name);
const isTemplate = (name) =>
	name.endsWith(".svelte") && !/\.(test|spec)\./.test(name) && !name.includes(".svelte.test.");

/** Flattens a catalogue to `key -> message`, however it is nested. */
function flatten(catalogue, prefix = "", out = {}) {
	for (const [key, value] of Object.entries(catalogue)) {
		if (key === "$schema") continue;
		const name = prefix === "" ? key : `${prefix}.${key}`;
		if (typeof value === "string" || Array.isArray(value)) out[name] = value;
		else if (value && typeof value === "object") flatten(value, name, out);
	}
	return out;
}

/** Every `{placeholder}` and `{#tag}` in a piece of text, in order. */
function tokens(text) {
	return text.match(/\{[^{}]*\}/g) ?? [];
}

/**
 * A message's shape with the words taken out: its variant keys and every
 * placeholder and tag in order. "The translation kept every placeholder",
 * made checkable.
 */
function shape(value) {
	if (typeof value === "string") return tokens(value);
	if (Array.isArray(value)) return value.map(shape);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "$schema")
				.map(([key, entry]) => [key, shape(entry)])
		);
	}
	return value;
}

/** Every message the app's own code asks for, and where it asks. */
export async function usedKeys(files) {
	const used = new Map();
	// `m["settings.title"]` — the form the compiler emits for a dotted key,
	// whether it is called, `.parts()`-ed, or kept as a value in a lookup table.
	const bracket = /\bm\[\s*"([^"]+)"\s*\]/g;
	// `m.something(` — a key with no dots. The call parenthesis keeps it apart
	// from a lambda parameter named `m`.
	const dotted = /\bm\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
	// `m` is a common name for a lambda parameter, so only a file that imported
	// the catalogue is searched at all.
	const importsMessages = /from\s+["'][^"']*paraglide\/messages(\.js)?["']/;
	for (const file of files) {
		const source = await readFile(file, "utf8");
		if (!importsMessages.test(source)) continue;
		for (const [pattern, group] of [
			[bracket, 1],
			[dotted, 1],
		]) {
			for (const match of source.matchAll(pattern)) {
				const key = match[group];
				if (!used.has(key)) used.set(key, new Set());
				used.get(key).add(relative(APP, file));
			}
		}
	}
	return used;
}

/** Replaces every `{ ... }` (nested braces included) with spaces, keeping newlines. */
function blankMustaches(text) {
	let out = "";
	let depth = 0;
	for (const ch of text) {
		if (ch === "{") depth++;
		if (depth > 0) out += ch === "\n" ? "\n" : " ";
		else out += ch;
		if (ch === "}" && depth > 0) depth--;
	}
	return out;
}

/** Blanks `<script>`, `<style>` and comments, keeping newlines so line numbers hold. */
function blankNonTemplate(source) {
	const blank = (chunk) => chunk.replace(/[^\n]/g, " ");
	return source
		.replace(/<script[\s\S]*?<\/script>/g, blank)
		.replace(/<style[\s\S]*?<\/style>/g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank);
}

/** Hard-coded user-visible text in a converted `.svelte` template. */
export function hardCoded(source) {
	const problems = [];
	const originals = source.split("\n");
	const marked = (line) =>
		LITERAL.test(originals[line - 1] ?? "") || LITERAL.test(originals[line - 2] ?? "");
	const lineOf = (text, offset) => text.slice(0, offset).split("\n").length;

	const template = blankNonTemplate(source);

	// String literals in the props a person reads. Looked at before mustaches are
	// blanked: `label={m[...]()}` is already the catalogue's job and has no quotes
	// after the `=`, so only a literal value matches.
	for (const prop of TEXT_PROPS) {
		const pattern = new RegExp(`(?<![\\w:-])${prop}="([^"]*)"`, "g");
		for (const match of template.matchAll(pattern)) {
			const value = blankMustaches(match[1]).trim();
			if (!HAS_LETTERS.test(value)) continue;
			const line = lineOf(template, match.index);
			if (!marked(line)) problems.push({ line, value: match[1].trim(), kind: prop });
		}
	}

	// Text nodes: what sits between a tag's `>` and the next `<`, once every
	// `{...}` is gone, when it carries a letter.
	const bare = blankMustaches(template);
	for (const match of bare.matchAll(/>([^<>]+)(?=<)/g)) {
		const value = match[1].replace(/\s+/g, " ").trim();
		if (!HAS_LETTERS.test(value)) continue;
		const first = match.index + 1 + match[1].search(/\S/);
		const line = lineOf(bare, first);
		if (!marked(line)) problems.push({ line, value, kind: "text" });
	}
	return problems;
}

async function main() {
	const failures = [];
	const base = JSON.parse(await readFile(join(MESSAGES, "en.json"), "utf8"));
	const flat = flatten(base);
	const keys = new Set(Object.keys(flat));

	// 1 and 2. Keys used but absent, and keys present but never used.
	const used = await usedKeys(await walk(SRC, isSource));
	for (const key of [...used.keys()].filter((key) => !keys.has(key)).sort()) {
		failures.push(`used in code but not in en.json: ${key} (${[...used.get(key)].join(", ")})`);
	}
	for (const key of [...keys].filter((key) => !used.has(key)).sort()) {
		failures.push(`in en.json but used nowhere (delete it, or use it): ${key}`);
	}

	// 3. Every other catalogue: the pseudo-locale is generated and must be
	// regenerated; a real one must carry every key with its placeholders.
	const settings = JSON.parse(await readFile(join(APP, "project.inlang", "settings.json"), "utf8"));
	const before = shape(base);
	for (const locale of settings.locales.filter((l) => l !== settings.baseLocale)) {
		const file = `messages/${locale}.json`;
		let current;
		try {
			current = await readFile(join(APP, file), "utf8");
		} catch {
			failures.push(
				`${file} is missing${locale === "en-XA" ? " — run `npm run i18n:pseudo`" : ""}`
			);
			continue;
		}
		if (locale === "en-XA" && current !== serialise(buildPseudoLocale(base))) {
			failures.push(`${file} is out of date with messages/en.json — run \`npm run i18n:pseudo\``);
		}
		const after = shape(JSON.parse(current));
		for (const key of keys) {
			if (!(key in after)) failures.push(`${file} has no message for ${key}`);
			else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
				failures.push(
					`${file} changed more than the wording of ${key}: a placeholder, a tag or a variant key differs`
				);
			}
		}
	}

	// 4. Text left hard-coded in a converted area.
	let converted = 0;
	for (const entry of CONVERTED) {
		const path = join(APP, entry);
		if (!(await exists(path))) {
			failures.push(`converted path is missing: ${entry}`);
			continue;
		}
		const files = (await stat(path)).isDirectory() ? await walk(path, isTemplate) : [path];
		for (const file of files) {
			converted++;
			for (const problem of hardCoded(await readFile(file, "utf8"))) {
				failures.push(
					`${relative(APP, file)}:${problem.line} hard-coded ${problem.kind}: ${problem.value}`
				);
			}
		}
	}

	if (failures.length > 0) {
		console.error(`i18n:check failed (${failures.length}):`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log(
		`i18n:check passed: ${keys.size} message(s), ${used.size} used, ${converted} converted template(s)`
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
