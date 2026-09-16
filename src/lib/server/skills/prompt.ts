/**
 * Skills in the turn context: staged loading IS the budget mechanism
 * (Phase 1, ADR 0072).
 *
 * Stage 1 rides every turn: every enabled skill's frontmatter (`name` +
 * `description`, ~100 tokens each). No matcher code, keyword or otherwise —
 * keyword matching is more code for worse triggering. The model matches by
 * description semantics and loads the body itself, mid-turn, through the
 * `load_skill` tool (implicit activation); the person forces a body load by
 * naming `@skill-name` in their message (explicit activation). Full bodies
 * for all skills are never injected, and there is nothing deeper in Phase 1.
 */

import {
	listAdminSkills,
	findSkillBody,
	listEnabledDeploymentSkills,
	listEnabledUserSkills,
} from "./service";
import { LOAD_SKILL_TOOL_NAME } from "./service";
import type { ObjectId } from "mongodb";

export interface SkillFrontmatter {
	name: string;
	description: string;
	owner: "user" | "admin";
}

/** `@name` mentions in message text, in order, deduplicated. */
export function parseSkillMentions(text: string): string[] {
	const names: string[] = [];
	const pattern = /(?:^|[\s(>"'])@([a-z0-9][a-z0-9-]*)/g;
	let match: string[] | null;
	// A mapping lookup would be cleaner, but `RegExp.exec` with `g` is the
	// loop the stdlib offers; the lint rule against `no-cond-assign` is
	// satisfied by testing the parenthesised call result explicitly.
	while ((match = pattern.exec(text)) !== null) {
		const name = match[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Stage-1 section plus any explicitly-loaded bodies. Empty when there is
 * nothing to advertise — most turns for most people.
 */
export function buildSkillsPreprompt(
	frontmatter: SkillFrontmatter[],
	bodies: { name: string; description: string; body: string }[]
): string | undefined {
	if (frontmatter.length === 0) return undefined;
	const lines = frontmatter.map((skill) => `- \`${skill.name}\`: ${skill.description}`);
	let section =
		`## Skills\n\n` +
		`Available skills — procedural knowledge for you to follow with the app's normal ` +
		`capabilities. A skill runs nothing by itself; when one matches the work at hand, ` +
		`load its full instructions with the \`${LOAD_SKILL_TOOL_NAME}\` tool (exact \`name\`). ` +
		`Skills use client-side Python (standard library only) through the existing sandbox ` +
		`channels — never shell, never packages, never network.\n` +
		lines.join("\n");
	for (const loaded of bodies) {
		section += `\n\n## Skill: ${loaded.name}\n\n${loaded.description}\n\n${loaded.body}`;
	}
	return section;
}

/**
 * The turn's skill context: stage-1 frontmatter for every enabled skill,
 * plus stage-2 bodies for `@name` mentions in the latest user message. A
 * mention of an unknown or disabled skill is ignored silently — never an
 * error to the user. Throws nothing useful: callers that cannot afford to
 * fail the turn catch and continue without skills.
 */
export async function assembleSkillsContext(
	userId: ObjectId | undefined,
	userText: string
): Promise<{ preprompt?: string; mentioned: string[] }> {
	// Deployment rows first (bootstrapped from the code seeds on first
	// read, so no double-listing of seed + row), code seeds only for names
	// with no row — the store being unreadable still leaves the catalogue.
	const frontmatter: SkillFrontmatter[] = [];
	try {
		for (const row of await listEnabledDeploymentSkills()) {
			frontmatter.push({ name: row.name, description: row.description, owner: "admin" });
		}
	} catch {
		// listEnabledDeploymentSkills already warns; the code fallback below covers.
	}
	for (const skill of listAdminSkills()) {
		if (!frontmatter.some((entry) => entry.name === skill.name)) {
			frontmatter.push({ name: skill.name, description: skill.description, owner: "admin" });
		}
	}
	if (userId) {
		const userSkills = await listEnabledUserSkills(userId);
		for (const skill of userSkills) {
			if (!frontmatter.some((entry) => entry.name === skill.name)) {
				frontmatter.push({ name: skill.name, description: skill.description, owner: "user" });
			}
		}
	}
	if (frontmatter.length === 0) return { mentioned: [] };
	// A user's own skill wins over a seed of the same name (see
	// findSkillBody); the listing shows one row either way.
	const mentioned: string[] = [];
	const bodies: { name: string; description: string; body: string }[] = [];
	for (const name of parseSkillMentions(userText)) {
		const resolved = await findSkillBody(userId, name);
		if (!resolved) continue;
		mentioned.push(resolved.name);
		bodies.push({ name: resolved.name, description: resolved.description, body: resolved.body });
	}
	return { preprompt: buildSkillsPreprompt(frontmatter, bodies), mentioned };
}
