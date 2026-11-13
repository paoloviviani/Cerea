/**
 * "Check for updates": the only outward request the Services page makes, and
 * only when an administrator presses the button.
 *
 * Two plain unauthenticated GETs to the GitHub releases API (the latest Cerea
 * release and the latest Pystino release), a generic User-Agent, a short
 * deadline. Nothing is sent about this deployment, nothing runs in the
 * background, and offline or rate-limited is an answer, not an error.
 */

import { APP_VERSION } from "$lib/utils/appVersion";
import { probeGateway } from "./probes";
import { shortParam } from "./types";

export const CEREA_REPO = "paoloviviani/Cerea";
export const PYSTINO_REPO = "paoloviviani/Pystino";
const TIMEOUT_MS = 5_000;

export type UpdateState = "current" | "available" | "unknown" | "offline" | "rate_limited";

export interface ProductUpdate {
	/** The running version, or null when it cannot be told (Pystino without a version). */
	running: string | null;
	state: UpdateState;
	/** The latest release's version, without the leading `v`. */
	latest?: string;
	/** The release page, always on github.com. */
	url?: string;
}

export interface UpdateReport {
	cerea: ProductUpdate;
	pystino: ProductUpdate;
}

/** `1.2.3` (a leading `v` and anything after a `-` or `+` ignored) as numbers, or null. */
export function parseVersion(text: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim());
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `latest` is a higher version than `running`. */
export function isNewer(latest: string, running: string): boolean {
	const a = parseVersion(latest);
	const b = parseVersion(running);
	if (!a || !b) return false;
	for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
	return false;
}

async function latestRelease(repo: string, running: string | null): Promise<ProductUpdate> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { accept: "application/vnd.github+json", "user-agent": "cerea-update-check" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch {
		return { running, state: "offline" };
	}
	// GitHub answers a limited anonymous caller with 403 or 429.
	if (response.status === 403 || response.status === 429) return { running, state: "rate_limited" };
	if (!response.ok) return { running, state: "unknown" };
	let body: { tag_name?: unknown; html_url?: unknown };
	try {
		body = (await response.json()) as typeof body;
	} catch {
		return { running, state: "unknown" };
	}
	const tag = typeof body.tag_name === "string" ? body.tag_name : "";
	const latest = parseVersion(tag) ? tag.replace(/^v/, "") : null;
	if (!latest) return { running, state: "unknown" };
	const expected = `https://github.com/${repo}/releases/`;
	const url =
		typeof body.html_url === "string" && body.html_url.startsWith(expected)
			? body.html_url
			: `https://github.com/${repo}/releases/tag/v${latest}`;
	if (!running) return { running, state: "unknown", latest: shortParam(latest), url };
	return {
		running,
		state: isNewer(latest, running) ? "available" : "current",
		latest: shortParam(latest),
		url,
	};
}

export async function checkForUpdates(token: string | undefined): Promise<UpdateReport> {
	const gateway = await probeGateway(token).catch(() => null);
	const [cerea, pystino] = await Promise.all([
		latestRelease(CEREA_REPO, APP_VERSION),
		latestRelease(PYSTINO_REPO, gateway?.version ?? null),
	]);
	return { cerea, pystino };
}
