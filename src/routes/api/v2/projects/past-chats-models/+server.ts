/**
 * The embedding models a new project's past-chats index may use: the same
 * list and default the settings card of an existing project is given, for the
 * create form, where there is no project yet.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { pastChatsIndex } from "$lib/server/knowledge/pastChats";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, "Login required");
	const { models, defaultModel } = await pastChatsIndex(undefined, locals.token);
	return json({ data: { models, defaultModel } });
};
