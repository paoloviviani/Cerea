import { getExecutionSession } from "$lib/utils/execution/runtime";
import { cachedFileBytes } from "$lib/utils/execution/fileIdentity";

/**
 * Where the bytes of a produced file come from, and how they reach the
 * person: shared by the file card, the artifact panel and the pre-open
 * preview paths, so none keeps its own copy of "which source holds them".
 */
export interface FileByteSource {
	file: { path: string; size: number };
	/** sha256 of the bytes: this tab's own copy is used when it still holds them. */
	sha256?: string;
	/** Direct-emission blocks carry their own text: the block content IS the file. */
	inlineContent?: string;
	/** The output store's URL for the file, once it is stored. */
	downloadUrl?: string;
}

/**
 * The bytes, always as transferable data (never through the capped text
 * output). Order: this tab's own fingerprinted copy, inline content, the
 * store, the sandbox.
 */
export async function readFileBytes(
	source: FileByteSource
): Promise<ArrayBuffer | Uint8Array<ArrayBuffer>> {
	const kept = source.sha256 ? cachedFileBytes(source.sha256) : undefined;
	if (kept) return kept as Uint8Array<ArrayBuffer>;
	if (source.inlineContent !== undefined) return new TextEncoder().encode(source.inlineContent);
	if (source.downloadUrl !== undefined) {
		const res = await fetch(source.downloadUrl);
		if (!res.ok) throw new Error("that file is no longer available");
		return await res.arrayBuffer();
	}
	const session = getExecutionSession();
	if (!session) throw new Error("the execution sandbox is not available in this context");
	return session.readFile(source.file.path);
}

/** Hand bytes to the browser as a download under `name`. */
export function triggerBrowserDownload(
	name: string,
	data: ArrayBuffer | Uint8Array<ArrayBuffer>
): void {
	const url = URL.createObjectURL(new Blob([data]));
	try {
		const link = window.document.createElement("a");
		link.href = url;
		link.download = name;
		link.rel = "noopener";
		window.document.body.appendChild(link);
		link.click();
		link.remove();
	} finally {
		URL.revokeObjectURL(url);
	}
}
