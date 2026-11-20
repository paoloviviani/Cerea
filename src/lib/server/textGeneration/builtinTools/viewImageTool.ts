import sharp from "sharp";
import { MOUNT_ROOT, OUTPUT_ROOT } from "$lib/utils/execution/protocol";
import { logger } from "$lib/server/logger";
import { orientedSize } from "$lib/server/endpoints/images";
import { branchOfCall, findConversationFile } from "./conversationFiles";
import {
	IMAGES_UNAVAILABLE_ERROR,
	MAX_IMAGES_PER_TURN,
	type PictureState,
} from "../mcp/pictureMessages";
import type { BuiltinTool } from "./types";

export const VIEW_IMAGE_TOOL_NAME = "view_image";

/** Loop protection, not capability: zooming in takes a few calls, but a turn makes at most this many. */
export const MAX_VIEW_CALLS_PER_TURN = 20;
/** The largest image file looked at; a bigger one is not opened (a phone photo is a few MB). */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** A crop smaller than this on a side shows nothing a model can read. */
const MIN_CROP_PX = 8;

type Box = { x: number; y: number; width: number; height: number };

/**
 * The `crop` box, checked against the picture as the model sees it (EXIF orientation applied).
 * `pixels` (the default) are source pixels from the top left; `fraction` is 0 to 1 of the width and height.
 * A box that runs past the edge is cut to it; one that lies outside, or is empty, is refused with the size.
 */
export function parseCrop(
	args: Record<string, unknown>,
	size: { width: number; height: number }
): { ok: true; box: Box | undefined } | { ok: false; error: string } {
	const raw = args.crop;
	if (raw === undefined || raw === null) return { ok: true, box: undefined };
	const unit = args.crop_unit ?? "pixels";
	if (unit !== "pixels" && unit !== "fraction") {
		return { ok: false, error: '`crop_unit` is "pixels" (the default) or "fraction".' };
	}
	const value = raw as Record<string, unknown>;
	const numbers = ["x", "y", "width", "height"].map((key) => value?.[key]);
	if (
		typeof raw !== "object" ||
		!numbers.every((n) => typeof n === "number" && Number.isFinite(n))
	) {
		return {
			ok: false,
			error: "`crop` is {x, y, width, height}, measured from the top left of the picture.",
		};
	}
	const [x, y, w, h] = numbers as number[];
	const scaleX = unit === "fraction" ? size.width : 1;
	const scaleY = unit === "fraction" ? size.height : 1;
	const left = Math.max(0, Math.round(x * scaleX));
	const top = Math.max(0, Math.round(y * scaleY));
	const right = Math.min(size.width, Math.round((x + w) * scaleX));
	const bottom = Math.min(size.height, Math.round((y + h) * scaleY));
	if (right - left < MIN_CROP_PX || bottom - top < MIN_CROP_PX) {
		return {
			ok: false,
			error:
				`\`crop\` leaves nothing to show: the picture is ${size.width} x ${size.height} px ` +
				`(as you see it, upright) and the box must cover at least ${MIN_CROP_PX} px on each side inside it` +
				(unit === "fraction" ? " (give x, y, width, height as 0 to 1)." : "."),
		};
	}
	return { ok: true, box: { x: left, y: top, width: right - left, height: bottom - top } };
}

export function parseRotate(
	value: unknown
): { ok: true; degrees: number } | { ok: false; error: string } {
	if (value === undefined || value === null || value === "") return { ok: true, degrees: 0 };
	const degrees = typeof value === "number" ? value : Number(String(value).trim());
	if (degrees === 0 || degrees === 90 || degrees === 180 || degrees === 270) {
		return { ok: true, degrees };
	}
	return { ok: false, error: "`rotate` is 90, 180 or 270 (degrees clockwise)." };
}

