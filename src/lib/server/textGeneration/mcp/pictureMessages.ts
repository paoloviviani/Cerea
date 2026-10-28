import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { BuiltinToolImage } from "../builtinTools/types";
import {
	UNTRUSTED_PICTURE_INTRO_START,
	untrustedPictureIntro,
	untrustedResultFooter,
} from "../untrusted";

/** Pictures a model may be shown in one turn (look_doc): each costs about a thousand tokens or more. */
export const MAX_IMAGES_PER_TURN = 18;

/** What an older picture message becomes when a newer one replaces it. */
export const PICTURES_REMOVED =
	"[images from an earlier look_doc call removed; call look_doc again if you need them]";

export interface ToolPictures {
	id: string;
	name: string;
	/** What the pictures are of, for the intro (for example "deck.pptx, slides 2, 3"). */
	subject?: string;
	images: BuiltinToolImage[];
}

/** The first text part of a call's pictures: where they come from, and that they are content, not instructions. */
export function pictureIntro(name: string, subject?: string): string {
	return untrustedPictureIntro(name, subject);
}

/**
 * What follows a round's tool messages when a tool returned pictures: one user message of image content (a
 * tool message is text only). Placed directly after the tool messages, with no assistant message between:
 * live trials (Cortecs, mistral-small) read the pictures reliably that way and less so behind a bridge such as
 * "(looking at the pages)". Mistral, gemma and kimi accepted this order; the turn-flow guard in `runMcpFlow`
 * has no per-provider notion of strict alternation to key a bridge on, so none is added.
 */
export function pictureMessages(pictures: ToolPictures[]): ChatCompletionMessageParam[] {
	const content: Array<
		| { type: "text"; text: string }
		| { type: "image_url"; image_url: { url: string; detail: "auto" } }
	> = [];
	for (const picture of pictures) {
		content.push({ type: "text", text: pictureIntro(picture.name, picture.subject) });
		for (const image of picture.images) {
			if (!image.base64) {
				content.push({
					type: "text",
					text: `[${image.label}: could not be fitted to the model's image limits, so it is not shown]`,
				});
				continue;
			}
			content.push({ type: "text", text: `[${image.label}]` });
			content.push({
				type: "image_url",
				image_url: { url: `data:${image.mime};base64,${image.base64}`, detail: "auto" },
			});
		}
		// After the images, where a model that read them last will see it.
		content.push({ type: "text", text: untrustedResultFooter(picture.name) });
	}
	return [{ role: "user", content }];
}

/** Whether a message is one `pictureMessages` made (its first text part is the intro). */
export function isPictureMessage(message: ChatCompletionMessageParam): boolean {
	if (message.role !== "user" || !Array.isArray(message.content)) return false;
	const first = message.content[0];
	return first?.type === "text" && first.text.startsWith(UNTRUSTED_PICTURE_INTRO_START);
}

/** The request without the pictures of earlier calls: only the latest stays, the rest are a short note. */
export function withoutOlderPictures(
	messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
	return messages.map((message) =>
		isPictureMessage(message) ? { role: "user", content: PICTURES_REMOVED } : message
	);
}

/** What replaces the pictures when the endpoint refused a request that carried them. */
export const PICTURES_COULD_NOT_BE_SENT =
	"[the images could not be sent to this model; describe what you can from the text, or tell the user]";

/** What look_doc answers for the rest of a turn once pictures were refused. */
export const IMAGES_UNAVAILABLE_ERROR =
	"Images are not available on this model this turn: the endpoint rejected them. " +
	"Describe what you can from the text, or tell the user.";

/** Shared between the request loop and look_doc for one turn. */
export interface PictureState {
	unavailable: boolean;
}

/** Whether any message of the request is a picture message. */
export function hasPictureMessage(messages: ChatCompletionMessageParam[]): boolean {
	return messages.some(isPictureMessage);
}

/** The request with every picture message replaced by one text note (one note, not one per message). */
export function withoutPictures(
	messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
	const out: ChatCompletionMessageParam[] = [];
	let noted = false;
	for (const message of messages) {
		if (!isPictureMessage(message)) {
			out.push(message);
			continue;
		}
		if (noted) continue;
		noted = true;
		out.push({ role: "user", content: PICTURES_COULD_NOT_BE_SENT });
	}
	return out;
}

/** The endpoint answered "this request is not acceptable": 400 or 422. Not auth, throttling, timeouts or 5xx. */
export function isRejectedRequest(err: unknown): boolean {
	const status =
		typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
	return status === 400 || status === 422;
}
