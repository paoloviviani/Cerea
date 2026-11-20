/** Raster formats the server makes thumbnails of (`?thumb=`); the tile asks for one only for these. */
export const THUMBNAILABLE_MIMES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);

export function isThumbnailable(mime: string | undefined): boolean {
	const type = mime?.split(";")[0]?.trim().toLowerCase();
	return type !== undefined && THUMBNAILABLE_MIMES.has(type);
}
