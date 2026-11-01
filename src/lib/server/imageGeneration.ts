/**
 * Image generation through the gateway: `POST /v1/images/generations` as the
 * signed-in user, metered per image with their token (model access groups and
 * bill-to apply as for any other call). The `generate_image` builtin uses it.
 *
 * Which model: the administrator's choice (Administration -> Assistant ->
 * Images), else `CHAT_IMAGE_MODEL`, else the first `kind: image` model the user
 * may use (`resolveImageModel`), the order transcription uses.
 *
 * Results are stored as produced files (`storeDeliverable`), so they list,
 * download and mount in the sandbox like any other file the assistant makes.
 * The request asks for `b64_json`. A provider that answers with a URL anyway is
 * followed: fetched server-side through `contentFetch` (the same guard as
 * `web_fetch`: no private or internal addresses, redirects re-checked), capped
 * at `MAX_IMAGE_BYTES`, and kept only when the bytes really are a raster image.
 */

import { createHash } from "node:crypto";
import type { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { gateway, GatewayCallFailed, GatewayTimeout } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";
import { contentFetch } from "$lib/server/urlSafety";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";
import type { BuiltinToolImage } from "$lib/server/textGeneration/builtinTools/types";

/** Past this the catalogue probe gives up and the tool stays off; the page does not wait. */
export const IMAGE_CATALOGUE_TIMEOUT_MS = 2000;
/** One generation, however many images, may take this long. */
export const IMAGE_TIMEOUT_MS = 120_000;
/** Images a turn may generate, across all its calls. */
export const MAX_IMAGES_GENERATED_PER_TURN = 4;
/** The largest single image kept, whether it arrived inline or by URL. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** The longest prompt sent. */
export const MAX_IMAGE_PROMPT_CHARS = 4000;

export const IMAGE_SIZES = [
	"512x512",
	"1024x1024",
	"1344x768",
	"768x1344",
	"1024x768",
	"768x1024",
] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];
export const DEFAULT_IMAGE_SIZE: ImageSize = "1024x1024";
export const IMAGE_ASPECTS = {
	square: "1024x1024",
	landscape: "1344x768",
	portrait: "768x1344",
} as const;

// -- which model --------------------------------------------------------------

export type ImageModelSource = "stored" | "env" | "first-available" | "none";

export interface ImageModelResolution {
	model: string | null;
	source: ImageModelSource;
}

/** The order, in one place: the admin's choice, then the env value, then the first model. */
export function resolveImage(options: {
	storedModel: string | null;
	envModel: string | null;
	candidates: string[];
}): ImageModelResolution {
	const { storedModel, envModel, candidates } = options;
	if (storedModel) return { model: storedModel, source: "stored" };
	if (envModel) return { model: envModel, source: "env" };
	if (candidates[0]) return { model: candidates[0], source: "first-available" };
	return { model: null, source: "none" };
}

export function envImageModel(): string | null {
	return config.CHAT_IMAGE_MODEL?.trim() || null;
}

export async function storedImageModel(): Promise<string | null> {
	const doc = await collections.imageConfig.findOne({});
	return doc?.model?.trim() || null;
}

/** Whether the administrator wants an approval card before each generation. */
export async function imageAskFirst(): Promise<boolean> {
	try {
		return (await collections.imageConfig.findOne({}))?.askFirst === true;
	} catch (err) {
		// Fails closed: an unreadable switch asks, rather than spending without leave.
		logger.warn({ err }, "image_config_unreadable");
		return true;
	}
}

export async function writeImageConfig(patch: {
	model?: string | null;
	askFirst?: boolean;
}): Promise<void> {
	await collections.imageConfig.updateOne(
		{},
		{ $set: { ...patch, updatedAt: new Date() } },
		{ upsert: true }
	);
}

/**
 * The `kind: image` models this token may use, straight from the gateway, and
 * whether the gateway answered (an empty list with `reachable` true means
 * "none granted to you", not "could not ask").
 */
