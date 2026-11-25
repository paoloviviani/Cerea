/** Reading what a server answers while it is only being checked: bounded in size, never followed, never signed in. */

export class TooLarge extends Error {}

/** The whole body, or TooLarge as soon as it passes `max` bytes (a server cannot make the app buffer more). */
export async function readCapped(
	body: ReadableStream<Uint8Array> | null,
	max: number
): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			void reader.cancel().catch(() => {});
			throw new TooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

type Response = {
	status: number;
	headers: { get(n: string): string | null };
	body: ReadableStream<Uint8Array> | null;
};
type NetFetch = (
	url: string,
	init: { signal: AbortSignal; redirect: "manual"; credentials: "omit" }
) => Promise<Response>;

const ICON_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/x-icon",
	"image/vnd.microsoft.icon",
]);

/** The probe's `fetch`: status, headers and a `text()` that stops at 64 KB. */
export function cappedFetch(net: NetFetch, max = 64 * 1024) {
	return async (url: string, init: { signal: AbortSignal; redirect: "manual" }) => {
		const res = await net(url, { signal: init.signal, redirect: "manual", credentials: "omit" });
		return {
			status: res.status,
			headers: res.headers,
			text: async () => new TextDecoder().decode(await readCapped(res.body, max)),
		};
	};
}

/** An icon as a data URL: a raster image type only (no SVG), at most 200 KB, from a 200 answer. */
export function iconFetcher(net: NetFetch) {
	return async (url: string): Promise<string | undefined> => {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), 8000);
		try {
			const res = await net(url, { signal: ac.signal, redirect: "manual", credentials: "omit" });
			const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
			if (res.status !== 200 || !ICON_TYPES.has(type)) return undefined;
			const bytes = await readCapped(res.body, 200 * 1024);
			return `data:${type === "image/vnd.microsoft.icon" ? "image/x-icon" : type};base64,${Buffer.from(bytes).toString("base64")}`;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	};
}
