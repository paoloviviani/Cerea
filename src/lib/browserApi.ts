/**
 * The browser's calls for opening the browser (ADR 0116, C109): the ready computers, "Open
 * browser", and the default computer. Plain JSON endpoints under `/api/v2/browser`; the server
 * checks that every computer named here is the caller's own.
 */
import { base } from "$app/paths";

export interface BrowserComputer {
	id: string;
	name: string;
	/** The user's default for browsing. */
	default: boolean;
	/** The computer this conversation already uses. */
	current: boolean;
}

export class BrowserApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** `busy`, `denied`, `runtime`: what the server called it. */
		readonly code?: string
	) {
		super(message);
		this.name = "BrowserApiError";
	}
}

async function unwrap<T>(response: Response): Promise<T> {
	if (response.ok) return (await response.json()) as T;
	const body = (await response.json().catch(() => null)) as {
		message?: string;
		error?: string;
	} | null;
	throw new BrowserApiError(
		body?.message ?? `The request failed (${response.status}).`,
		response.status,
		body?.error
	);
}

/** The ready computers, the default first. Empty when browser use is off or none is ready. */
export async function listBrowserComputers(conversationId?: string): Promise<BrowserComputer[]> {
	const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : "";
	try {
		const response = await fetch(`${base}/api/v2/browser/computers${query}`, {
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) return [];
		return ((await response.json()) as { computers: BrowserComputer[] }).computers ?? [];
	} catch {
		return [];
	}
}

/** Opens a page on a computer. With a conversation, the page is tied to it. */
export async function openBrowser(options: {
	deviceId: string;
	url?: string;
	conversationId?: string;
}): Promise<{ computer: string; title: string; url: string; tied: boolean }> {
	return unwrap(
		await fetch(`${base}/api/v2/browser/open`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(options),
			signal: AbortSignal.timeout(60_000),
		})
	);
}

/** Makes a computer the default for browsing, or clears it with `null`. */
export async function setBrowserDefault(deviceId: string | null): Promise<void> {
	await unwrap(
		await fetch(`${base}/api/v2/browser/default`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ deviceId }),
			signal: AbortSignal.timeout(20_000),
		})
	);
}
