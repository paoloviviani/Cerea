/**
 * Calling the gateway from this server, as the signed-in person.
 *
 * The browser's route to the gateway is the allowlisted forwarder under
 * `/api/v2/gateway`; this is the other half, for work the server does on its
 * own account — retrieving a project's passages before a generation, indexing a
 * finished exchange. There is no allowlist here because there is no untrusted
 * caller: the path is written in this file's callers, not received from anyone.
 *
 * It always acts as the *user*, never with a deployment-wide credential. That
 * matters more than it looks: retrieval must see exactly the knowledge bases
 * the person reading the answer can see, and a service key would see all of
 * them. Sharing a project would then leak documents, which is the one thing
 * ADR 0062 says it must not do.
 */

import { config } from "$lib/server/config";

export class GatewayCallFailed extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = "GatewayCallFailed";
	}
}

/** The gateway did not answer within the deadline the caller set. A 504 so that
 * everything keyed on `GatewayCallFailed.status` already treats it as the
 * server-side failure it is; `elapsedMs` is for the log. */
export class GatewayTimeout extends GatewayCallFailed {
	constructor(
		readonly elapsedMs: number,
		readonly timeoutMs: number
	) {
		super(504, `The gateway did not answer within ${Math.round(timeoutMs / 1000)}s.`);
		this.name = "GatewayTimeout";
	}
}

export interface CallOptions {
	/** Give up after this long (the whole exchange, body included). Unset keeps
	 * the runtime's own default, which is what short control calls want. */
	timeoutMs?: number;
}

function base(): string {
	if (!config.OPENAI_BASE_URL) {
		throw new GatewayCallFailed(503, "The service behind this is not set up.");
	}
	return config.OPENAI_BASE_URL.replace(/\/$/, "");
}

async function call<T>(
	token: string,
	path: string,
	init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
	options: CallOptions = {}
): Promise<T> {
	const started = Date.now();
	let response: Response;
	try {
		response = await fetch(`${base()}/${path}`, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
		});
	} catch (err) {
		if (options.timeoutMs && err instanceof Error && err.name === "TimeoutError") {
			throw new GatewayTimeout(Date.now() - started, options.timeoutMs);
		}
		throw err;
	}
	if (!response.ok) {
		// The gateway's own message, which is written for whoever caused it.
		let detail = `The gateway answered ${response.status}.`;
		try {
			const parsed = (await response.json()) as { error?: { message?: string } };
			if (parsed?.error?.message) detail = parsed.error.message;
		} catch {
			/* a non-JSON body: the status is all there is to report */
		}
		throw new GatewayCallFailed(response.status, detail);
	}
	try {
		return (await response.json()) as T;
	} catch (err) {
		// The deadline covers the body too: headers can arrive early and the
		// document's text still be streaming when it passes.
		if (options.timeoutMs && err instanceof Error && err.name === "TimeoutError") {
			throw new GatewayTimeout(Date.now() - started, options.timeoutMs);
		}
		throw err;
	}
}

export const gateway = {
	get: <T>(token: string, path: string) => call<T>(token, path, { method: "GET" }),
	post: <T>(token: string, path: string, body?: unknown, options?: CallOptions) =>
		call<T>(token, path, { method: "POST", body: body ?? {} }, options),
	del: <T>(token: string, path: string) => call<T>(token, path, { method: "DELETE" }),
};

export interface GatewaySearchHit {
	document_id: string;
	chunk_id: string;
	ordinal: number;
	score: number;
	text: string;
	title: string | null;
	source_ref: string | null;
}

export interface GatewayVectorStore {
	id: string;
	name: string;
	description: string;
	owned: boolean;
	role: string;
	file_counts: { in_progress: number; completed: number; failed: number; total: number };
}

export interface GatewayGroup {
	id: string;
	name: string;
}
