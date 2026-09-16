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

export const SKILL_MAX_BODY_LINES = 500;
export const SKILL_MAX_NAME_LENGTH = 64;
export const SKILL_MAX_DESCRIPTION_LENGTH = 1024;

/** Lowercase letters, digits and hyphens — the open spec's naming rule. */
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

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
