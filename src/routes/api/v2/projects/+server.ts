/**
 * Projects: the collection.
 *
 * `GET` lists what the signed-in person owns or has been given. `POST` creates
 * one, fully configured — the create dialog sends the instructions and the
 * knowledge bases with the name, because a project with neither is just a
 * folder and everything that makes it a project was on the second screen.
 *
 * Note what is *not* validated here: the knowledge base ids. This route stores
 * whichever the client sent, and every retrieval re-checks the reader's own
 * access to each one through the gateway. Checking at write time as well would
 * be a second answer to "may you use this base" that goes stale the moment a
 * share is revoked — and the answer that matters is the one at read time.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { listProjects, projectView, viewerPrincipals } from "$lib/server/projects";
import type { Project } from "$lib/types/Project";
import { ObjectId } from "mongodb";

const create = z.object({
	name: z.string().trim().min(1).max(128),
	description: z.string().trim().max(500).default(""),
	instructions: z.string().max(20_000).default(""),
	knowledgeBaseIds: z.array(z.string().uuid()).max(20).default([]),
	indexPastChats: z.boolean().default(false),
	retrievalLimit: z.number().int().min(1).max(20).default(6),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	const principals = await viewerPrincipals(user, locals.token);
	const projects = await listProjects(user._id, principals);
	const views = await Promise.all(
		projects.map((project) => projectView({ project, owned: project.userId.equals(user._id) }))
	);
	return json({ data: views });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That project is not valid.");
	}
	const now = new Date();
	const project: Project = {
		_id: new ObjectId(),
		userId: user._id,
		name: parsed.data.name,
		description: parsed.data.description,
		instructions: parsed.data.instructions,
		knowledgeBaseIds: parsed.data.knowledgeBaseIds,
		indexPastChats: parsed.data.indexPastChats,
		retrievalLimit: parsed.data.retrievalLimit,
		shares: [],
		createdAt: now,
		updatedAt: now,
	};
	await collections.projects.insertOne(project);
	return json(await projectView({ project, owned: true }), { status: 201 });
};
