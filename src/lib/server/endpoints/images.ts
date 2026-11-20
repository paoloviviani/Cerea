import type { Sharp } from "sharp";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import { z, type util } from "zod";

/** What the sum of one request's images (attachments and pictures of a round) may reach, decimal MB of files:
 * the gateway takes 64 MiB of body, base64 adds a third, and the rest is text. */
export const MAX_TOTAL_BUDGET_MB = 45;

export interface ImageProcessorOptions<TMimeType extends string = string> {
	supportedMimeTypes: TMimeType[];
	preferredMimeType: TMimeType;
	/** Cap on one image's bytes (decimal MB), applied by lowering JPEG quality first, then the size. */
	maxSizeInMB: number;
	/** The box an image is fitted into, aspect kept, never upscaled. */
	maxWidth: number;
	maxHeight: number;
	/** What all the images of one request may add up to (decimal MB); more shrinks them proportionally. */
	totalBudgetMB: number;
}

/**
 * The one default for every image a model is sent (attachments, tool pictures, the endpoint): the long
 * edge is 2048 px, so a phone photo of an A4 page (3024x4032) keeps small print legible at 1536x2048.
 * The byte cap is 3.75 MB, which is about 5 MB once base64-encoded: the smallest per-image limit among
 * the providers behind the gateway (Anthropic's is 5 MB). The total (45 MB of files, 60 MB once base64-encoded)
 * keeps a request with several images under the gateway's 64 MiB `/v1` body limit.
 */
export const DEFAULT_IMAGE_LIMITS = {
	maxWidth: 2048,
	maxHeight: 2048,
	maxSizeInMB: 3.75,
	totalBudgetMB: MAX_TOTAL_BUDGET_MB,
} as const;

/**
 * The size an image shrinks to, once, when a request holds more images than its budget: the oldest ones
 * (in message order) are re-encoded at this size so the newest keep full detail. It is a fixed size, not a
 * proportion, so an image's bytes never depend on how many others the conversation has: the provider's prompt
 * cache stays valid for everything before the newest image.
 */
export const HISTORY_IMAGE_LIMITS = { maxWidth: 1024, maxHeight: 1024, maxSizeInMB: 1 } as const;

/** Sources with more pixels than this are refused, not decoded (a small file can claim billions). */
export const IMAGE_PIXEL_LIMIT = 100_000_000;
/** Passed to every `sharp()` that reads a user's or the model's image. */
export const SHARP_INPUT = { limitInputPixels: IMAGE_PIXEL_LIMIT } as const;

export class ImageTooLargeError extends Error {
	constructor(name: string, width: number, height: number) {
		super(
			`The image "${name}" is too large to read: ${width} x ${height} px is ${Math.round((width * height) / 1e6)} megapixels, ` +
				`and the limit is ${IMAGE_PIXEL_LIMIT / 1e6}.`
		);
		this.name = "ImageTooLargeError";
	}
}

/** Reads an image's header, refusing one whose pixel count is past `IMAGE_PIXEL_LIMIT` before anything decodes it. */
export async function readImageMetadata(buffer: Buffer, name = "image"): Promise<sharp.Metadata> {
	// The header only: reading it decodes nothing, so sharp's own limit is lifted here to be able to say how big it is.
	const metadata = await sharp(buffer, { limitInputPixels: false }).metadata();
	if (
		metadata.width !== undefined &&
		metadata.height !== undefined &&
		metadata.width * metadata.height > IMAGE_PIXEL_LIMIT
	) {
		throw new ImageTooLargeError(name, metadata.width, metadata.height);
	}
	return metadata;
}

export const DEFAULT_IMAGE_PROCESSOR_OPTIONS: ImageProcessorOptions<string> = {
	supportedMimeTypes: ["image/png", "image/jpeg"],
	preferredMimeType: "image/jpeg",
	...DEFAULT_IMAGE_LIMITS,
};

