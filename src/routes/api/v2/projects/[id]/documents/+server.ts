/**
 * A project's context documents: list them, add one file.
 *
 * Open to everyone who can see the project, as its notes are
 * (`$lib/types/ProjectDocument`); a project the caller cannot see answers 404.
 * One file per request, so the page can show each file's own outcome and a
 * refusal of the third does not discard the first two.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { logger } from "$lib/server/logger";
import { requireProjectAccess } from "$lib/server/projects";
import {
	addProjectDocument,
	ProjectDocumentError,
	projectDocumentChars,
	projectDocumentViews,
} from "$lib/server/projectDocuments";

export const GET: RequestHandler = async ({ locals, params }) => {
	const { project, user } = await requireProjectAccess(locals, params.id);
	return json({
		data: {
			documents: await projectDocumentViews(project._id, user._id),
			usedChars: await projectDocumentChars(project._id),
		},
	});
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const { project, user } = await requireProjectAccess(locals, params.id);
	const form = await request.formData().catch(() => null);
	const file = form?.get("file");
	if (!(file instanceof File) || !file.name) error(400, "Send one file in the `file` field.");
	try {
		const row = await addProjectDocument({
			projectId: project._id,
			file,
			userId: user._id,
			token: locals.token,
		});
		const view = (await projectDocumentViews(project._id, user._id)).find(
			(doc) => doc.id === row._id.toString()
		);
		return json(
			{ data: { document: view, usedChars: await projectDocumentChars(project._id) } },
			{ status: 201 }
		);
	} catch (err) {
		if (err instanceof ProjectDocumentError) error(err.status, err.message);
		logger.error({ err }, "project_document_upload_failed");
		throw err;
	}
};