export async function probeImageModels(
	token: string
): Promise<{ models: string[]; reachable: boolean; configured: boolean }> {
	if (!config.OPENAI_BASE_URL) return { models: [], reachable: false, configured: false };
	try {
		const answer = await gateway.get<{ data: { id: string; kind?: string }[] }>(
			token,
			"models?include=image",
			{ timeoutMs: IMAGE_CATALOGUE_TIMEOUT_MS }
		);
		return {
			models: answer.data.filter((card) => card.kind === "image").map((card) => card.id),
			reachable: true,
			configured: true,
		};
	} catch (err) {
		logger.warn({ err }, "image_models_unavailable: could not list models");
		return { models: [], reachable: false, configured: true };
	}
}

export async function listImageModels(token: string): Promise<string[]> {
	return (await probeImageModels(token)).models;
}

const CACHE_MS = 30_000;
const listed = new Map<string, { at: number; ids: Promise<string[]> }>();

/** The same, remembered briefly per token: a failure too, so a slow gateway costs one wait. */
export function imageModelsFor(token: string, now = Date.now()): Promise<string[]> {
	const key = createHash("sha256").update(token).digest("hex");
	const hit = listed.get(key);
	if (hit && now - hit.at < CACHE_MS) return hit.ids;
	const ids = listImageModels(token);
	listed.set(key, { at: now, ids });
	if (listed.size > 500) {
		for (const [k, v] of listed) if (now - v.at >= CACHE_MS) listed.delete(k);
	}
	return ids;
}

export function clearImageModelCache(): void {
	listed.clear();
}

/**
 * The model this user's images are drawn with, and why: none when nothing
 * resolves. A named model (admin or env) is only used when this token may
 * use it, so the tool is not offered to users it would always refuse.
 */
export async function resolveImageModel(token: string): Promise<ImageModelResolution> {
	let storedModel: string | null = null;
	try {
		storedModel = await storedImageModel();
	} catch (err) {
		logger.warn({ err }, "image_config_unreadable");
	}
	const envModel = envImageModel();
	const candidates = await imageModelsFor(token);
	const resolved = resolveImage({
		storedModel,
		envModel,
		// The catalogue is consulted for the default only when nothing named a model.
		candidates: storedModel || envModel ? [] : candidates,
	});
	// Fails closed: a model the catalogue does not list (not granted, or the
	// gateway did not answer in time) is not offered.
	if (resolved.model && !candidates.includes(resolved.model))
		return { model: null, source: "none" };
	return resolved;
}

// -- arguments ----------------------------------------------------------------

export type ParsedImageArgs =
	{ ok: true; prompt: string; size: ImageSize; n: number } | { ok: false; error: string };

export function parseImageArgs(args: Record<string, unknown>): ParsedImageArgs {
	const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
	if (!prompt) return { ok: false, error: "Give `prompt`: what the image should show." };
	if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
		return {
			ok: false,
			error: `The prompt is ${prompt.length} characters; the limit is ${MAX_IMAGE_PROMPT_CHARS}. Shorten it.`,
		};
	}

	let size: ImageSize = DEFAULT_IMAGE_SIZE;
	if (args.size !== undefined && args.size !== null && args.size !== "") {
		const wanted = typeof args.size === "string" ? args.size.trim().toLowerCase() : "";
		const match = (IMAGE_SIZES as readonly string[]).find((s) => s === wanted);
		if (!match) {
			return {
				ok: false,
				error: `Size ${JSON.stringify(args.size)} is not supported. Use one of ${IMAGE_SIZES.join(", ")}, or \`aspect\`: square, landscape or portrait.`,
			};
		}
		size = match as ImageSize;
	} else if (args.aspect !== undefined && args.aspect !== null && args.aspect !== "") {
		const aspect = typeof args.aspect === "string" ? args.aspect.trim().toLowerCase() : "";
		if (!(aspect in IMAGE_ASPECTS)) {
			return {
				ok: false,
				error: `Aspect ${JSON.stringify(args.aspect)} is not supported. Use square, landscape or portrait.`,
			};
		}
		size = IMAGE_ASPECTS[aspect as keyof typeof IMAGE_ASPECTS];
	}

	let n = 1;
	if (args.n !== undefined && args.n !== null && args.n !== "") {
		const parsed = typeof args.n === "string" ? Number(args.n) : args.n;
		if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
			return { ok: false, error: "`n` is the number of images: a whole number from 1 to 4." };
		}
		if (parsed > MAX_IMAGES_GENERATED_PER_TURN) {
			return {
				ok: false,
				error: `At most ${MAX_IMAGES_GENERATED_PER_TURN} images can be made in one turn; ${parsed} were asked for.`,
			};
		}
		n = parsed;
	}
	return { ok: true, prompt, size, n };
}