/** The `imageLimits` of a MODELS entry, with bounds that keep a request under the gateway's size limit. */
export const imageLimitsSchema = z.object({
	maxWidth: z
		.number()
		.int()
		.min(256, "imageLimits.maxWidth must be between 256 and 8192 px")
		.max(8192, "imageLimits.maxWidth must be between 256 and 8192 px")
		.optional(),
	maxHeight: z
		.number()
		.int()
		.min(256, "imageLimits.maxHeight must be between 256 and 8192 px")
		.max(8192, "imageLimits.maxHeight must be between 256 and 8192 px")
		.optional(),
	maxSizeInMB: z
		.number()
		.min(0.25, "imageLimits.maxSizeInMB must be between 0.25 and 20")
		.max(20, "imageLimits.maxSizeInMB must be between 0.25 and 20")
		.optional(),
	totalBudgetMB: z
		.number()
		.positive("imageLimits.totalBudgetMB must be above 0 and at most 45")
		.max(MAX_TOTAL_BUDGET_MB, "imageLimits.totalBudgetMB must be above 0 and at most 45")
		.optional(),
});

/** What a model entry (MODELS `imageLimits`, or an endpoint's `multimodal.image`) may set. */
export type ImageLimitsOverride = Partial<
	Pick<ImageProcessorOptions, "maxWidth" | "maxHeight" | "maxSizeInMB" | "totalBudgetMB">
>;

/**
 * The image options for a model: the shared defaults, then the endpoint's `multimodal.image`, then the
 * model's own `imageLimits` (the field a MODELS override sets).
 */
export function imageProcessorOptionsFor(model: {
	imageLimits?: ImageLimitsOverride;
	endpoints?: ReadonlyArray<
		{ multimodal?: { image?: Partial<ImageProcessorOptions> } } | undefined
	>;
}): ImageProcessorOptions {
	return {
		...DEFAULT_IMAGE_PROCESSOR_OPTIONS,
		...model.endpoints?.[0]?.multimodal?.image,
		...model.imageLimits,
	};
}

export type ImageProcessorCall = { maxBytes?: number };
export type ImageProcessor<TMimeType extends string = string> = (
	file: MessageFile,
	call?: ImageProcessorCall
) => Promise<{
	image: Buffer;
	mime: TMimeType;
}>;

export function createImageProcessorOptionsValidator<TMimeType extends string = string>(
	defaults: ImageProcessorOptions<TMimeType>
) {
	return z
		.object({
			supportedMimeTypes: z
				.array(
					z.enum<string, [TMimeType, ...TMimeType[]]>([
						defaults.supportedMimeTypes[0],
						...defaults.supportedMimeTypes.slice(1),
					])
				)
				.default(defaults.supportedMimeTypes),
			preferredMimeType: z
				.enum([defaults.supportedMimeTypes[0], ...defaults.supportedMimeTypes.slice(1)])
				.default(defaults.preferredMimeType as util.noUndefined<TMimeType>),
			maxSizeInMB: z.number().positive().default(defaults.maxSizeInMB),
			maxWidth: z.number().int().positive().default(defaults.maxWidth),
			maxHeight: z.number().int().positive().default(defaults.maxHeight),
			totalBudgetMB: z.number().positive().max(MAX_TOTAL_BUDGET_MB).default(defaults.totalBudgetMB),
		})
		.default(defaults);
}

/** Width and height as the picture is drawn once its EXIF orientation is applied (5-8 swap the axes). */
export function orientedSize(metadata: { width?: number; height?: number; orientation?: number }): {
	width: number;
	height: number;
} {
	const { width, height, orientation } = metadata;
	if (width === undefined || height === undefined) throw Error("Failed to read image size");
	return orientation !== undefined && orientation >= 5
		? { width: height, height: width }
		: { width, height };
}

/** The qualities tried, in order, when an image does not fit its byte cap, before its size is lowered. */
const JPEG_QUALITIES = [85, 75, 65, 55, 45];
const SHRINK_STEP = 0.85;

/**
 * Fits an image to what a model is sent: EXIF orientation applied (phone photos are stored sideways with a
 * tag, and the tag is dropped on re-encoding), long edge capped and never upscaled, bytes capped by lowering
 * JPEG quality before lowering the size. An image that is upright, small enough and in a supported format
 * is returned as it came. The result depends on the image and the options alone (never on other images),
 * so the same input gives the same bytes on every turn.
 */
