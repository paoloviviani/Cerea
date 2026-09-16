/**
 * One skill: read it (body included), change it, delete it.
 *
 * Two permissions, like the connector routes. **Reading** a deployment skill
 * is open to everybody it is offered to — the row renders for them. **Changing**
 * one (its procedure, its enabled flag, its existence) belongs to an
 * administrator, because the change lands on everybody else's turns too, and
 * is refused through `requireAdmin` — the gateway's answer, never a client
 * flag. A personal skill stays its owner's and nobody else's, administrator
 * included: "I administer this deployment" is not "I may edit your private
 * procedure".
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { requireAdmin } from "$lib/server/admin";
import {
	deleteDeploymentSkill,
	deleteSkill,
	skillView,
	updateDeploymentSkill,
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
	const id = skillId(params);
	const skill = await collections.skills.findOne({ _id: id });
	if (!skill) error(404, "No such skill.");
	if (skill.scope === "deployment")
		return json({ data: { ...skillView(skill), content: skill.content } });
	if (!skill.userId.equals(user._id)) error(404, "No such skill.");
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
	const id = skillId(params);
	const existing = await collections.skills.findOne({ _id: id }, { projection: { scope: 1 } });
	if (!existing) error(404, "No such skill.");
	try {
		if (existing.scope === "deployment") {
			await requireAdmin(locals);
			const updated = await updateDeploymentSkill(id, parsed.data);
			return json({ data: skillView(updated) });
		}
		const updated = await updateSkill(user._id, id, parsed.data);
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
	const id = skillId(params);
	const existing = await collections.skills.findOne({ _id: id }, { projection: { scope: 1 } });
	if (!existing) error(404, "No such skill.");
	if (existing.scope === "deployment") {
		await requireAdmin(locals);
		if (!(await deleteDeploymentSkill(id))) error(404, "No such skill.");
		return new Response(null, { status: 204 });
	}
	if (!(await deleteSkill(user._id, id))) error(404, "No such skill.");
	return new Response(null, { status: 204 });
};
