/**
 * The document readers a caller may use: the gateway's OCR models, listed for
 * their own token. Kept apart from `service.ts` so the extraction path can ask
 * without importing the whole knowledge service.
 */
import { gateway } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";

export interface ReaderModel {
	id: string;
	/** `ModelCard.local`: this deployment's own extractor (a built-in engine). */
	local: boolean;
}

/**
 * `GET /v1/models?include=ocr` filtered to `kind: "ocr"`, used as listed: the
 * built-in extractor's engines and remote OCR models alike, no hints added.
 * `null` when the catalogue could not be read (no token, gateway down).
 */
export async function readerModelsFor(token: string | undefined): Promise<ReaderModel[] | null> {
	if (!token) return null;
	try {
		const models = await gateway.get<{
			data: { id: string; kind?: string; local?: boolean }[];
		}>(token, "models?include=ocr");
		return models.data
			.filter((model) => model.kind === "ocr")
			.map((model) => ({ id: model.id, local: model.local === true }));
	} catch (err) {
		logger.warn({ err }, "knowledge_reader_models_probe_failed");
		return null;
	}
}
