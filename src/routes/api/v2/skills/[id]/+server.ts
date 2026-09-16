/**
 * One user skill: read it (body included), change it, delete it.
 *
 * Owner-only end to end: every lookup is keyed on `(id, userId)`, so one
 * person's skills are never another's to read, edit, or delete. Admin
 * seeds are not addressable here — they are read-only and served under
 * `skills/admin/[name]`.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import {
	deleteSkill,
	skillView,
	updateSkill,
	SkillValidationError,
} from "$lib/server/skills/service";

const patch = z.object({
	/** Replacement SKILL.md text; re-validated, and may rename the skill. */
	content: z.string().trim().min(1).max(100_000).optional(),
	enabled: z.boolean().optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

function skillId(params: { id?: string }): ObjectId {
	if (!params.id || !ObjectId.isValid(params.id)) error(404, "No such skill.");
	return new ObjectId(params.id);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const skill = await collections.skills.findOne({ _id: skillId(params), userId: user._id });
	if (!skill) error(404, "No such skill.");
	return json({ data: { ...skillView(skill), content: skill.content } });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const parsed = patch.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	}
	if (parsed.data.content === undefined && parsed.data.enabled === undefined) {
		error(400, "Nothing to change.");
	}
	try {
		const updated = await updateSkill(user._id, skillId(params), parsed.data);
		return json({ data: skillView(updated) });
	} catch (err) {
		if (err instanceof SkillValidationError) {
			error(err.message === "skill not found" ? 404 : 400, err.message);
		}
		throw err;
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	if (!(await deleteSkill(user._id, skillId(params)))) error(404, "No such skill.");
	return new Response(null, { status: 204 });
};