/** Where a file reference points: `/mnt/output/<name>` a produced file, `/mnt/data/<name>` or a bare name what is mounted. */
function parseReference(
	written: string
): { name: string; source: "mounted" | "output" } | { error: string } {
	const text = written.trim();
	let source: "mounted" | "output" = "mounted";
	let name = text;
	if (text.startsWith(`${MOUNT_ROOT}/`)) {
		name = text.slice(MOUNT_ROOT.length + 1);
	} else if (text.startsWith(`${OUTPUT_ROOT}/`)) {
		source = "output";
		name = text.slice(OUTPUT_ROOT.length + 1);
	} else if (text.startsWith("/")) {
		return {
			error: `"${text}" is outside the conversation's files. Use "${MOUNT_ROOT}/<name>" or "${OUTPUT_ROOT}/<name>".`,
		};
	}
	if (!name || name.split("/").some((part) => part === ".." || part === "." || part === "")) {
		return {
			error: `"${text}" is not a valid file path. Use "${MOUNT_ROOT}/<name>" or "${OUTPUT_ROOT}/<name>".`,
		};
	}
	return { name, source };
}

/**
 * `view_image`: shows the model an image file of the conversation (an attachment, or a file a run or a tool
 * made), optionally one region of it, enlarged, or turned. An image saved by code reaches the user, never
 * the model, so this is how the model looks at a photo it was sent at full detail, at a crop it made in the
 * sandbox, or at a figure it drew.
 *
 * Offered only to a model that sees images (the caller checks). The picture rides in `images` and reaches the
 * model as image content in the round's next request, fitted to the model's image limits like an attachment
 * (`fitImages` in `mcp/toolInvocation.ts`); a crop is therefore cut from the source pixels, not from a
 * downsized copy. A withheld attachment, or a name the conversation does not have, never resolves.
 */
