/**
 * One project note: rewrite it, or delete it.
 *
 * Any member of the project may do either, to any note (user decision: notes
 * are the project's, not their author's). A note id is matched together with
 * the project id, so an id from another project is a 404 here.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { memoryEnabled } from "$lib/server/memoryEnabled";
import {
	deleteProjectMemory,
	MemoryValidationError,
	projectMemoryViews,
	updateProjectMemory,
	PROJECT_MEMORY_TEXT_MAX_CHARS,
} from "$lib/server/memory/service";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";

const patch = z.object({
	text: z.string().trim().min(1).max(PROJECT_MEMORY_TEXT_MAX_CHARS),
});

async function memberProject(locals: App.Locals, id: string | undefined) {
	if (!locals.user) error(401, "Login required");
	const principals = await viewerPrincipals(locals.user, locals.token);
	const access = await projectAccess(id as string, locals.user._id, principals);
	if (!access) error(404, "No such project.");
	return { project: access.project, user: locals.user };
}

function noteId(params: { noteId?: string }): ObjectId {
	if (!params.noteId || !ObjectId.isValid(params.noteId)) error(404, "No such note.");
	return new ObjectId(params.noteId);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!memoryEnabled()) error(404, "Memory is not enabled in this deployment.");
	const { project, user } = await memberProject(locals, params.id);
	const parsed = patch.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That change is not valid.");
	}
	try {
		const updated = await updateProjectMemory(project._id, noteId(params), parsed.data.text);
		const view = (await projectMemoryViews(project._id, user._id)).find(
			(note) => note.id === updated._id.toString()
		);
		return json({ data: view });
	} catch (err) {
		if (err instanceof MemoryValidationError) {
			error(err.message === "No such note." ? 404 : 400, err.message);
		}
		throw err;
	}
};

/**
 * Allowed even when the deployment flag is off, as for personal memory: an
 * operator switching the feature off must not strand what members already
 * wrote behind a 404.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { project } = await memberProject(locals, params.id);
	if (!(await deleteProjectMemory(project._id, noteId(params)))) error(404, "No such note.");
	return new Response(null, { status: 204 });
};
