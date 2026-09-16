/**
 * SKILL.md parsing and validation, in the open format verbatim (ADR 0072).
 *
 * A valid skill is YAML frontmatter with required `name` + `description`,
 * then a markdown body. Anything else is rejected with a logged reason —
 * never stored, never listed. `scripts/`, `references/` and `assets/`
 * directories are inert-bundled in Phase 1: only stdlib-Python content the
 * model itself runs through the existing sandbox tools has any effect, and
 * that runs client-side, never here.
 */

import yaml from "js-yaml";
import { logger } from "$lib/server/logger";
import type { SkillFile } from "$lib/types/Skill";

export const SKILL_MAX_BODY_LINES = 500;
export const SKILL_MAX_NAME_LENGTH = 64;
export const SKILL_MAX_DESCRIPTION_LENGTH = 1024;

/** Lowercase letters, digits and hyphens — the open spec's naming rule. */
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Bundled files live only under these three directories, per the open
 * spec — a path outside them is not a Stage 3 bundled file, it is something
 * else claiming to be one.
 */
export const SKILL_FILE_PREFIXES = ["scripts/", "references/", "assets/"] as const;

/**
 * Per-file and whole-skill caps. The binding constraint is Mongo's 16MB BSON
 * document limit, not disk or bandwidth: `content` (base64 for binary
 * `assets/`) inflates ~4/3 over the original bytes, and the SKILL.md text
 * and per-file path strings add their own overhead on top. 2MB/file and 8MB
 * total keeps the worst case (all-binary, all at the cap) around 10.7MB
 * base64 — comfortably under 16MB with room for everything else in the
 * document. A real imported skill (the anthropics docx/xlsx/pdf skills) is
 * a few hundred KB; these caps are headroom, not a target.
 */
export const SKILL_MAX_FILE_BYTES = 2_000_000;
export const SKILL_MAX_TOTAL_FILE_BYTES = 8_000_000;
export const SKILL_MAX_FILE_COUNT = 200;

/**
 * Validate one bundled file's path: must live under `scripts/`,
 * `references/` or `assets/`, use forward slashes, and never escape the
 * skill folder. Returns a rejection reason, or undefined when the path is
 * fine.
 */
export function invalidSkillFilePathReason(path: string): string | undefined {
	if (!path || path.trim().length === 0) return "a bundled file needs a non-empty path";
	if (path.includes("\\")) return `path \`${path}\` must use forward slashes`;
	if (path.startsWith("/")) return `path \`${path}\` must be relative to the skill folder`;
	if (path.split("/").some((segment) => segment === "." || segment === "..")) {
		return `path \`${path}\` must not contain \`.\` or \`..\` segments`;
	}
	if (path.endsWith("/")) return `path \`${path}\` must name a file, not a directory`;
	if (!SKILL_FILE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
		return `path \`${path}\` must be under scripts/, references/ or assets/`;
	}
	return undefined;
}

/** True when `data` round-trips through UTF-8 unchanged — the boundary this module uses to call content "text". */
function isUtf8Text(data: Uint8Array): boolean {
	const text = Buffer.from(data).toString("utf8");
	return Buffer.from(text, "utf8").equals(data);
}

/**
 * Turn raw bundled-file bytes into the stored `SkillFile` shape: text
 * verbatim, anything else base64. Path validation is the caller's job
 * (`invalidSkillFilePathReason`) — this only decides the encoding.
 */
export function encodeSkillFile(path: string, data: Uint8Array): SkillFile {
	if (isUtf8Text(data)) return { path, content: Buffer.from(data).toString("utf8") };
	return { path, content: Buffer.from(data).toString("base64"), encoding: "base64" };
}

/**
 * Validate a whole set of bundled files: every path checked
 * (`invalidSkillFilePathReason`), the count and per-file/total size caps
 * enforced. Rejects the whole set on the first problem, named — a partial
 * import that silently drops files would be a worse surprise than a clear
 * failure up front.
 */
