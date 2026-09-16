/**
 * One admin seed's body, for the read-only view. Seeds have no per-user
 * state — no enable flag, nothing to change — so this is a GET and nothing
 * else. Unknown or kill-switched names are 404, silently.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { listAdminSkills } from "$lib/server/skills/service";

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const seed = listAdminSkills().find((skill) => skill.name === params.name);
	if (!seed) error(404, "No such skill.");
	return json({
		data: { name: seed.name, description: seed.description, content: seed.body, readOnly: true },
	});
};
