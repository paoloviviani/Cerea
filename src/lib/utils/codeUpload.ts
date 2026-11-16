import {
	UPLOAD_MAX_BATCH_BYTES,
	UPLOAD_MAX_BATCH_FILES,
	UPLOAD_MAX_FILE_BYTES,
} from "$lib/constants/transfer";

/** One file to upload, with its path relative to the open folder ("a/b.txt";
 * a plain file is just its name, a folder's files keep the folder's name). */
export interface UploadItem {
	file: File;
	rel: string;
}

/** Files from `<input type=file>` (or `webkitdirectory`, whose files carry
 * their path in `webkitRelativePath`). */
export function itemsFromFiles(list: FileList | File[]): UploadItem[] {
	return Array.from(list).map((file) => ({
		file,
		rel: file.webkitRelativePath ? file.webkitRelativePath : file.name,
	}));
}

interface EntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
	file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
	createReader?: () => {
		readEntries: (ok: (e: EntryLike[]) => void, fail: (e: unknown) => void) => void;
	};
}

/** Everything under a dropped entry, folders walked recursively. `readEntries`
 * answers in batches, so it is called until it answers none. An unreadable
 * entry is skipped. */
async function walkEntry(entry: EntryLike, prefix: string, out: UploadItem[]): Promise<void> {
	if (entry.isFile && entry.file) {
		const file = await new Promise<File | null>((ok) => entry.file?.(ok, () => ok(null)));
		if (file) out.push({ file, rel: `${prefix}${entry.name}` });
		return;
	}
	if (entry.isDirectory && entry.createReader) {
		const reader = entry.createReader();
		for (;;) {
			const batch = await new Promise<EntryLike[]>((ok) => reader.readEntries(ok, () => ok([])));
			if (batch.length === 0) break;
			for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
		}
	}
}

/** The files of a drop, folders included. The entries are taken first and
 * synchronously (the data transfer empties once the handler awaits). */
export async function itemsFromDrop(data: DataTransfer): Promise<UploadItem[]> {
	const entries: EntryLike[] = [];
	for (const item of Array.from(data.items ?? [])) {
		if (item.kind !== "file") continue;
		const entry = (
			item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }
		).webkitGetAsEntry?.();
		if (entry) entries.push(entry);
	}
	if (entries.length === 0) return itemsFromFiles(Array.from(data.files ?? []));
	const out: UploadItem[] = [];
	for (const entry of entries) await walkEntry(entry, "", out);
	return out;
}

export type BatchProblem =
	| { kind: "too_many"; count: number; limit: number }
	| { kind: "too_big"; bytes: number; limit: number };

/** The limits of one pick or drop: how many files and how many bytes in all.
 * (A single file over the per-file cap is refused on its own row.) */
export function batchProblem(items: UploadItem[]): BatchProblem | null {
	if (items.length > UPLOAD_MAX_BATCH_FILES) {
		return { kind: "too_many", count: items.length, limit: UPLOAD_MAX_BATCH_FILES };
	}
	const bytes = items.reduce((sum, item) => sum + item.file.size, 0);
	if (bytes > UPLOAD_MAX_BATCH_BYTES) {
		return { kind: "too_big", bytes, limit: UPLOAD_MAX_BATCH_BYTES };
	}
	return null;
}

export const overFileLimit = (item: UploadItem) => item.file.size > UPLOAD_MAX_FILE_BYTES;

/** `a/b/c.txt` under the open folder `dir` ("." for the workspace folder). */
export function joinPath(dir: string, rel: string): string {
	return dir === "." ? rel : `${dir}/${rel}`;
}

export function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "." : path.slice(0, i);
}
