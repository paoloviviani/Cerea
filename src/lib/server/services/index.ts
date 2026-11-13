/**
 * The Services report: every probe at once, remembered for 30 seconds.
 *
 * Each probe runs under its own deadline and cannot fail the report: a probe
 * that throws or hangs becomes one red (or amber) row. The remembered answer is
 * shared by every administrator, and a second request that arrives while a run
 * is under way joins it rather than starting another.
 */

import { logger } from "$lib/server/logger";
import {
	fetchCatalogue,
	probeBlobs,
	probeBrowser,
	probeDocuments,
	probeEmbedding,
	probeExtractor,
	probeFetch,
	probeGalopin,
	probeGateway,
	probeImage,
	probeLocal,
	probeMail,
	probeMcp,
	probeOffice,
	probeRedaction,
	probeSandbox,
	probeSchedules,
	probeSearch,
	probeTranscription,
	type ProbeContext,
} from "./probes";
import type { ProbeResult, ServiceId, ServiceRow, ServicesReport } from "./types";

export const CACHE_MS = 30_000;
/** The longest one probe may take before its row says so. */
export const PROBE_DEADLINE_MS = 8_000;

// The remembered report is shared by every administrator, and it is the first
// one's view: the model-catalogue rows (reader, embedding, search, image,
// transcription) depend on what that caller's token may list. There is no
// admin-scoped catalogue endpoint to build it from instead.
let cache: { at: number; report: ServicesReport } | null = null;
let running: Promise<ServicesReport> | null = null;

export function resetServicesCache(): void {
	cache = null;
	running = null;
}

async function guarded(id: ServiceId, work: () => Promise<ProbeResult>): Promise<ServiceRow> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			work(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("deadline")), PROBE_DEADLINE_MS);
			}),
		]);
		return { id, ...result };
	} catch (err) {
		const timedOut = err instanceof Error && err.message === "deadline";
		// The cause goes to the log; the row gets only a code.
		logger.warn({ id, err: String(err) }, "services_probe_failed");
		return { id, health: "down", note: timedOut ? "timed_out" : "probe_failed" };
	} finally {
		clearTimeout(timer);
	}
}

async function run(token: string | undefined): Promise<ServicesReport> {
	let catalogue: Promise<Awaited<ReturnType<typeof fetchCatalogue>>> | undefined;
	const ctx: ProbeContext = {
		token,
		catalogue: () => (catalogue ??= fetchCatalogue(token)),
	};
	const rows = await Promise.all([
		guarded("gateway", async () => {
			const { health, note, param } = await probeGateway(token);
			return { health, note, param };
		}),
		guarded("extractor", () => probeExtractor(ctx)),
		guarded("embedding", () => probeEmbedding(ctx)),
		guarded("redaction", probeRedaction),
		guarded("documents", probeDocuments),
		guarded("office", probeOffice),
		guarded("fetch", probeFetch),
		guarded("search", () => probeSearch(ctx)),
		guarded("image", () => probeImage(ctx)),
		guarded("transcription", () => probeTranscription(ctx)),
		guarded("mcp", probeMcp),
		guarded("blobs", probeBlobs),
		guarded("galopin", probeGalopin),
		guarded("schedules", () => probeSchedules()),
		guarded("mail", probeMail),
		guarded("browser", probeBrowser),
		guarded("local", probeLocal),
		guarded("sandbox", probeSandbox),
	]);
	return { checkedAt: new Date().toISOString(), cached: false, rows };
}

/** The report: the remembered one while it is under 30 seconds old, unless `refresh`. */
export async function servicesReport(
	token: string | undefined,
	options: { refresh?: boolean; now?: number } = {}
): Promise<ServicesReport> {
	const now = options.now ?? Date.now();
	if (!options.refresh && cache && now - cache.at < CACHE_MS) {
		return { ...cache.report, cached: true };
	}
	if (running) return running;
	running = run(token)
		.then((report) => {
			cache = { at: options.now ?? Date.now(), report };
			return report;
		})
		.finally(() => {
			running = null;
		});
	return running;
}
