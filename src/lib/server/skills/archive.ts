/**
 * Zip import for a multi-file skill (Stage 3, ADR 0072).
 *
 * A zip of a skill folder is the natural on-disk shape the open format
 * already uses: `SKILL.md` at the root, plus optional `scripts/`,
 * `references/` and `assets/` directories beside it. This module unpacks
 * one, finds the single `SKILL.md`, and validates everything else against
 * it — never against a filesystem, never executed. `fflate` does the
 * deflate/zip framing; `parse.ts` owns what a valid skill and a valid
 * bundled-file path look like.
 */

import { unzipSync } from "fflate";
import { logger } from "$lib/server/logger";
import type { SkillFile } from "$lib/types/Skill";
import { SKILL_FILE_PREFIXES, validateSkillFiles, type SkillParseFailure } from "./parse";

export interface ParsedSkillArchive {
	/** The raw SKILL.md text, frontmatter included — validated separately by `parseSkill`. */
	content: string;
	/** Every other file in the folder, path-validated and size-capped. */
	files: SkillFile[];
}

function fail(reason: string, context?: Record<string, unknown>): SkillParseFailure {
	logger.warn({ ...(context ?? {}), reason }, "[skills] rejecting invalid skill archive");
	return { reason };
}

/**
 * Artifacts a zip tool adds that are not the skill's own data — a Finder
 * `.DS_Store`, an AppleDouble resource fork, macOS's `__MACOSX/` sidecar
 * directory. Skipped rather than rejected: refusing a whole import because
 * of a Finder quirk would be hostile, and none of this is anything the
 * skill folder itself put there.
 */
function isZipJunk(path: string): boolean {
	if (path.startsWith("__MACOSX/")) return true;
	const base = path.slice(path.lastIndexOf("/") + 1);
	return base === ".DS_Store" || base.startsWith("._");
}

/**
 * Unpack a zip of a skill folder. Accepts the folder zipped either flat
 * (`SKILL.md` at the zip root) or wrapped in one directory (`docx/SKILL.md`,
 * the shape a "download this folder" zip produces) — exactly one `SKILL.md`
 * is required either way, and its containing directory becomes the root
 * every other entry is validated relative to. An entry outside that root
 * folder entirely is rejected (a zip of a skill folder should contain only
 * that folder); an entry inside it that is not under `scripts/`,
 * `references/` or `assets/` — a `LICENSE.txt` beside `SKILL.md`, say, which
 * the anthropics skills actually ship — is dropped rather than failing the
 * import, since nothing in this app has a channel to read it anyway.
 */
export function parseSkillZip(buffer: Uint8Array): ParsedSkillArchive | SkillParseFailure {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(buffer);
	} catch (err) {
		return fail(`not a valid zip archive: ${err instanceof Error ? err.message : String(err)}`);
	}

	const paths = Object.keys(entries).filter((path) => !path.endsWith("/") && !isZipJunk(path));
	const skillMdPaths = paths.filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
	if (skillMdPaths.length === 0) {
		return fail("the zip has no SKILL.md at the root of the skill folder");
	}
	if (skillMdPaths.length > 1) {
		return fail("the zip has more than one SKILL.md — zip a single skill folder", {
			paths: skillMdPaths,
		});
	}
	const skillMdPath = skillMdPaths[0] as string;
	const root = skillMdPath.slice(0, skillMdPath.length - "SKILL.md".length);

	const bundled: { path: string; data: Uint8Array }[] = [];
	for (const path of paths) {
		if (path === skillMdPath) continue;
		if (!path.startsWith(root)) {
			return fail(`\`${path}\` is outside the skill folder \`${root || "."}\``, { path });
		}
		const relative = path.slice(root.length);
		// A real skill folder ships more than its SKILL.md and its three
		// bundled-file directories — the anthropics skills repo, for one, puts
		// a LICENSE.txt beside every skill. Anything not claiming to be a
		// bundled file is metadata the model has no channel to read anyway
		// (there is no `load_skill_file` path for it), so it is left out
		// rather than failing the whole import over it. A path that DOES
		// claim scripts/references/assets still goes through the strict
		// checks below — this only widens what is silently dropped, not what
		// is accepted.
		if (!SKILL_FILE_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
			logger.info(
				{ path: relative },
				"[skills] ignoring a skill-folder file outside scripts/references/assets"
			);
			continue;
		}
		bundled.push({ path: relative, data: entries[path] as Uint8Array });
	}

	const content = Buffer.from(entries[skillMdPath] as Uint8Array).toString("utf8");
	const files = validateSkillFiles(bundled);
	if (!Array.isArray(files)) return files;
	return { content, files };
}