export function makeImageProcessor<TMimeType extends string = string>(
	options: ImageProcessorOptions<TMimeType>
): ImageProcessor<TMimeType> {
	return async (file, call) => {
		const { supportedMimeTypes, preferredMimeType, maxSizeInMB, maxWidth, maxHeight } = options;
		const { mime, value } = file;

		const buffer = Buffer.from(value, "base64");
		const metadata = await readImageMetadata(buffer, file.name);
		const { width, height } = orientedSize(metadata);
		const needsRotation = metadata.orientation !== undefined && metadata.orientation > 1;

		const byteCap = Math.max(1, Math.min(maxSizeInMB * 1000 * 1000, call?.maxBytes ?? Infinity));
		const tooLargeInSize = width > maxWidth || height > maxHeight;
		const tooLargeInBytes = buffer.byteLength > byteCap;

		const outputMime = chooseMimeType(supportedMimeTypes, preferredMimeType, mime, {
			preferSizeReduction: tooLargeInBytes,
		});
		if (!tooLargeInSize && !tooLargeInBytes && !needsRotation && outputMime === mime) {
			return { image: buffer, mime: outputMime };
		}

		// Decode, orient and size once, to raw pixels; the quality steps and any further shrinking start
		// from those, not from the source.
		let raw = await decodeUpright(buffer, outputMime, fitBox(width, height, maxWidth, maxHeight));
		for (;;) {
			const qualities = outputMime === "image/jpeg" ? JPEG_QUALITIES : [undefined];
			let last: Buffer | undefined;
			for (const quality of qualities) {
				last = await convertImage(rawSharp(raw), outputMime, quality).toBuffer();
				if (last.byteLength <= byteCap) return { image: last, mime: outputMime };
			}
			// Even the lowest quality is too big: take the size down a step and start again.
			const next = {
				width: Math.floor(raw.info.width * SHRINK_STEP),
				height: Math.floor(raw.info.height * SHRINK_STEP),
			};
			if (next.width < 16 || next.height < 16) {
				if (last) return { image: last, mime: outputMime };
				throw Error(`Failed to resize image to fit within ${maxSizeInMB}MB`);
			}
			raw = await resizeRaw(raw, next);
		}
	};
}

interface RawImage {
	data: Buffer;
	info: { width: number; height: number; channels: 1 | 2 | 3 | 4 };
}

const rawSharp = (raw: RawImage) =>
	sharp(raw.data, {
		raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels },
	});

async function decodeUpright(
	buffer: Buffer,
	mime: string,
	size: { width: number; height: number }
): Promise<RawImage> {
	// rotate() with no angle applies the EXIF orientation and clears the tag.
	let inst = sharp(buffer, SHARP_INPUT).rotate().resize({
		width: size.width,
		height: size.height,
		fit: "fill",
		withoutEnlargement: true,
	});
	if (mime === "image/jpeg") inst = inst.flatten({ background: "#ffffff" });
	const { data, info } = await inst.raw().toBuffer({ resolveWithObject: true });
	return { data, info: { width: info.width, height: info.height, channels: info.channels } };
}

async function resizeRaw(
	raw: RawImage,
	size: { width: number; height: number }
): Promise<RawImage> {
	const { data, info } = await rawSharp(raw)
		.resize({ width: size.width, height: size.height, fit: "fill" })
		.raw()
		.toBuffer({ resolveWithObject: true });
	return { data, info: { width: info.width, height: info.height, channels: info.channels } };
}

function fitBox(
	width: number,
	height: number,
	maxWidth: number,
	maxHeight: number
): { width: number; height: number } {
	const scale = Math.min(1, maxWidth / width, maxHeight / height);
	return scale === 1
		? { width, height }
		: {
				width: Math.max(1, Math.round(width * scale)),
				height: Math.max(1, Math.round(height * scale)),
			};
}

/** The options for the fixed smaller size an old image shrinks to (never larger than the model's own limits). */
export function historyImageOptions<T extends string>(
	options: ImageProcessorOptions<T>
): ImageProcessorOptions<T> {
	return {
		...options,
		maxWidth: Math.min(options.maxWidth, HISTORY_IMAGE_LIMITS.maxWidth),
		maxHeight: Math.min(options.maxHeight, HISTORY_IMAGE_LIMITS.maxHeight),
		maxSizeInMB: Math.min(options.maxSizeInMB, HISTORY_IMAGE_LIMITS.maxSizeInMB),
	};
}

/** Tool pictures are never given less than this, however much the attachments took. */
export const MIN_PICTURE_BUDGET_BYTES = 2_000_000;

