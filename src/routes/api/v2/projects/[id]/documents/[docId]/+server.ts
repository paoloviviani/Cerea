/**
 * Remove one of a project's context documents, with its stored bytes and text.
 *
 * Any member may, as for a note: the document is the project's by then. The id
 * is matched together with the project's, so one from another project is a 404.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { requireProjectAccess } from "$lib/server/projects";
import { deleteProjectDocument } from "$lib/server/projectDocuments";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const { project } = await requireProjectAccess(locals, params.id);
	if (!params.docId || !ObjectId.isValid(params.docId)) error(404, "No such document.");
	if (!(await deleteProjectDocument(project._id, new ObjectId(params.docId)))) {
		error(404, "No such document.");
	}
	return new Response(null, { status: 204 });
};
