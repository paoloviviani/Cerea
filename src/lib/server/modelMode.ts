import JSON5 from "json5";

/**
 * Cerea runs in exactly one of two modes towards its model endpoint, and never
 * a mix of them (issue #16).
 *
 * - **Pystino mode**: `USE_USER_TOKEN=true`. Every call carries the signed-in
 *   person's own token, to the Pystino gateway at `OPENAI_BASE_URL` and nowhere
 *   else. No shared key exists, and no model may point at another endpoint.
 * - **Standalone mode**: `USE_USER_TOKEN` unset or not `true`. One
 *   OpenAI-compatible endpoint, one shared key, no personal tokens.
 *
 * `USE_USER_TOKEN` already decides every request's credential (`apiToken.ts`,
 * `endpointOai.ts`), so it is also what names the mode: no second setting that
 * could disagree with it.
 *
 * A mix either bypasses the gateway's per-person access, billing and redaction
 * (a model with its own endpoint, or a shared key beside personal tokens), or
 * hides models people are entitled to (a shared key used for the boot
 * catalogue while requests carry personal tokens). So the chat refuses to
 * start, and every message names the setting to change.
 */

export type ModelMode = "pystino" | "standalone";

export interface ModelModeInput {
	OPENAI_BASE_URL?: string | null;
	OPENAI_API_KEY?: string | null;
	/** Legacy alias of OPENAI_API_KEY: a shared key all the same. */
	HF_TOKEN?: string | null;
	USE_USER_TOKEN?: string | null;
	MODELS?: string | null;
}

export const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};

export const isPystinoMode = (input: Pick<ModelModeInput, "USE_USER_TOKEN">): boolean =>
	input.USE_USER_TOKEN === "true";

const normaliseUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** The shared key's setting name, or undefined when none is set. */
export const sharedKeySetting = (input: ModelModeInput): string | undefined => {
	if (input.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
	if (input.HF_TOKEN?.trim()) return "HF_TOKEN";
	return undefined;
};

type RawEndpoint = { baseURL?: unknown; apiKey?: unknown };

/** The endpoints each MODELS entry names. A MODELS value that does not parse is left to models.ts, which logs it. */
function overrideEndpoints(models: string | null | undefined) {
	if (!models?.trim()) return [];
	let parsed: unknown;
	try {
		parsed = JSON5.parse(sanitizeJSONEnv(models, "[]"));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: { model: string; endpoint: RawEndpoint }[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { id?: unknown; name?: unknown; endpoints?: unknown };
		const model = String(e.id ?? e.name ?? "").trim() || "(unnamed)";
		if (!Array.isArray(e.endpoints)) continue;
		for (const endpoint of e.endpoints) {
			if (endpoint && typeof endpoint === "object") out.push({ model, endpoint });
		}
	}
	return out;
}

/**
 * Decide the mode from the settings, or throw naming the one to change. Pure:
 * called once at boot (`models.ts`, `initServer`).
 */
export function assertModelModeValid(input: ModelModeInput): ModelMode {
	const key = sharedKeySetting(input);

	if (!isPystinoMode(input)) {
		// Standalone: personal tokens are off by definition, so there is nothing
		// to refuse here. A MODELS override may name any endpoint.
		return "standalone";
	}

	const gateway = input.OPENAI_BASE_URL?.trim() ? normaliseUrl(input.OPENAI_BASE_URL) : undefined;
	if (!gateway) {
		throw new Error(
			"USE_USER_TOKEN=true (Pystino mode) needs a gateway to present each person's token to, but OPENAI_BASE_URL is not set. " +
				"Set OPENAI_BASE_URL to the gateway's /v1, or, for a standalone endpoint with one shared key, remove USE_USER_TOKEN (CHAT_USE_USER_TOKEN in the kit) and set OPENAI_API_KEY."
		);
	}

	if (key) {
		throw new Error(
			`${key} is set while USE_USER_TOKEN=true. Pystino mode uses each person's own token and no shared key: ` +
				`a shared key would bypass per-person access, billing and redaction, or hide models people may use. ` +
				`Empty ${key} (CHAT_OPENAI_API_KEY in the kit), or, for a standalone endpoint with one shared key, set USE_USER_TOKEN=false (CHAT_USE_USER_TOKEN).`
		);
	}

	for (const { model, endpoint } of overrideEndpoints(input.MODELS)) {
		// Not given means the endpoint schema's default, api.openai.com: a direct
		// provider connection all the same.
		const base = typeof endpoint.baseURL === "string" ? normaliseUrl(endpoint.baseURL) : undefined;
		if (base !== gateway) {
			throw new Error(
				`MODELS gives the model "${model}" its own endpoint (${base ?? "no baseURL, which defaults to https://api.openai.com/v1"}), not the gateway (${gateway}). ` +
					`In Pystino mode every model goes through the gateway, so that connection would bypass per-person access, billing and redaction. ` +
					`Remove "endpoints" from that MODELS entry, or add the model to the gateway instead.`
			);
		}
		if (typeof endpoint.apiKey === "string" && endpoint.apiKey.trim()) {
			throw new Error(
				`MODELS gives the model "${model}" its own apiKey. Pystino mode uses each person's own token and no shared key. Remove "apiKey" from that MODELS entry.`
			);
		}
	}

	return "pystino";
}
