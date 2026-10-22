import { config } from "$lib/server/config";

/**
 * Server-side transcription needs a model and the endpoint that serves it.
 * There is no default endpoint: a person's token goes to whatever
 * `TRANSCRIPTION_BASE_URL` names, so naming it is the operator's decision, and
 * a model alone enables nothing.
 */
export function transcriptionBaseUrl(): string | undefined {
	const base = String(config.get("TRANSCRIPTION_BASE_URL") ?? "")
		.trim()
		.replace(/\/+$/, "");
	return base || undefined;
}

export function transcriptionEnabled(): boolean {
	return Boolean(config.get("TRANSCRIPTION_MODEL")) && transcriptionBaseUrl() !== undefined;
}
