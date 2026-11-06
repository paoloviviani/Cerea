/**
 * Downloads a text artifact (an `<artifact>` of a chat, which has no stored
 * file) as it stands in its latest version. Files a run or a tool made are
 * downloaded from the deliverable store instead. Only the caller's own chats.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { authCondition } from "$lib/server/auth";
import { latestArtifactFile } from "$lib/server/artifactsList";

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const id = url.searchParams.get("conversation") ?? "";
	const identifier = url.searchParams.get("identifier") ?? "";
	if (!ObjectId.isValid(id) || !identifier) error(404, "No such artifact.");
	const file = await latestArtifactFile(authCondition(locals), new ObjectId(id), identifier);
	if (!file) error(404, "No such artifact.");
	return new Response(file.content, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; sandbox;",
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition": `attachment; filename="${file.name.replace(/[\r\n"\\/]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		},
	});
};
