import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { customModelView, findCustomModel, ownerFilter } from "$lib/server/customModels";
import { defaultModel, models } from "$lib/server/models";
import { customModelId } from "$lib/utils/customModelId";
import { assertBaseModel, customModelFields, isDuplicateKey } from "$lib/server/customModelApi";

/**
 * Every handler looks the row up through the caller's own owner filter, so
 * somebody else's id is indistinguishable from one that does not exist: 404,
 * never 403, which would confirm it is there.
 */
async function owned(locals: App.Locals, id: string | undefined) {
	requireAuth(locals);
	const row = await findCustomModel(ownerFilter(locals), id);
	if (!row) error(404, "Custom model not found.");
	return row;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	return json({ data: customModelView(await owned(locals, params.id)) });
};

const patch = z
	.object({
		name: customModelFields.name,
		baseModelId: customModelFields.baseModelId,
		systemPrompt: customModelFields.systemPrompt,
		// Empty or null clears it.
		description: customModelFields.description,
	})
	.partial();

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const row = await owned(locals, params.id);
	const parsed = patch.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That custom model is not valid.");
	}
	const { name, baseModelId, systemPrompt, description } = parsed.data;
	// Re-checked only when it changes: a base that has since left the catalogue
	// must not stop somebody renaming the model or editing its prompt.
	if (baseModelId !== undefined && baseModelId !== row.baseModelId) {
		await assertBaseModel(locals, baseModelId);
	}
	const owner = ownerFilter(locals);
	if (name !== undefined && name.toLowerCase() !== row.nameKey) {
		const clash = await collections.customModels.findOne({
			...owner,
			nameKey: name.toLowerCase(),
			_id: { $ne: row._id },
		} as never);
		if (clash) error(409, "You already have a custom model with that name.");
	}

	const $set: Record<string, unknown> = { updatedAt: new Date() };
	const $unset: Record<string, ""> = {};
	if (name !== undefined) {
		$set.name = name;
		$set.nameKey = name.toLowerCase();
	}
	if (baseModelId !== undefined) $set.baseModelId = baseModelId;
	if (systemPrompt !== undefined) $set.systemPrompt = systemPrompt;
	if (description !== undefined) {
		if (description) $set.description = description;
		else $unset.description = "";
	}
	try {
		await collections.customModels.updateOne(
			{ _id: row._id, ...owner } as never,
			Object.keys($unset).length ? { $set, $unset } : { $set }
		);
	} catch (err) {
		if (isDuplicateKey(err)) error(409, "You already have a custom model with that name.");
		throw err;
	}
	const updated = await findCustomModel(owner, params.id);
	if (!updated) error(404, "Custom model not found.");
	return json({ data: customModelView(updated) });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const row = await owned(locals, params.id);
	const owner = ownerFilter(locals);
	const id = customModelId(row._id.toString());
	await collections.customModels.deleteOne({ _id: row._id, ...owner } as never);

	// What was on it moves to its base, so a conversation keeps working and the
	// picker shows the base rather than an id nothing can resolve. A base that
	// has itself left the catalogue falls to the deployment default.
	const fallback = models.some((m) => m.id === row.baseModelId)
		? row.baseModelId
		: defaultModel?.id;
	if (fallback) {
		await collections.conversations.updateMany({ ...owner, model: id } as never, {
			$set: { model: fallback },
		});
		await collections.settings.updateOne({ ...owner, activeModel: id } as never, {
			$set: { activeModel: fallback },
		});
	}
	return new Response(null, { status: 204 });
};
