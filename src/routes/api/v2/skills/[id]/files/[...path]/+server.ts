/**
 * One bundled file on one skill (Stage 3, ADR 0072): read its content, or
 * remove it from the skill.
 *
 * Same two permissions as the skill itself (`../[id]/+server.ts`). Reading
 * is open to everybody the skill is offered to — a deployment row's files
 * are as readable as its body. Removing one is the owner's act for a user
 * skill, an administrator's for a deployment row, through `requireAdmin` —
 * the gateway's answer, never a client flag.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { requireAdmin } from "$lib/server/admin";
import {
	removeDeploymentSkillFile,
	removeSkillFile,
	skillView,
	SkillValidationError,
} from "$lib/server/skills/service";

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

function skillId(params: { id?: string }): ObjectId {
	if (!params.id || !ObjectId.isValid(params.id)) error(404, "No such skill.");
	return new ObjectId(params.id);
}

function filePath(params: { path?: string }): string {
	if (!params.path) error(404, "No such file.");
	return params.path;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const id = skillId(params);
	const path = filePath(params);
	const skill = await collections.skills.findOne({ _id: id });
	if (!skill) error(404, "No such skill.");
	if (skill.scope !== "deployment" && !skill.userId.equals(user._id)) error(404, "No such skill.");
	const file = skill.files?.find((entry) => entry.path === path);
	if (!file) error(404, "No such file.");
	return json({ data: file });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const id = skillId(params);
	const path = filePath(params);
	const existing = await collections.skills.findOne({ _id: id }, { projection: { scope: 1 } });
	if (!existing) error(404, "No such skill.");
	try {
		if (existing.scope === "deployment") {
			await requireAdmin(locals);
			const updated = await removeDeploymentSkillFile(id, path);
			return json({ data: skillView(updated) });
		}
		const updated = await removeSkillFile(user._id, id, path);
		return json({ data: skillView(updated) });
	} catch (err) {
		if (err instanceof SkillValidationError) error(404, "No such skill.");
		throw err;
	}
};