/** The refusal for a call that would pass the turn's cap, given the images already made this turn. */
export function imageCapError(made: number, wanted: number): string | null {
	const remaining = MAX_IMAGES_GENERATED_PER_TURN - made;
	if (wanted <= remaining) return null;
	return remaining <= 0
		? `generate_image has already made ${made} images this turn, which is the limit. Tell the person what you made and let them ask for more.`
		: `Only ${remaining} more image${remaining === 1 ? "" : "s"} can be made this turn (the limit is ${MAX_IMAGES_GENERATED_PER_TURN}); ${wanted} were asked for.`;
}

// -- bytes --------------------------------------------------------------------

/** The raster format of these bytes, from their magic number, or null. SVG and the rest are refused. */
export function sniffImage(bytes: Buffer): { mime: string; ext: string } | null {
	if (
		bytes.length >= 8 &&
		bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	) {
		return { mime: "image/png", ext: "png" };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { mime: "image/jpeg", ext: "jpg" };
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return { mime: "image/webp", ext: "webp" };
	}
	return null;
}

/** `image-<words of the prompt>`: lowercase ASCII, short, never empty. */
export function imageFileStem(prompt: string): string {
	const slug = prompt
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return `image-${slug || "generated"}`;
}

/** Reads a response body up to a cap; null when it is larger. */
async function readCapped(response: Response, cap: number): Promise<Buffer | null> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > cap) return null;
	if (!response.body) return Buffer.alloc(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > cap) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

interface GatewayImageAnswer {
	data?: { b64_json?: unknown; url?: unknown; revised_prompt?: unknown }[];
}

type Fetched = { ok: true; bytes: Buffer; revisedPrompt?: string } | { ok: false; error: string };

async function bytesOf(entry: NonNullable<GatewayImageAnswer["data"]>[number]): Promise<Fetched> {
	const revisedPrompt =
		typeof entry.revised_prompt === "string" && entry.revised_prompt.trim()
			? entry.revised_prompt.trim().slice(0, 2000)
			: undefined;
	if (typeof entry.b64_json === "string" && entry.b64_json) {
		// Base64 is 4/3 the size: refuse before decoding something enormous.
		if (entry.b64_json.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) {
			return { ok: false, error: "The image is larger than the size limit and was dropped." };
		}
		return { ok: true, bytes: Buffer.from(entry.b64_json, "base64"), revisedPrompt };
	}
	if (typeof entry.url === "string" && entry.url) {
		let response: Response;
		try {
			const target = new URL(entry.url);
			if (target.protocol !== "https:" && target.protocol !== "http:") {
				return { ok: false, error: "The model returned an image link that cannot be fetched." };
			}
			response = await contentFetch(target, { signal: AbortSignal.timeout(30_000) });
		} catch (err) {
			logger.warn({ err: String(err) }, "image_url_refused");
			return {
				ok: false,
				error:
					"The model returned an image link that could not be fetched safely, so it was dropped.",
			};
		}
		if (!response.ok) {
			return { ok: false, error: `The image link answered ${response.status}.` };
		}
		const bytes = await readCapped(response, MAX_IMAGE_BYTES).catch(() => null);
		if (!bytes) {
			return { ok: false, error: "The image is larger than the size limit and was dropped." };
		}
		return { ok: true, bytes, revisedPrompt };
	}
	return { ok: false, error: "The model returned an entry with no image." };
}

// -- the call -----------------------------------------------------------------

