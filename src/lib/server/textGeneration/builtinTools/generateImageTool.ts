import { randomUUID } from "node:crypto";
import {
	DEFAULT_IMAGE_SIZE,
	IMAGE_ASPECTS,
	IMAGE_SIZES,
	MAX_IMAGES_GENERATED_PER_TURN,
	generateImages,
	imageResultText,
	imagesForModel,
	parseImageArgs,
} from "$lib/server/imageGeneration";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { PictureState } from "../mcp/pictureMessages";
import type { BuiltinTool } from "./types";

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export interface GenerateImageParams {
	/** The model this user's images are drawn with, resolved by the caller (a network probe). */
	model: string;
	/** `x-bill-to` and the like, for the gateway call. */
	billHeaders?: Record<string, string>;
	token?: string;
	/** Whether the turn's model can see pictures: the images then ride in the next request. */
	modelSeesImages?: boolean;
	pictureState?: PictureState;
}

/**
 * `generate_image`: draws images with the gateway's image model, as the user
 * (metered to them), and stores each as a produced file listed in the chat.
 * Offered only when a model resolves for the user (`resolveImageModel`).
 *
 * With the administrator's "Ask before generating images" switch on, the call
 * is gated by the approval card like any gated tool (`toolInvocation.ts`), and
 * the approved call is run by `resumeElicitation.ts`; otherwise `execute` runs it.
 */
export function createGenerateImageBuiltin(params: GenerateImageParams): BuiltinTool[] {
	// Built once per turn, so this counts the turn's images across its calls.
	let made = 0;
	return [
		{
			name: GENERATE_IMAGE_TOOL_NAME,
			definition: {
				type: "function",
				function: {
					name: GENERATE_IMAGE_TOOL_NAME,
					description:
						"Draw an image from a text description with an image model, and show it to the person in the chat as a file they can download. " +
						"Use it when the person asks for a picture, illustration, logo idea, concept art or photo-like image; not for charts or diagrams of data (use code for those). " +
						"Write `prompt` as a full visual description in the language the image model reads best (usually English): subject, setting, style, lighting, composition. " +
						"Any text you want drawn in the image must be quoted exactly, and image models spell poorly, so keep it short. " +
						`Each image costs money, so make what was asked for and no more: at most ${MAX_IMAGES_GENERATED_PER_TURN} images per turn. ` +
						"The result gives the file name(s) and the prompt the model actually used.",
					parameters: {
						type: "object",
						properties: {
							prompt: { type: "string", description: "What the image should show." },
							size: {
								type: "string",
								enum: [...IMAGE_SIZES],
								description: `Pixels, width x height. Default ${DEFAULT_IMAGE_SIZE}. Or give \`aspect\`.`,
							},
							aspect: {
								type: "string",
								enum: Object.keys(IMAGE_ASPECTS),
								description:
									"square (1024x1024), landscape (1536x1024) or portrait (1024x1536), instead of `size`.",
							},
							n: {
								type: "integer",
								minimum: 1,
								maximum: MAX_IMAGES_GENERATED_PER_TURN,
								description: "How many variations. Default 1.",
							},
						},
						required: ["prompt"],
					},
				},
			},
			preprompt:
				`IMAGES: ${GENERATE_IMAGE_TOOL_NAME} draws an image from a description; the person sees it in the chat. ` +
				"Call it only when they ask for an image. Do not paste the file into your answer; say briefly what you made " +
				"and offer to adjust it.",

			async execute(args, ctx) {
				if (!ctx.conversationId) return { error: "There is no conversation to keep the image in." };
				const parsed = parseImageArgs(args);
				if (!parsed.ok) return { error: parsed.error };
				const remaining = MAX_IMAGES_GENERATED_PER_TURN - made;
				if (parsed.n > remaining) {
					return {
						error:
							remaining <= 0
								? `generate_image has already made ${made} images this turn, which is the limit. Tell the person what you made and let them ask for more.`
								: `Only ${remaining} more image${remaining === 1 ? "" : "s"} can be made this turn (the limit is ${MAX_IMAGES_GENERATED_PER_TURN}); ${parsed.n} were asked for.`,
					};
				}
				// Counted before the call: a failed attempt may still have been billed.
				made += parsed.n;

				const result = await generateImages({
					token: params.token,
					model: params.model,
					prompt: parsed.prompt,
					size: parsed.size,
					n: parsed.n,
					conversationId: ctx.conversationId,
					userId: ctx.userId,
					messageId: ctx.messageId,
					billHeaders: params.billHeaders,
					signal: ctx.abortSignal,
				});
				if (!result.ok) return { error: result.error };

				const seen = params.modelSeesImages === true && !params.pictureState?.unavailable;
				return {
					resultText: imageResultText(result, seen),
					extraUpdates: [
						{
							type: MessageUpdateType.CodeExecution,
							subtype: MessageCodeExecutionUpdateType.Outputs,
							runKey: `${GENERATE_IMAGE_TOOL_NAME}:${randomUUID()}`,
							files: result.files.map((file) => file.ref),
						},
					],
					...(seen
						? {
								images: imagesForModel(result),
								imagesOf: result.files.map((file) => file.ref.name).join(", "),
							}
						: {}),
				};
			},
		},
	];
}
