/**
 * A person's custom models: a base model plus a system prompt, private to
 * them (see `CustomModel`). Owner-only with no sharing and no administrator
 * path, keyed like `settings` so anonymous sessions have them too.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { customModelView, listCustomModels, ownerFilter } from "$lib/server/customModels";
import { assertBaseModel, customModelFields, isDuplicateKey } from "$lib/server/customModelApi";
import { CUSTOM_MODEL_MAX_PER_OWNER, type CustomModel } from "$lib/types/CustomModel";

export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	const rows = await listCustomModels(ownerFilter(locals));
	return json({ data: { models: rows.map(customModelView) } });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const parsed = z.object(customModelFields).safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That custom model is not valid.");
	}
	const { name, baseModelId, systemPrompt, description } = parsed.data;
	await assertBaseModel(locals, baseModelId);

	const owner = ownerFilter(locals);
	if (
		(await collections.customModels.countDocuments(owner as never)) >= CUSTOM_MODEL_MAX_PER_OWNER
	) {
		error(400, `You can keep up to ${CUSTOM_MODEL_MAX_PER_OWNER} custom models.`);
	}
	const nameKey = name.toLowerCase();
	if (await collections.customModels.findOne({ ...owner, nameKey } as never)) {
		error(409, "You already have a custom model with that name.");
	}

	const now = new Date();
	const row: CustomModel = {
		_id: new ObjectId(),
		...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
		name,
		nameKey,
		baseModelId,
		systemPrompt,
		...(description ? { description } : {}),
		createdAt: now,
		updatedAt: now,
	};
	try {
		await collections.customModels.insertOne(row);
	} catch (err) {
		if (isDuplicateKey(err)) error(409, "You already have a custom model with that name.");
		throw err;
	}
	return json({ data: customModelView(row) }, { status: 201 });
};
