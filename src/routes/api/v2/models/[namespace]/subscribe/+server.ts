import { error, type RequestHandler } from "@sveltejs/kit";
import { resolveModel } from "$lib/server/api/utils/resolveModel";
import { collections } from "$lib/server/database";
import { guardAnonymousSettingsRow } from "$lib/server/anonymousSettings";
import { authCondition } from "$lib/server/auth";

export const POST: RequestHandler = async ({ params, locals, getClientAddress }) => {
	if (!locals.sessionId) {
		error(401, "Unauthorized");
	}

	await guardAnonymousSettingsRow(locals, getClientAddress);

	const model = await resolveModel(params.namespace ?? "");

	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				activeModel: model.id,
				updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{ upsert: true }
	);

	return new Response();
};
