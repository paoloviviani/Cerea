import { MAX_FILE_BYTES, MOUNT_ROOT } from "./protocol";
import type { ExecutionSession } from "./runtime";

/**
 * Host-side file loading: fetch within the runtime's 50 MB boundary, then
 * hand the bytes to the worker.
 *
 * The cap is a pre-fetch boundary on purpose. A Content-Length over the cap
 * aborts before the body is read; a missing one is handled by streaming with
 * a hard stop, so an oversized file is refused by name and number — never
 * downloaded in full and then discarded, and never silently truncated.
 */

function overCapError(bytes: number): Error {
	return new Error(
		`this file is ${(bytes / (1024 * 1024)).toFixed(1)} MB; the runtime accepts files up to 50 MB`
	);
}

async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The body is already dead or the stream unsupported; nothing to free.
	}
}

export async function fetchWithinCap(
	url: string,
	maxBytes: number = MAX_FILE_BYTES
): Promise<ArrayBuffer> {
	const response = await fetch(url, { credentials: "same-origin" });
	if (!response.ok) {
		// The app's own endpoints answer errors as JSON with a human message;
		// surface it rather than a bare status code.
		let detail = "";
		try {
			const body = (await response.json()) as { error?: { message?: string } };
			detail = typeof body.error?.message === "string" ? body.error.message : "";
		} catch {
			// Not JSON; fall back to the status alone.
		}
		throw new Error(detail || `the request failed (${response.status})`);
	}

	const declared = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declared) && declared > 0) {
		if (declared > maxBytes) {
			await discardBody(response);
			throw overCapError(declared);
		}
		return response.arrayBuffer();
	}

	const reader = response.body?.getReader();
	if (!reader) return response.arrayBuffer();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await discardBody(response);
			throw overCapError(total);
		}
		chunks.push(value);
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined.buffer;
}

export interface KnowledgeFileRef {
	storeId: string;
	storeName: string;
	documentId: string;
	title: string;
	filename: string | null;
}

export interface MountedFile {
	path: string;
	name: string;
}

/**
 * Every knowledge document the caller can read, across every base reachable
 * with their own identity. Only indexed-ready documents are offered: a
 * pending or failed row has no text to analyze yet, and mounting it would
 * hand the runtime an empty file with a confusing silence behind it.
 */
export async function listKnowledgeFiles(): Promise<KnowledgeFileRef[]> {
	const storesResponse = await fetch("/api/v2/gateway/vector_stores", {
		credentials: "same-origin",
	});
	if (!storesResponse.ok) {
		throw new Error(`could not list knowledge bases (${storesResponse.status})`);
	}
	const stores = (await storesResponse.json()) as {
		data: Array<{ id: string; name: string }>;
	};
	const refs: KnowledgeFileRef[] = [];
	for (const store of stores.data) {
		const docsResponse = await fetch(`/api/v2/gateway/vector_stores/${store.id}/files`, {
			credentials: "same-origin",
		});
		if (!docsResponse.ok) {
			// One unreadable base must not sink the whole picker.
			continue;
		}
		const docs = (await docsResponse.json()) as {
			data: Array<{ id: string; title: string; filename: string | null; status: string }>;
		};
		for (const doc of docs.data) {
			if (doc.status !== "ready") continue;
			refs.push({
				storeId: store.id,
				storeName: store.name,
				documentId: doc.id,
				title: doc.title,
				filename: doc.filename,
			});
		}
	}
	return refs;
}

/**
 * Fetch one knowledge document's indexed text and write it into the runtime
 * at /mnt/data/<filename>. The document's text is what retrieval serves;
 * original uploads stay behind the forwarder's deliberate boundary.
 */
export async function mountKnowledgeFile(
	session: ExecutionSession,
	ref: KnowledgeFileRef
): Promise<MountedFile> {
	const bytes = await fetchWithinCap(
		`/api/v2/gateway/vector_stores/${ref.storeId}/files/${ref.documentId}/content`
	);
	const body = JSON.parse(new TextDecoder().decode(bytes)) as {
		filename?: string | null;
		title?: string;
		text?: string;
	};
	const name = body.filename || ref.title || "document.txt";
	const written = await session.loadFiles([{ name, data: body.text ?? "" }]);
	return { path: written[0] ?? `${MOUNT_ROOT}/${name}`, name };
}

/**
 * Mount a file attached to a chat message. Attachment bytes are served by the
 * existing conversation-output route, which already authenticates against the
 * conversation (or its share) and reports Content-Length — the cap does the
 * rest before anything is read.
 */
export async function mountConversationFile(
	session: ExecutionSession,
	conversationId: string,
	file: { name: string; value: string }
): Promise<MountedFile> {
	const bytes = await fetchWithinCap(`/conversation/${conversationId}/output/${file.value}`);
	const written = await session.loadFiles([{ name: file.name, data: bytes }]);
	return { path: written[0] ?? `${MOUNT_ROOT}/${file.name}`, name: file.name };
}
