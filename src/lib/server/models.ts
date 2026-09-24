import { building } from "$app/environment";
import { config } from "$lib/server/config";
import type { ChatTemplateInput } from "$lib/types/Template";
import { z } from "zod";
import endpoints, { endpointSchema, type Endpoint } from "./endpoints/endpoints";

import JSON5 from "json5";
import { setMlAssistantCatalog } from "./mlAssistantModels";
import { logger } from "$lib/server/logger";
import { preservesReasoningByDefault } from "$lib/server/reasoningPolicy";
import { makeRouterEndpoint } from "$lib/server/router/endpoint";

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

const sanitizeJSONEnv = (val: string, fallback: string) => {
	const raw = (val ?? "").trim();
	const unquoted = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw;
	return unquoted || fallback;
};

const modelConfig = z.object({
	/** Used as an identifier in DB */
	id: z.string().optional(),
	/** Used to link to the model page, and for inference */
	name: z.string().default(""),
	displayName: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
	logoUrl: z.string().url().optional(),
	websiteUrl: z.string().url().optional(),
	modelUrl: z.string().url().optional(),
	tokenizer: z.never().optional(),
	datasetName: z.string().min(1).optional(),
	datasetUrl: z.string().url().optional(),
	preprompt: z.string().default(""),
	prepromptUrl: z.string().url().optional(),
	chatPromptTemplate: z.never().optional(),
	promptExamples: z
		.array(
			z.object({
				title: z.string().min(1),
				prompt: z.string().min(1),
			})
		)
		.optional(),
	endpoints: z.array(endpointSchema).optional(),
	providers: z
		.array(
			z
				.object({
					supports_tools: z.boolean().optional(),
					context_length: z.number().int().positive().optional(),
				})
				.passthrough()
		)
		.optional(),
	/**
	 * Context window in tokens, aggregated across providers. Used to bound how
	 * much conversation history is sent; absent when no provider reports one.
	 */
	contextLength: z.number().int().positive().optional(),
	parameters: z
		.object({
			temperature: z.number().min(0).max(2).optional(),
			truncate: z.number().int().positive().optional(),
			max_tokens: z.number().int().positive().optional(),
			stop: z.array(z.string()).optional(),
			top_p: z.number().positive().optional(),
			top_k: z.number().positive().optional(),
			frequency_penalty: z.number().min(-2).max(2).optional(),
			presence_penalty: z.number().min(-2).max(2).optional(),
		})
		.passthrough()
		.optional(),
	multimodal: z.boolean().default(false),
	multimodalAcceptedMimetypes: z.array(z.string()).optional(),
	// Aggregated tool-calling capability across providers (HF router)
	supportsTools: z.boolean().default(false),
	// Reasoning-capable model (accepts `reasoning_effort` parameter). Drives the
	// Thinking-effort control only — whether prior reasoning is echoed back is
	// `preservesReasoning`, which defaults on and is derived, not opted into.
	supportsReasoning: z.boolean().default(false),
	/**
	 * Whether the model may be sent its own prior reasoning back. Derived from
	 * the id (see reasoningPolicy.ts) when the config says nothing; an explicit
	 * entry here wins, so a backend needing the opposite can say so per model.
	 */
	preservesReasoning: z.boolean().optional(),
	// Opt-in artifacts: when true, the model is instructed to emit <artifact>
	// blocks rendered in the side panel. Set per model via MODELS overrides.
	supportsArtifacts: z.boolean().default(false),
	/**
	 * Which artifact surface the model uses once artifacts are enabled for the
	 * turn: the `artifact` tool, or inline `<artifact>` tags. Absent means the
	 * default — `"tool"` when the model also supports tools, else `"tags"`.
	 * Set per model via MODELS overrides; presets may override per turn.
	 */
	artifactsMode: z.enum(["tool", "tags"]).optional(),
	unlisted: z.boolean().default(false),
	embeddingModel: z.never().optional(),
	/** Used to enable/disable system prompt usage */
	systemRoleSupported: z.boolean().default(true),
});

type ModelConfig = z.infer<typeof modelConfig>;

const overrideEntrySchema = modelConfig
	.partial()
	.extend({
		id: z.string().optional(),
		name: z.string().optional(),
	})
	.refine((value) => Boolean((value.id ?? value.name)?.trim()), {
		message: "Model override entry must provide an id or name",
	});

type ModelOverride = z.infer<typeof overrideEntrySchema>;

const openaiBaseUrl = config.OPENAI_BASE_URL
	? config.OPENAI_BASE_URL.replace(/\/$/, "")
	: undefined;
const isHFRouter = openaiBaseUrl === "https://router.huggingface.co/v1";

