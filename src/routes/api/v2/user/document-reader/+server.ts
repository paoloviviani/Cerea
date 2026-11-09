/**
 * A user's default document reader for chat uploads (backlog C97).
 *
 * The reader is a gateway OCR model this user may use; unset follows the
 * deployment's default (the administrator's, on the Knowledge screen). It has
 * its own route rather than riding the settings save: that one rewrites the
 * whole settings document from the client store, and a reader nobody may use
 * must be refused (400) when it is chosen, not when an unrelated setting is
 * saved later.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { userDocumentReader } from "$lib/server/files/userReader";

export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	const { readerModelsFor } = await import("$lib/server/knowledge/readers");
	const { resolveExtractorModel } = await import("$lib/server/files/extractDocument");
	const models = await readerModelsFor(locals.token);
	return json({
		reader_model: (await userDocumentReader(locals))?.model ?? null,
		reader_models: (models ?? []).map((model) => model.id),
		reader_default: locals.token
			? await resolveExtractorModel(locals.token).catch(() => null)
			: null,
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	const body = (await request.json().catch(() => null)) as { reader_model?: unknown } | null;
	if (!body || (body.reader_model !== null && typeof body.reader_model !== "string")) {
		error(400, "Expected { reader_model: string | null }.");
	}
	const { validateReader, KnowledgeError } = await import("$lib/server/knowledge/service");
	let reader: { model: string; local: boolean } | null;
	try {
		reader = await validateReader(body.reader_model, locals.token);
	} catch (err) {
		if (err instanceof KnowledgeError) error(err.status, err.message);
		throw err;
	}
	await collections.settings.updateOne(
		authCondition(locals),
		reader
			? {
					$set: {
						documentReader: reader.model,
						documentReaderLocal: reader.local,
						updatedAt: new Date(),
					},
					$setOnInsert: { createdAt: new Date() },
				}
			: {
					$unset: { documentReader: "", documentReaderLocal: "" },
					$set: { updatedAt: new Date() },
				},
		{ upsert: Boolean(reader) }
	);
	return json({ reader_model: reader?.model ?? null });
};