export function validateSkillFiles(
	entries: { path: string; data: Uint8Array }[]
): SkillFile[] | SkillParseFailure {
	if (entries.length > SKILL_MAX_FILE_COUNT) {
		return fail(`a skill may bundle at most ${SKILL_MAX_FILE_COUNT} files`, {
			count: entries.length,
		});
	}
	let total = 0;
	const files: SkillFile[] = [];
	for (const entry of entries) {
		const reason = invalidSkillFilePathReason(entry.path);
		if (reason) return fail(reason, { path: entry.path });
		if (entry.data.byteLength > SKILL_MAX_FILE_BYTES) {
			return fail(
				`file \`${entry.path}\` exceeds the ${SKILL_MAX_FILE_BYTES}-byte per-file limit`,
				{ path: entry.path, size: entry.data.byteLength }
			);
		}
		total += entry.data.byteLength;
		if (total > SKILL_MAX_TOTAL_FILE_BYTES) {
			return fail(`bundled files exceed the ${SKILL_MAX_TOTAL_FILE_BYTES}-byte total limit`, {
				path: entry.path,
			});
		}
		files.push(encodeSkillFile(entry.path, entry.data));
	}
	return files;
}

export interface ParsedSkill {
	name: string;
	description: string;
	/** The markdown body, without frontmatter. Truncated at 500 lines. */
	body: string;
	/** True when the body was cut down to the cap. */
	truncated: boolean;
}

export interface SkillParseFailure {
	reason: string;
}

/** Type predicate: narrows `unknown` to a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function fail(reason: string, context?: Record<string, unknown>): SkillParseFailure {
	logger.warn({ ...(context ?? {}), reason }, "[skills] rejecting invalid skill");
	return { reason };
}

/**
 * Split `---` frontmatter off the body. Returns undefined when the document
 * does not open with a frontmatter block at all.
 */
export function splitFrontmatter(
	content: string
): { frontmatter: string; body: string } | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(content);
	if (!match) return undefined;
	return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/**
 * Parse and validate one SKILL.md document. Missing `name`/`description`
 * is an invalid skill, rejected with a logged reason; a body past 500
 * lines is truncated with a logged warning, not rejected.
 */
export function parseSkill(content: string): ParsedSkill | SkillParseFailure {
	if (!content.trim()) return fail("empty skill document");
	const split = splitFrontmatter(content);
	if (!split) return fail("missing frontmatter block");

	let data: unknown;
	try {
		data = yaml.load(split.frontmatter);
	} catch (err) {
		return fail(`frontmatter is not valid YAML: ${err instanceof Error ? err.message : err}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return fail("frontmatter must be a mapping");
	}
	const record = data as Record<string, unknown>;
	const { name, description } = record;
	if (!isNonEmptyString(name)) {
		return fail("frontmatter requires a non-empty `name`");
	}
	if (!isNonEmptyString(description)) {
		return fail("frontmatter requires a non-empty `description`");
	}
	const trimmedName = name.trim();
	if (trimmedName.length > SKILL_MAX_NAME_LENGTH) {
		return fail(`skill name exceeds ${SKILL_MAX_NAME_LENGTH} characters`, { name: trimmedName });
	}
	if (!SKILL_NAME_PATTERN.test(trimmedName)) {
		return fail("skill name must match /^[a-z0-9-]+$/ (lowercase, digits, hyphens)", {
			name: trimmedName,
		});
	}
	const trimmedDescription = description.trim();
	if (trimmedDescription.length > SKILL_MAX_DESCRIPTION_LENGTH) {
		return fail(`skill description exceeds ${SKILL_MAX_DESCRIPTION_LENGTH} characters`, {
			name: trimmedName,
		});
	}

	const lines = split.body.split("\n");
	const truncated = lines.length > SKILL_MAX_BODY_LINES;
	const body = (truncated ? lines.slice(0, SKILL_MAX_BODY_LINES) : lines).join("\n").trim();
	if (truncated) {
		logger.warn(
			{ name: trimmedName, lines: lines.length, kept: SKILL_MAX_BODY_LINES },
			"[skills] skill body truncated to 500 lines"
		);
	}
	return { name: trimmedName, description: trimmedDescription, body, truncated };
}

/** True when `parseSkill` accepted the document. */
export function isParsedSkill(parsed: ParsedSkill | SkillParseFailure): parsed is ParsedSkill {
	return (parsed as ParsedSkill).body !== undefined;
}