const listSchema = z
	.object({
		data: z.array(
			z.object({
				id: z.string(),
				description: z.string().optional(),
				// Pystino reports what surface a model serves. Absent on a
				// generic OpenAI-compatible endpoint, which is why the filter
				// below treats missing as chat rather than as unusable.
				kind: z.string().optional(),
				providers: z
					.array(
						z
							.object({
								supports_tools: z.boolean().optional(),
								context_length: z.number().int().positive().optional(),
							})
							.passthrough()
					)
					.optional(),
				architecture: z
					.object({
						input_modalities: z.array(z.string()).optional(),
					})
					.passthrough()
					.optional(),
				// Pystino's own, flat and per model (ADR 0031). `supported_features`
				// is deliberately an open set of strings rather than a boolean per
				// feature, so this is matched by membership.
				input_modalities: z.array(z.string()).optional(),
				output_modalities: z.array(z.string()).optional(),
				supported_features: z.array(z.string()).optional(),
			})
		),
	})
	.passthrough();

function getChatPromptRender(_m: ModelConfig): (inputs: ChatTemplateInput) => string {
	// Minimal template to support legacy "completions" flow if ever used.
	// We avoid any tokenizer/Jinja usage in this build.
	return ({ messages, preprompt }) => {
		const parts: string[] = [];
		if (preprompt) parts.push(`[SYSTEM]\n${preprompt}`);
		for (const msg of messages) {
			const role = msg.from === "assistant" ? "ASSISTANT" : msg.from.toUpperCase();
			parts.push(`[${role}]\n${msg.content}`);
		}
		parts.push(`[ASSISTANT]`);
		return parts.join("\n\n");
	};
}

const processModel = async (m: ModelConfig) => ({
	...m,
	chatPromptRender: await getChatPromptRender(m),
	id: m.id || m.name,
	displayName: m.displayName || m.name,
	preprompt: m.prepromptUrl ? await fetch(m.prepromptUrl).then((r) => r.text()) : m.preprompt,
	parameters: { ...m.parameters, stop_sequences: m.parameters?.stop },
	unlisted: m.unlisted ?? false,
});

const addEndpoint = (m: Awaited<ReturnType<typeof processModel>>) => ({
	...m,
	getEndpoint: async (): Promise<Endpoint> => {
		if (!m.endpoints || m.endpoints.length === 0) {
			throw new Error("No endpoints configured. This build requires OpenAI-compatible endpoints.");
		}
		// Only support OpenAI-compatible endpoints in this build
		const endpoint = m.endpoints[0];
		if (endpoint.type !== "openai") {
			throw new Error("Only 'openai' endpoint type is supported in this build");
		}
		return await endpoints.openai({ ...endpoint, model: m });
	},
});

type InternalProcessedModel = Awaited<ReturnType<typeof addEndpoint>> & {
	isRouter: boolean;
	hasInferenceAPI: boolean;
};

const inferenceApiIds: string[] = [];

const getModelOverrides = (): ModelOverride[] => {
	const overridesEnv = (Reflect.get(config, "MODELS") as string | undefined) ?? "";

	if (!overridesEnv.trim()) {
		return [];
	}

	try {
		return z.array(overrideEntrySchema).parse(JSON5.parse(sanitizeJSONEnv(overridesEnv, "[]")));
	} catch (error) {
		logger.error(error, "[models] Failed to parse MODELS overrides");
		return [];
	}
};

export type ProcessedModel = InternalProcessedModel;

export let models: ProcessedModel[] = [];
export let defaultModel: ProcessedModel | undefined = undefined;
export let taskModel: ProcessedModel | undefined = undefined;
export let validModelIdSchema: z.ZodType<string> = z.string();

const createValidModelIdSchema = (modelList: ProcessedModel[]): z.ZodType<string> => {
	// Empty catalogue: accept any string rather than reject everything. With
	// no ids to validate against, a refine() would refuse the model a
	// conversation is already on — but there are no conversations to serve
	// yet either, and the point of this state is to *boot* while the operator
	// has not added a provider. The first successful publish rebuilds the
	// schema into a real membership check.
	if (modelList.length === 0) {
		return z.string();
	}
	const ids = new Set(modelList.map((m) => m.id));
	return z.string().refine((value) => ids.has(value), "Invalid model id");
};

