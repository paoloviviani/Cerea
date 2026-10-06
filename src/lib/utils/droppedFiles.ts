/**
 * What a drop contains, with folders told apart from files.
 *
 * A dropped directory arrives as a `File` too (empty, or 4 KB of nothing),
 * which is how it ends up "uploaded" and failing. The one reliable tell is the
 * entry behind the item: `webkitGetAsEntry().isDirectory`. Used where whole
 * folders must be refused (a project's context documents).
 */
export function readDrop(transfer: DataTransfer): { files: File[]; folders: number } {
	const files: File[] = [];
	let folders = 0;
	const items = [...(transfer.items ?? [])];
	if (items.length === 0) return { files: [...transfer.files], folders: 0 };
	for (const item of items) {
		if (item.kind !== "file") continue;
		if (item.webkitGetAsEntry?.()?.isDirectory) {
			folders++;
			continue;
		}
		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return { files, folders };
}