/** What is left of the request's image total for a round's pictures, after the attachments' images. */
export function remainingImageBudget(totalBytes: number, usedBytes: number): number {
	return Math.max(MIN_PICTURE_BUDGET_BYTES, totalBytes - usedBytes);
}

/** What a request-wide image budget needs: the bytes left, and the processor for the shrunken old size. */
export interface ImageBudget {
	bytes: number;
	historyProcessor: ImageProcessor;
}

/**
 * Processes a batch (images in message order, oldest first) so that together they fit `budget.bytes`.
 * Every image is encoded at its full per-image limits, a function of the image alone. Only when the sum is
 * over the budget are the OLDEST images re-encoded at the fixed history size, one after another until it
 * fits: an image's bytes change once, when it becomes old, and adding a newer image never touches the
 * bytes of the ones that keep their full size. If even all-history is over, the last resort lowers every
 * image's byte cap by the same proportion.
 */
export async function fitBatchToBudget(
	files: MessageFile[],
	processor: ImageProcessor,
	budget: ImageBudget
): Promise<Array<{ image: Buffer; mime: string }>> {
	const results = await Promise.all(files.map((file) => processor(file)));
	const sum = () => results.reduce((n, r) => n + r.image.byteLength, 0);
	for (let i = 0; i < files.length && sum() > budget.bytes; i += 1) {
		const smaller = await budget.historyProcessor(files[i]);
		if (smaller.image.byteLength < results[i].image.byteLength) results[i] = smaller;
	}
	for (let pass = 0; pass < 3; pass += 1) {
		const total = sum();
		if (total <= budget.bytes) break;
		const factor = (budget.bytes / total) * 0.95;
		const previous = [...results];
		for (let i = 0; i < files.length; i += 1) {
			results[i] = await budget.historyProcessor(files[i], {
				maxBytes: Math.floor(previous[i].image.byteLength * factor),
			});
		}
	}
	return results;
}

const outputFormats = ["png", "jpeg", "webp", "avif", "tiff", "gif"] as const;
type OutputImgFormat = (typeof outputFormats)[number];
const isOutputFormat = (format: string): format is (typeof outputFormats)[number] =>
	outputFormats.includes(format as OutputImgFormat);

export function convertImage(sharpInst: Sharp, outputMime: string, quality?: number): Sharp {
	const [type, format] = outputMime.split("/");
	if (type !== "image") throw Error(`Requested non-image mime type: ${outputMime}`);
	if (!isOutputFormat(format)) {
		throw Error(`Requested to convert to an unsupported format: ${format}`);
	}

	return quality !== undefined && (format === "jpeg" || format === "webp" || format === "avif")
		? sharpInst[format]({ quality })
		: sharpInst[format]();
}

// heic/heif requires proprietary license
// TODO: blocking heif may be incorrect considering it also supports av1, so we should instead
// detect the compression method used via sharp().metadata().compression
// TODO: consider what to do about animated formats: apng, gif, animated webp, ...
const blocklistedMimes = ["image/heic", "image/heif"];

/** Sorted from largest to smallest */
const mimesBySizeDesc = [
	"image/png",
	"image/tiff",
	"image/gif",
	"image/jpeg",
	"image/webp",
	"image/avif",
];

/**
 * Defaults to preferred format or uses existing mime if supported
 * When preferSizeReduction is true, it will choose the smallest format that is supported
 **/
function chooseMimeType<T extends readonly string[]>(
	supportedMimes: T,
	preferredMime: string,
	mime: string,
	{ preferSizeReduction }: { preferSizeReduction: boolean }
): T[number] {
	if (!supportedMimes.includes(preferredMime)) {
		const supportedMimesStr = supportedMimes.join(", ");
		throw Error(
			`Preferred format "${preferredMime}" not found in supported mimes: ${supportedMimesStr}`
		);
	}

	const [type] = mime.split("/");
	if (type !== "image") throw Error(`Received non-image mime type: ${mime}`);

	if (supportedMimes.includes(mime) && !preferSizeReduction) return mime;

	if (blocklistedMimes.includes(mime)) throw Error(`Received blocklisted mime type: ${mime}`);

	const smallestMime = mimesBySizeDesc.findLast((m) => supportedMimes.includes(m));
	return smallestMime ?? preferredMime;
}