const resolveTaskModel = (modelList: ProcessedModel[]): ProcessedModel | undefined => {
	// Undefined, not a throw: a deployment whose gateway holds no chat model
	// yet still boots (the operator adds one through the console, and the
	// TTL refresh picks it up). A caller reaching for taskModel with no
	// catalogue has nothing to generate with and reports that — which is the
	// honest answer, not a boot failure.
	if (modelList.length === 0) {
		return undefined;
	}

	if (config.TASK_MODEL) {
		const preferred = modelList.find(
			(m) => m.name === config.TASK_MODEL || m.id === config.TASK_MODEL
		);
		if (preferred) {
			return preferred;
		}
	}

	return modelList[0];
};

const buildModels = async (): Promise<ProcessedModel[]> => {
	if (!openaiBaseUrl) {
		logger.error(
			"OPENAI_BASE_URL is required. Set it to an OpenAI-compatible base (e.g., https://router.huggingface.co/v1)."
		);
		throw new Error("OPENAI_BASE_URL not set");
	}

	try {
		const baseURL = openaiBaseUrl;
		logger.info({ baseURL }, "[models] Using OpenAI-compatible base URL");

		// Canonical auth token is OPENAI_API_KEY; keep HF_TOKEN as legacy alias
		const authToken = config.OPENAI_API_KEY || config.HF_TOKEN;

		// Use auth token from the start if available to avoid rate limiting issues
		// Some APIs rate-limit unauthenticated requests more aggressively
		const response = await fetch(`${baseURL}/models`, {
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
		});
		logger.info({ status: response.status }, "[models] First fetch status");
		if (!response.ok && response.status === 401 && !authToken) {
			// If we get 401 and didn't have a token, there's nothing we can do
			throw new Error(
				`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText} (no auth token available)`
			);
		}
		if (!response.ok) {
			throw new Error(
				`Failed to fetch ${baseURL}/models: ${response.status} ${response.statusText}`
			);
		}
		const json = await response.json();
		logger.info({ keys: Object.keys(json || {}) }, "[models] Response keys");

		const parsed = listSchema.parse(json);
		logger.info({ count: parsed.data.length }, "[models] Parsed models count");

		// Only models that can serve a chat completion.
		//
		// A gateway may expose surfaces this application does not speak. Pystino
		// serves OCR at /v1/ocr, images at /v1/images and embeddings at
		// /v1/embeddings, and lists them all in /v1/models with a `kind`. Offering
		// one in the model picker produces a chat that can never work: the gateway
		// answers `400 'local-documents' is an ocr model. Use /v1/ocr for it.`,
		// which is correct and permanent — so "Retry" cannot help, and the message
		// reads like an outage.
		//
		// Absent `kind` means chat, because a plain OpenAI-compatible endpoint does
		// not send one and every model it lists is a chat model. Filtering on a
		// field that may not exist must not empty the catalogue.
		const CHAT_KINDS = new Set(["chat", "text", "completion", "completions"]);
		const serves = parsed.data.filter((m) => !m.kind || CHAT_KINDS.has(m.kind.toLowerCase()));
		const skipped = parsed.data.length - serves.length;
		if (skipped > 0) {
			logger.info(
				{
					skipped,
					kinds: [...new Set(parsed.data.filter((m) => !serves.includes(m)).map((m) => m.kind))],
				},
				"[models] Skipped models that do not serve chat completions"
			);
		}

		let modelsRaw = serves.map((m) => {
			let logoUrl: string | undefined = undefined;
			if (isHFRouter && m.id.includes("/")) {
				const org = m.id.split("/")[0];
				logoUrl = `https://huggingface.co/api/avatars/${encodeURIComponent(org)}`;
			}

			// Gateway first, then the HuggingFace router's nested shape. A
			// deployment has one or the other, never both, and reading only the
			// HF shape is why a gateway's models all reported no capabilities.
			const inputModalities = [
				...(m.input_modalities ?? []),
				...(m.architecture?.input_modalities ?? []),
			].map((modality) => modality.toLowerCase());
			const features = (m.supported_features ?? []).map((feature) => feature.toLowerCase());

			const supportsImageInput =
				inputModalities.includes("image") || inputModalities.includes("vision");

			// The gateway says so per model; on the HF router, any provider
			// supporting tools makes the model tool-capable.
			const supportsTools =
				features.includes("tools") ||
				Boolean((m.providers ?? []).some((p) => p?.supports_tools === true));

			const supportsReasoning = features.includes("reasoning");
			// Smallest window any provider offers, not the largest: with
			// `provider: "auto"` the router picks, so a request sized for the
			// roomiest provider would overflow whichever one actually serves it.
			const reportedContexts = (m.providers ?? [])
				.map((p) => p?.context_length)
				.filter((n): n is number => typeof n === "number" && n > 0);
			const contextLength = reportedContexts.length ? Math.min(...reportedContexts) : undefined;
			return {
				id: m.id,
				name: m.id,
				displayName: m.id,
				description: m.description,
				logoUrl,
				providers: m.providers,
				contextLength,
				// Derived, not opted into: see reasoningPolicy.ts. A MODELS override
				// with an explicit value replaces this in the merge below.
				preservesReasoning: preservesReasoningByDefault(m.id),
				multimodal: supportsImageInput,
				multimodalAcceptedMimetypes: supportsImageInput ? ["image/*"] : undefined,
				supportsTools,
				supportsReasoning,
				endpoints: [
					{
						type: "openai" as const,
						baseURL,
						// apiKey will be taken from OPENAI_API_KEY or HF_TOKEN automatically
					},
				],
			} as ModelConfig;
		}) as ModelConfig[];

		const overrides = getModelOverrides();

		if (overrides.length) {
			const overrideMap = new Map<string, ModelOverride>();
			for (const override of overrides) {
				for (const key of [override.id, override.name]) {
					const trimmed = key?.trim();
					if (trimmed) overrideMap.set(trimmed, override);
				}
			}

			modelsRaw = modelsRaw.map((model) => {
				const override = overrideMap.get(model.id ?? "") ?? overrideMap.get(model.name ?? "");
				if (!override) return model;

				const { id, name, ...rest } = override;
				void id;
				void name;

				return {
					...model,
					...rest,
				};
			});
		}

		const builtModels = await Promise.all(
			modelsRaw.map((e) =>
				processModel(e)
					.then(addEndpoint)
					.then(async (m) => ({
						...m,
						hasInferenceAPI: inferenceApiIds.includes(m.id ?? m.name),
						// router decoration added later
						isRouter: false as boolean,
					}))
			)
		);

		const routerRoutesPath = (config.LLM_ROUTER_ROUTES_PATH || "").trim();
		const routerLabel = (config.PUBLIC_LLM_ROUTER_DISPLAY_NAME || "Omni").trim() || "Omni";
		const routerLogo = (config.PUBLIC_LLM_ROUTER_LOGO_URL || "").trim();
		const routerAliasId = (config.PUBLIC_LLM_ROUTER_ALIAS_ID || "omni").trim() || "omni";
		const routerMultimodalEnabled =
			(config.LLM_ROUTER_ENABLE_MULTIMODAL || "").toLowerCase() === "true";
		const routerToolsEnabled = (config.LLM_ROUTER_ENABLE_TOOLS || "").toLowerCase() === "true";

		let decorated = builtModels as ProcessedModel[];

		if (routerRoutesPath) {
			// Build a minimal model config for the alias
			const aliasRaw = {
				id: routerAliasId,
				name: routerAliasId,
				displayName: routerLabel,
				description: "Automatically routes your messages to the best model for your request.",
				logoUrl: routerLogo || undefined,
				preprompt: "",
				endpoints: [
					{
						type: "openai" as const,
						baseURL: openaiBaseUrl,
					},
				],
				// Keep the alias visible
				unlisted: false,
			} as ModelConfig;

			if (routerMultimodalEnabled) {
				aliasRaw.multimodal = true;
				aliasRaw.multimodalAcceptedMimetypes = ["image/*"];
			}

			if (routerToolsEnabled) {
				aliasRaw.supportsTools = true;
			}

			// Apply MODELS overrides to the router alias too, so flags like
			// supportsArtifacts can be set on it like on any other model
			const aliasOverride = getModelOverrides().find(
				(o) => o.id?.trim() === routerAliasId || o.name?.trim() === routerAliasId
			);
			if (aliasOverride) {
				const { id, name, ...rest } = aliasOverride;
				void id;
				void name;
				Object.assign(aliasRaw, rest);
			}

			const aliasBase = await processModel(aliasRaw);
			// Create a self-referential ProcessedModel for the router endpoint
			const aliasModel: ProcessedModel = {
				...aliasBase,
				isRouter: true,
				hasInferenceAPI: false,
				// getEndpoint uses the router wrapper regardless of the endpoints array
				getEndpoint: async (): Promise<Endpoint> => makeRouterEndpoint(aliasModel),
			} as ProcessedModel;

			// Put alias first
			decorated = [aliasModel, ...decorated];
		}

		return decorated;
	} catch (e) {
		logger.error(e, "Failed to load models from OpenAI base URL");
		throw e;
	}
};