export function createViewImageBuiltin(pictureState?: PictureState): BuiltinTool[] {
	let calls = 0;
	let imagesShown = 0;
	return [
		{
			name: VIEW_IMAGE_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: VIEW_IMAGE_TOOL_NAME,
					description:
						"Look at an image file of this conversation (a photo or scan the user attached, or an image a run saved): you get the picture as an image you can see. " +
						"Images you save from code are shown to the user, not to you, so use this to see them. " +
						"To read small print or dense tables, ask for a region with `crop`: it is cut from the full-resolution original, so a crop of a quarter of a page is far more legible than the whole page. " +
						"Photos from a phone are shown upright (their orientation is applied); if the page is still turned, use `rotate`. " +
						"Coordinates are in pixels of the picture as you see it, from the top left; the result tells you its full size, so you can ask for other regions. " +
						`At most ${MAX_VIEW_CALLS_PER_TURN} calls and ${MAX_IMAGES_PER_TURN} images per turn, and each image costs about a thousand tokens or more: crop to what you need.`,
					parameters: {
						type: "object",
						properties: {
							file: {
								type: "string",
								description: `The image: "${MOUNT_ROOT}/<name>" for what is in the sandbox now (attachments, and files made earlier), "${OUTPUT_ROOT}/<name>" for a file you produced; a bare name means ${MOUNT_ROOT}/<name>.`,
							},
							crop: {
								type: "object",
								description:
									"Show only this region, from the top left of the upright picture, in pixels (or fractions with `crop_unit`).",
								properties: {
									x: { type: "number" },
									y: { type: "number" },
									width: { type: "number" },
									height: { type: "number" },
								},
								required: ["x", "y", "width", "height"],
							},
							crop_unit: {
								type: "string",
								enum: ["pixels", "fraction"],
								description:
									'"pixels" (default) or "fraction": x, y, width and height as 0 to 1 of the picture, e.g. {x: 0, y: 0.5, width: 1, height: 0.25} is the third quarter from the top.',
							},
							rotate: {
								type: "integer",
								enum: [90, 180, 270],
								description:
									"Turn the picture clockwise by this many degrees (applied after the crop), for a page that is still sideways.",
							},
						},
						required: ["file"],
					},
				},
			},

			async execute(args, ctx) {
				if (pictureState?.unavailable) return { error: IMAGES_UNAVAILABLE_ERROR };
				if (!ctx.conversationId)
					return { error: "There is no conversation to take the file from." };
				if (calls >= MAX_VIEW_CALLS_PER_TURN) {
					return {
						error: `view_image has reached its limit of ${MAX_VIEW_CALLS_PER_TURN} calls for this turn. Say what you saw and let the user ask for more.`,
					};
				}
				calls += 1;
				if (imagesShown >= MAX_IMAGES_PER_TURN) {
					return {
						error: `view_image has already shown you ${imagesShown} images this turn, and the limit is ${MAX_IMAGES_PER_TURN}. Say what you saw and let the user ask for more.`,
					};
				}
				if (typeof args.file !== "string" || !args.file.trim()) {
					return {
						error: `Give \`file\`: the path of an image, e.g. ${MOUNT_ROOT}/photo.jpg or ${OUTPUT_ROOT}/chart.png.`,
					};
				}
				const reference = parseReference(args.file);
				if ("error" in reference) return { error: reference.error };
				const rotate = parseRotate(args.rotate);
				if (!rotate.ok) return { error: rotate.error };

				const file = await findConversationFile(ctx.conversationId, reference.name, {
					source: reference.source,
					branch: await branchOfCall(ctx),
				});
				if (!file.ok) return { error: file.error };
				if (file.bytes.byteLength > MAX_IMAGE_BYTES) {
					return {
						error: `"${file.name}" is larger than the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB view_image opens.`,
					};
				}

				let metadata: sharp.Metadata;
				try {
					metadata = await sharp(file.bytes).metadata();
				} catch {
					return {
						error:
							`"${file.name}" is not an image view_image can open` +
							(/\.(pdf|docx?|xlsx?|pptx?)$/i.test(file.name)
								? ": for pages of a Word, Excel, PowerPoint or PDF file use look_doc."
								: "."),
					};
				}
				let size: { width: number; height: number };
				try {
					size = orientedSize(metadata);
				} catch {
					return { error: `"${file.name}" has no readable size.` };
				}
				const crop = parseCrop(args, size);
				if (!crop.ok) return { error: crop.error };

				try {
					let bytes = file.bytes;
					let mime = file.mime?.startsWith("image/")
						? file.mime
						: `image/${metadata.format ?? "png"}`;
					let shown = size;
					if (crop.box || rotate.degrees) {
						// Orientation first (rotate() with no angle), then the crop in upright coordinates, then
						// the turn; lossless, so a model reading digits sees the source's pixels.
						let inst = sharp(file.bytes).rotate();
						if (crop.box)
							inst = inst.extract({
								left: crop.box.x,
								top: crop.box.y,
								width: crop.box.width,
								height: crop.box.height,
							});
						const upright = await inst.png().toBuffer();
						bytes = rotate.degrees
							? await sharp(upright).rotate(rotate.degrees).png().toBuffer()
							: upright;
						mime = "image/png";
						const out = await sharp(bytes).metadata();
						shown = { width: out.width ?? size.width, height: out.height ?? size.height };
					}
					imagesShown += 1;
					const area = crop.box
						? `region x ${crop.box.x}, y ${crop.box.y}, ${crop.box.width} x ${crop.box.height} px`
						: "the whole picture";
					return {
						resultText:
							`${file.name} is ${size.width} x ${size.height} px (upright). ` +
							`Showing ${area}${rotate.degrees ? `, turned ${rotate.degrees} degrees clockwise` : ""}` +
							` (${shown.width} x ${shown.height} px before it is fitted to your image limits), next to this result. ` +
							// The picture rides in this turn's requests only: a later turn replays this text, not it.
							"Shown to you as an image in this turn only; call view_image again to see it later.",
						imagesOf: `${file.name}, ${area}`,
						images: [
							{
								mime,
								base64: bytes.toString("base64"),
								label: `${file.name}, ${area}`,
							},
						],
					};
				} catch (err) {
					logger.warn({ err }, "view_image_failed");
					return { error: `"${file.name}" could not be read as an image.` };
				}
			},
		},
	];
}
