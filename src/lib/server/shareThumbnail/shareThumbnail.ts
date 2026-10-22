import satori from "satori";
import { renderAsync } from "@resvg/resvg-js";

import type { SharedConversation } from "$lib/types/SharedConversation";
import { convertLegacyConversation } from "$lib/utils/tree/convertLegacyConversation";
import { extractFirstUserPrompt, renderableThumbnailText } from "$lib/utils/sharePreviewText";
import InterRegular from "$lib/server/fonts/Inter-Regular.ttf";
import InterBold from "$lib/server/fonts/Inter-Bold.ttf";
// The 1200x648 card background, vendored and inlined so rendering needs no network
import backgroundDataUri from "./thumbnail-background.png?inline";

// The element tree is built as plain objects instead of going through
// satori-html: user-authored prompt text must never be parsed as HTML
// (satori-html would follow attacker-controlled <img> URLs server-side and
// renders escaped entities literally). With plain objects, text is only ever
// a string child that satori converts to glyph outlines.
interface SatoriElement {
	type: string;
	props: {
		style?: Record<string, string | number>;
		children?: SatoriElement | SatoriElement[] | string;
		src?: string;
		width?: number;
		height?: number;
	};
}

function el(
	type: string,
	style: Record<string, string | number>,
	children?: SatoriElement | SatoriElement[] | string,
	props: Omit<SatoriElement["props"], "style" | "children"> = {}
): SatoriElement {
	return { type, props: { style, children, ...props } };
}

export interface ShareThumbnailOptions {
	/** Sanitized prompt text (see renderableThumbnailText); "" renders the generic card */
	prompt: string;
	/** The app name printed on the card */
	appName: string;
}

function shareThumbnailElement({ prompt, appName }: ShareThumbnailOptions): SatoriElement {
	const text = prompt || "A conversation shared with you";
	const fontSize = text.length <= 45 ? 68 : text.length <= 100 ? 56 : 46;

	const promptBlock = el(
		"div",
		{
			display: "block",
			lineClamp: 3,
			fontSize,
			fontWeight: 700,
			lineHeight: 1.3,
			color: "#ffffff",
			wordBreak: "break-word",
		},
		text
	);

	const continueRow = el("div", { display: "flex", alignItems: "center", marginTop: 34 }, [
		el("div", { fontSize: 30, color: "#d1d5db" }, "Continue the chat on"),
		el("div", { fontSize: 32, fontWeight: 700, color: "#ffffff", marginLeft: 14 }, appName),
	]);

	const contentColumn = el(
		"div",
		{ display: "flex", flexDirection: "column", alignItems: "flex-start", maxWidth: 760 },
		[
			promptBlock,
			// Short divider line under the prompt
			el("div", {
				width: 64,
				height: 4,
				borderRadius: 2,
				backgroundColor: "rgba(255, 255, 255, 0.55)",
				marginTop: 38,
			}),
			continueRow,
		]
	);

	return el(
		"div",
		{
			display: "flex",
			alignItems: "center",
			width: "100%",
			height: "100%",
			padding: "48px 64px",
			backgroundColor: "#000000",
			backgroundImage: `url(${backgroundDataUri})`,
		},
		contentColumn
	);
}

export const SHARE_THUMBNAIL_WIDTH = 1200;
export const SHARE_THUMBNAIL_HEIGHT = 648;

/**
 * Thumbnail text for a shared conversation: the first user prompt, falling
 * back to the title, then to "" (which renders the generic card). Used both
 * when serving the thumbnail and when pre-rendering it at share time, so the
 * two paths agree on the cache key.
 */
export function shareThumbnailPrompt(
	shared: Pick<SharedConversation, "messages" | "rootMessageId" | "preprompt" | "title">
): string {
	const { messages, rootMessageId } = convertLegacyConversation(shared);
	return (
		renderableThumbnailText(extractFirstUserPrompt(messages, rootMessageId), 240) ||
		renderableThumbnailText(shared.title ?? "", 120)
	);
}

export async function renderShareThumbnailPng(options: ShareThumbnailOptions): Promise<Uint8Array> {
	const element = shareThumbnailElement(options);

	// satori's TS types expect a ReactNode; the plain-object VNode shape above is
	// what it consumes at runtime (same cast as the model thumbnail endpoint).
	const svg = await satori(element as unknown as never, {
		width: SHARE_THUMBNAIL_WIDTH,
		height: SHARE_THUMBNAIL_HEIGHT,
		// The `*.ttf` import is an ArrayBuffer (vite plugin) but vite/client types it as a string.
		fonts: [
			{ name: "Inter", data: InterRegular as unknown as ArrayBuffer, weight: 400 },
			{ name: "Inter", data: InterBold as unknown as ArrayBuffer, weight: 700 },
		],
	});

	// renderAsync runs the rasterization on the libuv thread pool instead of
	// blocking the event loop for the ~100-300ms a render takes.
	const rendered = await renderAsync(svg, { fitTo: { mode: "original" } });

	return new Uint8Array(rendered.asPng());
}

// Shared conversations are immutable, so a rendered thumbnail never goes
// stale. Caching the promise (rather than the bytes) also deduplicates
// concurrent renders of the same card while the first one is in flight.
// ~64 entries x ~150KB PNG keeps this under ~10MB.
const THUMBNAIL_CACHE_MAX_ENTRIES = 64;
const thumbnailCache = new Map<string, Promise<Uint8Array>>();

export function getShareThumbnailPng(options: ShareThumbnailOptions): Promise<Uint8Array> {
	const key = `${options.appName}|${options.prompt}`;

	const cached = thumbnailCache.get(key);
	if (cached) {
		// Re-insert to mark as most recently used
		thumbnailCache.delete(key);
		thumbnailCache.set(key, cached);
		return cached;
	}

	const rendering = renderShareThumbnailPng(options);
	thumbnailCache.set(key, rendering);
	rendering.catch(() => {
		if (thumbnailCache.get(key) === rendering) {
			thumbnailCache.delete(key);
		}
	});

	while (thumbnailCache.size > THUMBNAIL_CACHE_MAX_ENTRIES) {
		const oldest = thumbnailCache.keys().next().value;
		if (oldest === undefined) break;
		thumbnailCache.delete(oldest);
	}

	return rendering;
}