/**
 * Rebuild the catalogue and publish it.
 *
 * `models`, `defaultModel`, `taskModel` and `validModelIdSchema` are
 * `export let`, and ESM exports are *live bindings* — reassigning them here is
 * seen by every module that imported them. That is what makes a refresh
 * possible at all without touching the twenty files that import `models`.
 *
 * **A failed rebuild keeps the catalogue that is in force.** The old list is
 * stale, and stale is very much better than empty: emptying it would take every
 * model away from every user, turn `defaultModel` undefined, and make
 * `validModelIdSchema` reject the model the conversation is already on. A
 * gateway blip must not do that.
 */
const publishModels = async (): Promise<void> => {
	const startedAt = Date.now();
	const newModels = await buildModels();

	// An empty catalogue is published, not thrown: the operator's own
	// provider decision ("providers are console-only") means a fresh
	// install legitimately answers zero chat models, and the chat dying in
	// a crash loop until someone opens the console takes the sign-in page
	// down with it — the console is the way to fix it. The TTL refresh
	// picks the catalogue up the moment a model appears. Unchanged: a
	// *fetch failure* still throws, here and at startup — an unreachable
	// gateway is a real outage, and this state must not swallow it.
	models = newModels;
	setMlAssistantCatalog(() => models.map((model) => ({ id: model.id, isRouter: model.isRouter })));
	defaultModel = models[0];
	taskModel = resolveTaskModel(models);
	validModelIdSchema = createValidModelIdSchema(models);
	builtAt = Date.now();

	logger.info(
		{ total: models.length, durationMs: Date.now() - startedAt },
		"[models] Model cache built"
	);
};

