/**
 * Skills (Phase 1, ADR 0072): what this person has, and adding one.
 *
 * Owner-only, like a `user`-scoped connector with no publish flow: the
 * listing carries everybody's admin seeds (read-only shared definitions,
 * trivially safe — a skill holds no secrets) beside the caller's own
 * skills. Creating one stores a SKILL.md document verbatim; invalid
 * frontmatter is rejected with the logged reason, never stored.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import {
	adminSkillViews,
	createSkill,
	listUserSkills,
	skillView,
	SkillValidationError,
} from "$lib/server/skills/service";

const create = z.object({
	/** The full SKILL.md text, frontmatter included. Validated, not trusted. */
	content: z.string().trim().min(1).max(100_000),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const skills = await listUserSkills(user._id);
	return json({ data: { user: skills.map(skillView), admin: adminSkillViews() } });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That skill is not valid.");
	}
	try {
		const skill = await createSkill(user._id, parsed.data.content);
		return json({ data: skillView(skill) }, { status: 201 });
	} catch (err) {
		if (err instanceof SkillValidationError) error(400, err.message);
		throw err;
	}
};
