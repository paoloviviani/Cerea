/**
 * One deployment skill's body, for the read-only view in the workspace tab.
 *
 * Deployment rows first (bootstrapped from the code seeds on first read),
 * code seeds as the fallback source of truth — one catalogue, never a seed
 * listed beside its own row. Unknown, disabled, or kill-switched names are
 * 404, silently.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { listAdminSkills } from "$lib/server/skills/service";
import { adminDisabledSkillNames } from "$lib/server/skills/adminSkills";
import { isParsedSkill, parseSkill } from "$lib/server/skills/parse";

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const name = params.name ?? "";
	if (adminDisabledSkillNames().has(name)) error(404, "No such skill.");
	const row = await collections.skills.findOne({ scope: "deployment", name });
	if (row) {
		if (!row.enabled) error(404, "No such skill.");
		const parsed = parseSkill(row.content);
		const body = isParsedSkill(parsed) ? parsed.body : row.content;
		return json({
			data: { name: row.name, description: row.description, content: body, readOnly: true },
		});
	}
	const seed = listAdminSkills().find((skill) => skill.name === name);
	if (!seed) error(404, "No such skill.");
	return json({
		data: { name: seed.name, description: seed.description, content: seed.body, readOnly: true },
	});
};
