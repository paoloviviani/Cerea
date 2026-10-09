/**
 * The built-in deployment skills, read from `builtin/` at build time
 * (ADR 0072 amendment: skills ship with bundled files).
 *
 * A built-in is a directory under `builtin/<name>/` shaped exactly like the
 * zip-import format: `SKILL.md` at the root, bundled files under
 * `scripts/`, `references/` and `assets/`, and — beside `SKILL.md`, never
 * seeded — its upstream `LICENSE.txt` and a `SOURCE.md` recording where the
 * content came from and what was changed. The three original inline seeds in
 * `adminSkills.ts` flow through the same list unchanged.
 *
 * The directories are read through Vite's `?raw` glob and inlined into the
 * server bundle: the running container copies only `build/`, so a runtime
 * filesystem read of the repo would not survive the image, while an import
 * works identically in dev, tests and production. `?raw` decodes files as
 * UTF-8, so everything bundled must be UTF-8 text — a binary asset (the deck
 * template) is embedded base64 inside the script that uses it instead.
 *
 * Everything goes through the same validation the zip import uses —
 * `parseSkill` for the document, `validateSkillFiles` for the bundle — so a
 * built-in that fails validation is dropped with a logged reason, exactly
 * like a bad seed or a bad zip: a broken built-in must never fail a turn.
 */

import { createHash } from "node:crypto";
import { isParsedSkill, parseSkill, validateSkillFiles, SKILL_FILE_PREFIXES } from "./parse";
import { ADMIN_SKILL_CONTENTS } from "./adminSkills";
import type { SkillFile } from "$lib/types/Skill";

export interface BuiltinSkill {
	name: string;
	description: string;
	/** The full SKILL.md text, frontmatter included. */
	content: string;
	/** Bundled files, validated and encoded like a zip import's. */
	files: SkillFile[];
	/**
	 * Sha256 over the definition (content plus bundled files) — the value
	 * `ensureDeploymentSeeds` stores on the row and later compares against to
	 * decide whether an upgrade may replace it.
	 */
	hash: string;
}

function definitionHash(content: string, files: SkillFile[]): string {
	const hash = createHash("sha256");
	hash.update(content);
	hash.update("\0");
	for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.encoding ?? "utf8");
		hash.update("\0");
		hash.update(file.content);
	}
	return hash.digest("hex");
}

const skillMdModules = import.meta.glob<string>("./builtin/*/SKILL.md", {
	query: "?raw",
	import: "default",
	eager: true,
});
const bundledModules = [
	...Object.entries(
		import.meta.glob<string>("./builtin/*/scripts/**", {
			query: "?raw",
			import: "default",
			eager: true,
		})
	),
	...Object.entries(
		import.meta.glob<string>("./builtin/*/references/**", {
			query: "?raw",
			import: "default",
			eager: true,
		})
	),
	...Object.entries(
		import.meta.glob<string>("./builtin/*/assets/**", {
			query: "?raw",
			import: "default",
			eager: true,
		})
	),
];

/**
 * The directory-based built-ins, parsed and validated once at first use.
 * Invalid ones are dropped with a logged reason and never seeded.
 */
function directorySkills(): BuiltinSkill[] {
	const skills: BuiltinSkill[] = [];
	for (const [skillMdPath, content] of Object.entries(skillMdModules)) {
		const name = skillMdPath.slice("./builtin/".length, -"SKILL.md".length - 1);
		const parsed = parseSkill(content);
		if (!isParsedSkill(parsed)) continue;
		const bundled: { path: string; data: Uint8Array }[] = [];
		for (const [path, raw] of bundledModules) {
			const prefix = `./builtin/${name}/`;
			if (!path.startsWith(prefix)) continue;
			const relative = path.slice(prefix.length);
			if (!SKILL_FILE_PREFIXES.some((p) => relative.startsWith(p))) continue;
			bundled.push({ path: relative, data: new TextEncoder().encode(raw) });
		}
		const files = validateSkillFiles(bundled);
		if (!Array.isArray(files)) continue;
		skills.push({
			name: parsed.name,
			description: parsed.description,
			content,
			files,
			hash: definitionHash(content, files),
		});
	}
	return skills;
}

let cached: BuiltinSkill[] | undefined;

/**
 * Every built-in definition: the three inline seeds from `adminSkills.ts`
 * plus the directories under `builtin/`, in one list, parsed and validated
 * once per process. A definition that fails validation is dropped with a
 * logged reason — never seeded, never listed.
 */
export function listBuiltinSkills(): BuiltinSkill[] {
	if (!cached) {
		const parsed: BuiltinSkill[] = [];
		for (const content of ADMIN_SKILL_CONTENTS) {
			const result = parseSkill(content);
			if (!isParsedSkill(result)) continue;
			parsed.push({
				name: result.name,
				description: result.description,
				content,
				files: [],
				hash: definitionHash(content, []),
			});
		}
		parsed.push(...directorySkills());
		cached = parsed;
	}
	return cached;
}

/** Test hook: forget the parsed definitions so edited content takes effect. */
export function resetBuiltinSkillCache(): void {
	cached = undefined;
}

/** One definition's hash, computed the way `listBuiltinSkills` does. */
export function builtinSkillHash(content: string, files: SkillFile[]): string {
	return definitionHash(content, files);
}
