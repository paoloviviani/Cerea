/**
 * The caller's own coding-agent profile for a project (ADR 0106): the machine, workspace, mode,
 * model and permission word `agent_start` defaults to in that project's chats.
 *
 * Open to everyone who can see the project (owner or shared), and each reads and writes only
 * their own row: a project can be shared, a machine is one user's. A project the caller cannot
 * see answers 404, as every project route does. The bodies are bare, like the project's own
 * route: GET answers the `ProjectAgentProfile` or `null` when the caller has none, PUT takes a
 * `ProjectAgentProfileInput` and answers the stored profile, DELETE answers 204. Validated like a schedule target: the machine is
 * the caller's own and paired, the workspace exists on it; labels are resolved here.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { codeAgentsAllowedFor } from "$lib/server/codeEnabled";
import { requireProjectAccess } from "$lib/server/projects";
import {
	deleteProjectAgentProfile,
	getProjectAgentProfile,
	profileInputSchema,
	profileView,
	saveProjectAgentProfile,
} from "$lib/server/projectAgentProfiles";
import type { ProjectAgentProfileInput } from "$lib/types/AgentSession";

async function context(locals: App.Locals, id: string | undefined) {
	const access = await requireProjectAccess(locals, id);
	if (!(await codeAgentsAllowedFor(locals))) error(404, "Coding agents are not available here.");
	return access;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const { project, user } = await context(locals, params.id);
	const row = await getProjectAgentProfile(project._id, user._id);
	return json(row ? profileView(row) : null);
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const { project, user } = await context(locals, params.id);
	const body = await request.json().catch(() => null);
	const parsed = profileInputSchema.safeParse(body);
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That profile is not valid.");
	}
	const saved = await saveProjectAgentProfile(
		project._id,
		user._id,
		parsed.data as ProjectAgentProfileInput
	);
	if (!saved.ok) error(400, saved.error);
	return json(profileView(saved.profile));
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { project, user } = await context(locals, params.id);
	await deleteProjectAgentProfile(project._id, user._id);
	return new Response(null, { status: 204 });
};
