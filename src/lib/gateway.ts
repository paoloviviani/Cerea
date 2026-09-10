/**
 * Talking to the gateway from a page, through this app's own forwarder.
 *
 * Every call goes to `/api/v2/gateway/<path>`, which attaches the session's
 * OIDC token on the server. The browser never sees the token — putting it on
 * the page would make every extension a gateway client — so a page cannot call
 * the gateway directly even if it wanted to.
 *
 * The one thing worth stating: errors carry the **gateway's own message**.
 * Those messages are written for whoever caused them ("you have read-only
 * access to this vector store", "no active account here uses that address"),
 * and replacing them with "request failed" would throw away the only useful
 * part.
 */

import { base } from "$app/paths";

export class GatewayError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = "GatewayError";
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!response.ok) {
		let message = text || `The gateway answered ${response.status}.`;
		try {
			const parsed = JSON.parse(text) as {
				error?: { message?: string };
				detail?: string | { message?: string };
			};
			message =
				parsed.error?.message ??
				(typeof parsed.detail === "string" ? parsed.detail : parsed.detail?.message) ??
				message;
		} catch {
			/* not JSON — the raw text is the best available */
		}
		throw new GatewayError(message, response.status);
	}
	return (text ? JSON.parse(text) : null) as T;
}

const root = () => `${base}/api/v2/gateway`;

export async function gwGet<T>(path: string): Promise<T> {
	return unwrap<T>(await fetch(`${root()}/${path}`));
}

export async function gwPost<T>(path: string, body?: unknown): Promise<T> {
	return unwrap<T>(
		await fetch(`${root()}/${path}`, {
			method: "POST",
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	);
}

export async function gwDelete<T>(path: string): Promise<T> {
	return unwrap<T>(await fetch(`${root()}/${path}`, { method: "DELETE" }));
}

/** An upload, as multipart. The forwarder streams the body through unchanged. */
export async function gwUpload<T>(path: string, file: File): Promise<T> {
	const form = new FormData();
	form.append("file", file);
	// No content-type set by hand: the browser has to write the boundary, and
	// setting it manually is the classic way to produce an unparseable body.
	return unwrap<T>(await fetch(`${root()}/${path}`, { method: "POST", body: form }));
}

// -- the shapes these pages read -------------------------------------------

export interface VectorStore {
	id: string;
	created_at: number;
	name: string;
	description: string;
	file_counts: { in_progress: number; completed: number; failed: number; total: number };
	dimensions: number | null;
	embedding_model: string | null;
	owned: boolean;
	role: string;
}

export interface KnowledgeDocument {
	id: string;
	created_at: number;
	status: string;
	title: string;
	filename: string | null;
	file_id: string | null;
	source_ref: string | null;
	chunk_count: number;
	pages: number;
	chars: number;
	last_error: string | null;
	indexed_at: number | null;
}

export interface Share {
	principal_kind: "user" | "group";
	principal_id: string;
	role: "viewer" | "editor";
	email: string | null;
	created_at: number;
}

export interface Agent {
	id: string;
	model_name: string;
	name: string;
	created_at: number;
	description: string;
	model: string;
	system_prompt: string;
	tools: unknown[];
	generation: Record<string, unknown>;
	knowledge_base_ids: string[];
	retrieval_limit: number;
	retrieval_min_score: number;
	is_active: boolean;
	owned: boolean;
	role: string;
}

export interface KnowledgeStatus {
	enabled: boolean;
	ready: boolean;
	embedding_model: string | null;
	max_upload_bytes: number;
	detail: string | null;
}

export interface BillableGroup {
	id: string;
	name: string;
	description: string | null;
	is_default: boolean;
}
