import type { Sharp } from "sharp";
import sharp from "sharp";
import type { MessageFile } from "$lib/types/Message";
import { z, type util } from "zod";

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
 * the providers behind the gateway (Anthropic's is 5 MB). The total keeps a request with several images
 * far below the gateway's 64 MiB `/v1` body limit (base64 adds a third).
 */
export const DEFAULT_IMAGE_LIMITS = {
	maxWidth: 2048,
	maxHeight: 2048,
	maxSizeInMB: 3.75,
	totalBudgetMB: 32,
} as const;

export const DEFAULT_IMAGE_PROCESSOR_OPTIONS: ImageProcessorOptions<string> = {
	supportedMimeTypes: ["image/png", "image/jpeg"],
	preferredMimeType: "image/jpeg",
	...DEFAULT_IMAGE_LIMITS,
};

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
			totalBudgetMB: z.number().positive().default(defaults.totalBudgetMB),
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
 * is returned as it came.
 */
export function makeImageProcessor<TMimeType extends string = string>(
	options: ImageProcessorOptions<TMimeType>
): ImageProcessor<TMimeType> {
	return async (file, call) => {
		const { supportedMimeTypes, preferredMimeType, maxSizeInMB, maxWidth, maxHeight } = options;
		const { mime, value } = file;

		const buffer = Buffer.from(value, "base64");
		const metadata = await sharp(buffer).metadata();
		if (!metadata) throw Error("Failed to read image metadata");
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

		let target = fitBox(width, height, maxWidth, maxHeight);
		for (;;) {
			const qualities = outputMime === "image/jpeg" ? JPEG_QUALITIES : [undefined];
			let last: Buffer | undefined;
			for (const quality of qualities) {
				last = await encode(buffer, outputMime, target, quality);
				if (last.byteLength <= byteCap) return { image: last, mime: outputMime };
			}
			// Even the lowest quality is too big: take the size down a step and start again.
			const next = {
				width: Math.floor(target.width * SHRINK_STEP),
				height: Math.floor(target.height * SHRINK_STEP),
			};
			if (next.width < 16 || next.height < 16) {
				if (last) return { image: last, mime: outputMime };
				throw Error(`Failed to resize image to fit within ${maxSizeInMB}MB`);
			}
			target = next;
		}
	};
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

async function encode(
	buffer: Buffer,
	mime: string,
	size: { width: number; height: number },
	quality: number | undefined
): Promise<Buffer> {
	// rotate() with no angle applies the EXIF orientation and clears the tag.
	let inst = sharp(buffer).rotate().resize({
		width: size.width,
		height: size.height,
		fit: "fill",
		withoutEnlargement: true,
	});
	if (mime === "image/jpeg") inst = inst.flatten({ background: "#ffffff" });
	return convertImage(inst, mime, quality).toBuffer();
}

/**
 * Processes a batch (one request's images) and, when the results add up to more than `budgetBytes`,
 * processes them again with every image's byte cap lowered by the same proportion.
 */
export async function processWithBudget(
	files: MessageFile[],
	processor: ImageProcessor,
	budgetBytes: number
): Promise<Array<{ image: Buffer; mime: string }>> {
	let results = await Promise.all(files.map((file) => processor(file)));
	for (let pass = 0; pass < 3; pass += 1) {
		const total = results.reduce((sum, r) => sum + r.image.byteLength, 0);
		if (total <= budgetBytes) break;
		const factor = (budgetBytes / total) * 0.95;
		const previous = results;
		results = await Promise.all(
			files.map((file, i) =>
				processor(file, { maxBytes: Math.floor(previous[i].image.byteLength * factor) })
			)
		);
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