/** Width and height read from the image's header, or null when they cannot be. */
export function imageDimensions(bytes: Buffer): { width: number; height: number } | null {
	const kind = sniffImage(bytes)?.ext;
	if (kind === "png" && bytes.length >= 24) {
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (kind === "jpg") {
		let at = 2;
		while (at + 9 < bytes.length) {
			if (bytes[at] !== 0xff || bytes[at + 1] === 0xff) {
				at += 1;
				continue;
			}
			const marker = bytes[at + 1];
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
				return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
			}
			at += 2 + bytes.readUInt16BE(at + 2);
		}
		return null;
	}
	if (kind === "webp" && bytes.length >= 30) {
		const chunk = bytes.subarray(12, 16).toString("ascii");
		if (chunk === "VP8X") {
			return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
		}
		if (chunk === "VP8 ") {
			return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
		}
		if (chunk === "VP8L") {
			const bits = bytes.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
	}
	return null;
}

export interface GeneratedImageFile {
	/** The delivered pixels, from the header: a provider may return less than was asked for. */
	width?: number;
	height?: number;
	ref: PersistedDeliverableRef;
	bytes: Buffer;
	mime: string;
	revisedPrompt?: string;
}

export type ImageGeneration =
	| {
			ok: true;
			model: string;
			size: ImageSize;
			files: GeneratedImageFile[];
			notes: string[];
			/** What the caller should be told about how the request was met (a size changed). */
			remarks: string[];
	  }
	| { ok: false; error: string };

/** What a failed gateway call says to the model: the gateway's own words, with the cause named. */
export function describeImageFailure(err: unknown, model: string): string {
	if (err instanceof GatewayTimeout) {
		return `The image model ${model} took too long. Nothing was made; try a simpler prompt or tell the user.`;
	}
	if (err instanceof GatewayCallFailed) {
		if (err.status === 403) {
			return `The image model ${model} is not available to this user's groups. Tell the user; do not retry.`;
		}
		if (err.status === 401) {
			return "The image could not be made because the sign-in is incomplete. The user should sign out and back in.";
		}
		if (err.status === 429) {
			return `The image model ${model} is rate limited right now (${err.message}). Do not retry in this turn.`;
		}
		if (err.status >= 500) {
			return `The image model ${model} is unavailable right now (the gateway answered ${err.status}: ${err.message}). Do not retry in this turn.`;
		}
		if (/content[_ -]?(policy|filter)|safety|moderat|refus|not allowed|violat/i.test(err.message)) {
			return `The provider refused to draw this prompt: ${err.message} Tell the user and offer a different idea; do not retry the same prompt.`;
		}
		return `The gateway rejected the image request (${err.status}): ${err.message}`;
	}
	return `The image model ${model} could not be reached.`;
}

/**
 * One generation, stored. Every failure comes back spelled out rather than
 * thrown, in words the model can pass on.
 */
export async function generateImages(options: {
	token: string | undefined;
	prompt: string;
	size: ImageSize;
	n: number;
	conversationId: ObjectId;
	userId?: ObjectId;
	messageId?: string;
	billHeaders?: Record<string, string>;
	/** A model already resolved; resolved here from the token when absent. */
	model?: string | null;
	signal?: AbortSignal;
}): Promise<ImageGeneration> {
	const { token } = options;
	if (!token) {
		return {
			ok: false,
			error:
				"Images cannot be made because this session has no sign-in credential. The user should sign out and back in.",
		};
	}
	const model = options.model ?? (await resolveImageModel(token)).model;
	if (!model) {
		return {
			ok: false,
			error:
				"No image model is available to this user. An administrator can choose one on Administration -> Assistant -> Images, or grant one on the gateway.",
		};
	}

	const ask = (size: ImageSize) =>
		gateway.post<GatewayImageAnswer>(
			token,
			"images/generations",
			{
				model,
				prompt: options.prompt,
				n: options.n,
				size,
				response_format: "b64_json",
			},
			{ timeoutMs: IMAGE_TIMEOUT_MS, headers: options.billHeaders, signal: options.signal }
		);
	let answer: GatewayImageAnswer;
	let size = options.size;
	const remarks: string[] = [];
	try {
		try {
			answer = await ask(size);
		} catch (err) {
			// Some models make one size only and say so with a 400 naming it: one retry, square.
			if (
				err instanceof GatewayCallFailed &&
				err.status === 400 &&
				/size/i.test(err.message) &&
				size !== DEFAULT_IMAGE_SIZE &&
				!options.signal?.aborted
			) {
				size = DEFAULT_IMAGE_SIZE;
				remarks.push(
					`This model only makes ${DEFAULT_IMAGE_SIZE} images; made a square one instead.`
				);
				answer = await ask(size);
			} else {
				throw err;
			}
		}
	} catch (err) {
		logger.warn({ model, err: String(err) }, "image_generation_failed");
		return { ok: false, error: describeImageFailure(err, model) };
	}

	const entries = Array.isArray(answer.data) ? answer.data.slice(0, options.n) : [];
	if (entries.length === 0) {
		return { ok: false, error: `The image model ${model} returned no image.` };
	}

	const stem = imageFileStem(options.prompt);
	const files: GeneratedImageFile[] = [];
	const notes: string[] = [];
	for (const [index, entry] of entries.entries()) {
		const fetched = await bytesOf(entry ?? {});
		if (!fetched.ok) {
			notes.push(`Image ${index + 1}: ${fetched.error}`);
			continue;
		}
		const kind = sniffImage(fetched.bytes);
		if (!kind) {
			notes.push(
				`Image ${index + 1}: the model returned data that is not a PNG, JPEG or WebP image.`
			);
			continue;
		}
		const name = `${stem}${entries.length > 1 ? `-${index + 1}` : ""}.${kind.ext}`;
		const stored = await storeDeliverable({
			conversationId: options.conversationId,
			userId: options.userId,
			name,
			mime: kind.mime,
			bytes: fetched.bytes,
			tool: "generate_image",
			summary: options.prompt,
			messageId: options.messageId,
		});
		if (!stored.ok) {
			notes.push(`Image ${index + 1}: ${stored.error}`);
			continue;
		}
		files.push({
			...(imageDimensions(fetched.bytes) ?? {}),
			ref: {
				...stored.ref,
				prompt: options.prompt.slice(0, MAX_IMAGE_PROMPT_CHARS),
				...(fetched.revisedPrompt ? { revisedPrompt: fetched.revisedPrompt } : {}),
			},
			bytes: fetched.bytes,
			mime: kind.mime,
			...(fetched.revisedPrompt ? { revisedPrompt: fetched.revisedPrompt } : {}),
		});
	}
	if (files.length === 0) {
		return { ok: false, error: `No image could be kept. ${notes.join(" ")}`.trim() };
	}
	return { ok: true, model, size, files, notes, remarks };
}

/** What the model reads after a generation: names, sizes, the revised prompt. */
export function imageResultText(result: Extract<ImageGeneration, { ok: true }>, seen: boolean) {
	const lines = result.files.map((file) => {
		const kb = Math.max(1, Math.round(file.ref.size / 1024));
		return `- ${file.ref.name} (${file.width && file.height ? `${file.width}x${file.height} px, ` : ""}${kb} KB)${file.revisedPrompt ? `; the image model's own rewrite of the prompt (written by the provider, not the user): ${JSON.stringify(file.revisedPrompt)}` : ""}`;
	});
	return (
		`Made ${result.files.length} image${result.files.length === 1 ? "" : "s"} with ${result.model} (asked for ${result.size}; the sizes listed are what was delivered, and providers may deliver less than asked); ` +
		"the person sees each in the chat and can download it, and it is in this conversation's files (the sandbox mounts it like any file you made):\n" +
		lines.join("\n") +
		(result.remarks.length > 0 ? `\n${result.remarks.join(" ")}` : "") +
		(result.notes.length > 0 ? `\nNot kept: ${result.notes.join(" ")}` : "") +
		(seen
			? "\nThe images are shown to you next to this result for this turn only."
			: "\nYou cannot see images; describe only what the person asked for, not what came out.")
	);
}

export function imagesForModel(result: Extract<ImageGeneration, { ok: true }>): BuiltinToolImage[] {
	return result.files.map((file) => ({
		mime: file.mime,
		base64: file.bytes.toString("base64"),
		label: file.ref.name,
	}));
}
