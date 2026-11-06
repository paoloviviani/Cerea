/**
 * The Artifacts tabs' list: what the model made in the caller's own chats,
 * either in one project (`?project=<id>`) or in no project (`?project=none`),
 * newest first, 30 to a page (`p`), narrowed by a name filter (`q`).
 *
 * A shared project's other members' chats are not read at all, so neither
 * their artifacts nor their titles leave the server, and no count of them is
 * given either (the chats list shows a count of chats; a count of somebody
 * else's files says nothing a user can act on).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { authCondition } from "$lib/server/auth";
import { listArtifacts } from "$lib/server/artifactsList";
import { projectAccess, viewerPrincipals } from "$lib/server/projects";
import { CONV_NUM_PER_PAGE, MAX_TITLE_QUERY_LENGTH } from "$lib/constants/pagination";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const wanted = url.searchParams.get("project");
	let projectId: ObjectId | null = null;
	if (wanted && wanted !== "none") {
		if (!locals.user) error(401, "Login required");
		const principals = await viewerPrincipals(locals.user, locals.token);
		const access = await projectAccess(wanted, locals.user._id, principals);
		if (!access) error(404, "No such project.");
		projectId = access.project._id;
	} else if (wanted !== "none") {
		error(400, "Say which: ?project=<id> or ?project=none");
	}
	const result = await listArtifacts(
		{ owner: authCondition(locals), projectId },
		{
			q: (url.searchParams.get("q") ?? "").slice(0, MAX_TITLE_QUERY_LENGTH),
			page: Math.max(0, parseInt(url.searchParams.get("p") ?? "0") || 0),
			pageSize: CONV_NUM_PER_PAGE,
		}
	);
	return json(result);
};