let builtAt = 0;
let rebuilding: Promise<void> | null = null;

/**
 * How long a catalogue is trusted before the next read rebuilds it.
 *
 * A minute rather than seconds: the rebuild costs one request to the gateway
 * plus the override merge, and the list changes hourly at most. Rebuilding
 * per request would put a round trip in front of every page load.
 */
const MODEL_TTL_MS = 60_000;

/**
 * The catalogue, rebuilt if it has gone stale.
 *
 * Concurrent callers share one rebuild: without the in-flight promise, a burst
 * of page loads after the TTL expires would each start their own fetch and the
 * last to finish would win, which is both wasteful and a way to publish an
 * older answer than one already published.
 *
 * Callers that simply want to *read* the catalogue should keep importing
 * `models` directly. This exists for the paths that must not miss something
 * created a moment ago — listing what a person may choose, and resolving what
 * they just chose.
 */
export const ensureModelsFresh = async (): Promise<ProcessedModel[]> => {
	if (building) return models;
	if (Date.now() - builtAt < MODEL_TTL_MS) return models;
	if (!rebuilding) {
		rebuilding = publishModels()
			.catch((error) => {
				// Deliberately swallowed: see `publishModels`. Logged once per
				// failed attempt rather than per waiting caller.
				logger.warn(error, "[models] Refresh failed; keeping the catalogue in force");
				// Back off for a full TTL rather than retrying on every request
				// while the gateway is down.
				builtAt = Date.now();
			})
			.finally(() => {
				rebuilding = null;
			});
	}
	await rebuilding;
	return models;
};

// Skip the initial fetch during `vite build`: SvelteKit's analyse phase imports this
// module, and hitting the live router from CI builds fails on rate limits (429).
//
// The startup build still throws when the gateway is unreachable (a worker
// that cannot talk to its backend is down, loudly), but an empty catalogue is
// not that: it publishes empty and the TTL refresh heals it the minute the
// operator adds a provider through the console — the console the chat must be
// up to serve.
if (!building) {
	await publishModels();
}

export const validateModel = (_models: BackendModel[]) => {
	// Empty catalogue: same rule as `createValidModelIdSchema` above — accept
	// any string rather than crash building the enum (`z.enum` needs at least
	// one value, and `_models[0]` doesn't exist to give it one).
	if (_models.length === 0) {
		return z.string();
	}
	// Zod enum function requires 2 parameters
	return z.enum([_models[0].id, ..._models.slice(1).map((m) => m.id)]);
};

// if `TASK_MODEL` is string & name of a model in `MODELS`, then we use `MODELS[TASK_MODEL]`, else we try to parse `TASK_MODEL` as a model config itself

// Built from `ProcessedModel` directly, not `typeof defaultModel`: this
// describes the shape of an actual model object (what a route gets back after
// finding/asserting one), not the "maybe nothing yet" state of the
// `defaultModel` binding — deriving it from that union fed `Optional`'s
// `Pick`/`Omit` a `T` TypeScript couldn't resolve, and every consumer of
// `BackendModel` (buildPrompt, endpoints, the conversation routes) saw
// `{}`/`never` instead of real fields once `defaultModel` gained `| undefined`.
export type BackendModel = Optional<
	ProcessedModel,
	"preprompt" | "parameters" | "multimodal" | "unlisted" | "hasInferenceAPI"
>;
