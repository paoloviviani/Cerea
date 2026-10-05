/**
 * A project's shared notes: list them, add one.
 *
 * Open to everyone who can see the project — its owner and everyone it is
 * shared with — and to nobody else. Access is the same `projectAccess` check
 * every other project route uses, and a project the caller cannot see answers
 * 404, not 403, for the reason that function gives. Unlike the project's own
 * settings, notes are not owner-only: see `$lib/types/ProjectMemory`.
 *
 * The deployment flag (`CHAT_MEMORY_ENABLED`) is re-checked here rather than
 * trusted from the UI hiding the tab.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	MemoryValidationError,
	projectMemoryViews,
	rememberForProject,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
} from "$lib/server/memory/service";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";

const create = z.object({
	text: z.string().trim().min(1).max(PROJECT_MEMORY_TEXT_MAX_CHARS),
});

async function memberProject(locals: App.Locals, id: string | undefined) {
	if (!memoryEnabled()) error(404, "Memory is not enabled in this deployment.");
	if (!locals.user) error(401, "Login required");
	const principals = await viewerPrincipals(locals.user, locals.token);
	const access = await projectAccess(id as string, locals.user._id, principals);
	if (!access) error(404, "No such project.");
	return { project: access.project, user: locals.user };
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const { project, user } = await memberProject(locals, params.id);
	return json({ data: { notes: await projectMemoryViews(project._id, user._id) } });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const { project, user } = await memberProject(locals, params.id);
	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That note is not valid.");
	}
	try {
		// `source: "user"` regardless of who is calling: this route is the tab,
		// and the tool writes through the service directly. A client that could
		// name its own provenance could label a guess as something a person said.
		const { memory } = await rememberForProject({
			projectId: project._id,
			authorUserId: user._id,
			text: parsed.data.text,
			source: "user",
		});
		const view = (await projectMemoryViews(project._id, user._id)).find(
			(note) => note.id === memory._id.toString()
		);
		return json({ data: view }, { status: 201 });
	} catch (err) {
		if (err instanceof MemoryValidationError) error(400, err.message);
		throw err;
	}
};
