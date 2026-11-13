/**
 * One probe per service. Each answers `{ health, note, param? }` and nothing
 * else: no URL, no hostname, no error text leaves this file (an error becomes
 * a code). They run in parallel from `index.ts`, each under its own deadline.
 *
 * Where the deployment already has the answer (the web-search and fetch
 * resolution, the documents capabilities cache, the Playwright probe, the
 * stored connector check) it is reused rather than asked again.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { resolveExtractor } from "$lib/server/knowledge/extractorResolution";
import { resolveWebSearch } from "$lib/server/webSearch/resolution";
import { envWebSearchModel } from "$lib/server/webSearch/config";
import { envImageModel, resolveImage, storedImageModel } from "$lib/server/imageGeneration";
import {
	envTranscriptionModel,
	resolveTranscription,
	storedTranscriptionModel,
} from "$lib/server/transcription";
import { getCapabilities, isDocumentsConfigured } from "$lib/server/documents/client";
import { gotenbergUrl } from "$lib/server/office/gotenberg";
import { configuredBackend } from "$lib/server/fetching";
import { probePlaywrightHealth } from "$lib/server/fetching/playwright";
import { getMcpServers } from "$lib/server/mcp/registry";
import { sealingAvailable } from "$lib/server/mcp/secretBox";
import { OPENCODE_VERSION } from "$lib/codeEnrollCommand";
import { galopinDistDir, GALOPIN_BINARIES, parseSha256Sums } from "$lib/server/galopinDist";
import { schedulesEnabled } from "$lib/server/schedules/limits";
import { lastTickAt, TICK_MS } from "$lib/server/schedules/scheduler";
import { browserSettings } from "$lib/server/browser/settings";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { isMachineOnline } from "$lib/server/code/machines";
import { shortParam, type ProbeResult } from "./types";

export interface Card {
	id: string;
	kind: string;
	local: boolean;
}

export interface ProbeContext {
	token: string | undefined;
	/** The gateway's model catalogue for this caller, fetched once; null when it could not be read. */
	catalogue: () => Promise<Card[] | null>;
}

const SHORT_MS = 3_000;

/** Settings that may not exist in this build (a sandbox, a mail host): read defensively. */
const optional = new Proxy({} as Record<string, string | undefined>, {
	get: (_, key) => (config as unknown as Record<string, string | undefined>)[key as string],
});

export const off = (): ProbeResult => ({ health: "off", note: "not_configured" });

interface Answer {
	status: number;
	body: unknown;
	headers: Headers;
}

/** A plain GET with a short deadline. Throws on a network failure or a timeout. */
async function get(url: string, headers: Record<string, string> = {}): Promise<Answer> {
	const response = await fetch(url, {
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(SHORT_MS),
	});
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		/* not JSON: the status is the answer */
	}
	return { status: response.status, body, headers: response.headers };
}

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

function field(body: unknown, key: string): unknown {
	return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

// -- the gateway -----------------------------------------------------------------

export interface GatewayHealth extends ProbeResult {
	/** The gateway's own version, when it says; never guessed. */
	version: string | null;
}

/** The gateway's origin: the `/v1` base without `/v1`, where `/readyz` lives. */
function gatewayOrigin(): string {
	return trimSlash(config.OPENAI_BASE_URL ?? "").replace(/\/v1$/, "");
}

export async function probeGateway(token: string | undefined): Promise<GatewayHealth> {
	if (!config.OPENAI_BASE_URL) return { ...off(), version: null };
	let answer: Answer | null = null;
	try {
		answer = await get(`${gatewayOrigin()}/readyz`);
	} catch {
		answer = null;
	}
	const version =
		shortParam(field(answer?.body, "version")) ??
		shortParam(answer?.headers.get("x-pystino-version")) ??
		shortParam(config.PYSTINO_VERSION) ??
		null;
	const status = field(answer?.body, "status");
	if (answer && (answer.status === 200 || answer.status === 503) && typeof status === "string") {
		if (answer.status === 503) return { health: "down", note: "gateway_not_ready", version };
		return status === "ok"
			? { health: "ok", note: "gateway_ok", version }
			: { health: "degraded", note: "gateway_degraded", version };
	}
	// `/readyz` is not served on this address (a proxy in front shows only `/v1`):
	// ask the one route that always is, as the signed-in administrator.
	if (token) {
		try {
			const me = await get(trimSlash(config.OPENAI_BASE_URL) + "/me", {
				authorization: `Bearer ${token}`,
			});
			if (me.status === 200) return { health: "ok", note: "gateway_ok", version };
		} catch {
			/* fall through */
		}
	}
	return { health: "down", note: "gateway_down", version };
}

// -- the model catalogue ---------------------------------------------------------

export async function fetchCatalogue(token: string | undefined): Promise<Card[] | null> {
	if (!token || !config.OPENAI_BASE_URL) return null;
	try {
		const answer = await get(
			`${trimSlash(config.OPENAI_BASE_URL)}/models?include=chat,embedding,image,ocr,transcription,search`,
			{ authorization: `Bearer ${token}` }
		);
		if (answer.status !== 200) return null;
		const data = field(answer.body, "data");
		if (!Array.isArray(data)) return null;
		return data
			.filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
			.filter((c) => typeof c.id === "string" && typeof c.kind === "string")
			.map((c) => ({ id: c.id as string, kind: c.kind as string, local: c.local === true }));
	} catch {
		return null;
	}
}

const ids = (cards: Card[], kind: string) => cards.filter((c) => c.kind === kind).map((c) => c.id);

async function knowledgeRow() {
	try {
		return await collections.knowledgeConfig.findOne({});
	} catch {
		return null;
	}
}

export async function probeExtractor(ctx: ProbeContext): Promise<ProbeResult> {
	if (config.CHAT_OCR_BASE_URL?.trim()) return { health: "unknown", note: "extractor_direct" };
	const cards = await ctx.catalogue();
	if (!cards) return { health: "degraded", note: "catalogue_down" };
	const row = await knowledgeRow();
	const resolved = resolveExtractor({
		envModel: config.CHAT_OCR_MODEL?.trim() || null,
		storedModel: row?.extractorModel?.trim() || null,
		candidates: cards.filter((c) => c.kind === "ocr").map((c) => ({ id: c.id, local: c.local })),
	});
	if (!resolved.model) return { health: "off", note: "extractor_none" };
	const listed = ids(cards, "ocr").includes(resolved.model);
	// A model an administrator or the env named that the catalogue no longer lists.
	if (!listed && (resolved.source === "env" || resolved.source === "stored")) {
		return { health: "degraded", note: "extractor_missing", param: shortParam(resolved.model) };
	}
	return { health: "ok", note: "extractor_ok", param: shortParam(resolved.model) };
}

export async function probeEmbedding(ctx: ProbeContext): Promise<ProbeResult> {
	if (!knowledgeEnabled()) return { health: "off", note: "knowledge_off" };
	const row = await knowledgeRow();
	const model = row?.embeddingModel?.trim();
	if (!model) return { health: "off", note: "embedding_unset" };
	const cards = await ctx.catalogue();
	if (!cards) return { health: "degraded", note: "catalogue_down", param: shortParam(model) };
	return ids(cards, "embedding").includes(model)
		? { health: "ok", note: "embedding_ok", param: shortParam(model) }
		: { health: "degraded", note: "embedding_missing", param: shortParam(model) };
}

// -- redaction -------------------------------------------------------------------

/** The kit's service name; used when nothing says otherwise, and "not there" then means off. */
const DEFAULT_REDACTION = "http://redaction:8080";

export async function probeRedaction(): Promise<ProbeResult> {
	const named = config.CHAT_REDACTION_URL?.trim();
	const url = trimSlash(named || DEFAULT_REDACTION);
	let answer: Answer;
	try {
		answer = await get(`${url}/healthz`);
	} catch {
		// A guessed address that does not answer means the profile is not running
		// here; an address somebody set that does not answer is a fault.
		return named ? { health: "down", note: "redaction_down" } : off();
	}
	if (answer.status !== 200) return { health: "down", note: "redaction_down" };
	if (field(answer.body, "status") !== "ok")
		return { health: "degraded", note: "redaction_degraded" };
	const engine = String(field(answer.body, "engine") ?? "");
	if (/^(noop|none|disabled)$/i.test(engine)) return off();
	const slots = field(answer.body, "ner_engines");
	const ner =
		Array.isArray(slots) &&
		slots.some(
			(s) => !!s && typeof s === "object" && (s as { available?: unknown }).available === true
		);
	return { health: "ok", note: ner ? "redaction_ner" : "redaction_pattern" };
}

// -- documents and previews ------------------------------------------------------

export async function probeDocuments(): Promise<ProbeResult> {
	if (!isDocumentsConfigured()) return off();
	const caps = await getCapabilities();
	return caps ? { health: "ok", note: "documents_ok" } : { health: "down", note: "documents_down" };
}

export async function probeOffice(): Promise<ProbeResult> {
	const url = gotenbergUrl();
	if (!url) return off();
	try {
		const answer = await get(`${url}/health`);
		if (answer.status !== 200) return { health: "down", note: "office_down" };
		const status = field(answer.body, "status");
		return status === undefined || status === "up"
			? { health: "ok", note: "office_ok" }
			: { health: "degraded", note: "office_degraded" };
	} catch {
		return { health: "down", note: "office_down" };
	}
}

// -- fetching and search ---------------------------------------------------------

export async function probeFetch(): Promise<ProbeResult> {
	const backend = configuredBackend();
	if (!config.PLAYWRIGHT_WS_ENDPOINT?.trim()) {
		return backend === "playwright"
			? { health: "down", note: "fetch_down" }
			: { health: "off", note: "fetch_direct" };
	}
	const health = await probePlaywrightHealth();
	if (!health.reachable) {
		// Only a fault when pages are actually sent there.
		return backend === "playwright"
			? { health: "down", note: "fetch_down" }
			: { health: "degraded", note: "fetch_down" };
	}
	return { health: "ok", note: backend === "playwright" ? "fetch_browser" : "fetch_standby" };
}

export async function probeSearch(ctx: ProbeContext): Promise<ProbeResult> {
	const cards = await ctx.catalogue();
	if (!cards) return { health: "degraded", note: "catalogue_down" };
	let stored: string | null = null;
	try {
		stored = (await knowledgeRow())?.webSearchModel?.trim() || null;
	} catch {
		stored = null;
	}
	const resolved = resolveWebSearch({
		envModel: envWebSearchModel(),
		storedModel: stored,
		granted: ids(cards, "search"),
	});
	if (!resolved.available) return { health: "off", note: "search_none" };
	if (resolved.stale) return { health: "degraded", note: "search_stale" };
	return resolved.model
		? { health: "ok", note: "search_ok", param: shortParam(resolved.model) }
		: { health: "ok", note: "search_policy" };
}

export async function probeImage(ctx: ProbeContext): Promise<ProbeResult> {
	const cards = await ctx.catalogue();
	if (!cards) return { health: "degraded", note: "catalogue_down" };
	let stored: string | null = null;
	try {
		stored = await storedImageModel();
	} catch {
		stored = null;
	}
	const candidates = ids(cards, "image");
	const env = envImageModel();
	const resolved = resolveImage({
		storedModel: stored,
		envModel: env,
		candidates: stored || env ? [] : candidates,
	});
	if (!resolved.model || !candidates.includes(resolved.model)) {
		return { health: "off", note: "image_none" };
	}
	return { health: "ok", note: "image_ok", param: shortParam(resolved.model) };
}

export async function probeTranscription(ctx: ProbeContext): Promise<ProbeResult> {
	const cards = await ctx.catalogue();
	if (!cards) return { health: "degraded", note: "catalogue_down" };
	let stored: string | null = null;
	try {
		stored = await storedTranscriptionModel();
	} catch {
		stored = null;
	}
	const candidates = ids(cards, "transcription");
	const env = envTranscriptionModel();
	const resolved = resolveTranscription({
		storedModel: stored,
		envModel: env,
		candidates: stored || env ? [] : candidates,
	});
	if (!resolved.model || !candidates.includes(resolved.model)) {
		return { health: "off", note: "transcription_none" };
	}
	return { health: "ok", note: "transcription_ok", param: shortParam(resolved.model) };
}

// -- connectors, storage, agents -------------------------------------------------

/**
 * The administrator's connectors, from what the Check button last recorded: a
 * live probe would need each connector's credential, and the page must not.
 */
export async function probeMcp(): Promise<ProbeResult> {
	const base = getMcpServers().length;
	const rows = await collections.mcpConnectors
		.find({ scope: "deployment" }, { projection: { lastError: 1, checkedAt: 1 } })
		.toArray();
	const total = base + rows.length;
	if (total === 0) return { health: "off", note: "mcp_none" };
	const failed = rows.filter((r) => typeof r.lastError === "string" && r.lastError).length;
	if (failed === total) return { health: "down", note: "mcp_all_failed", param: String(failed) };
	if (failed > 0)
		return { health: "degraded", note: "mcp_some_failed", param: `${failed}/${total}` };
	// Never checked: nothing is known about it, so it is not counted as working.
	const unchecked = rows.filter((r) => !r.checkedAt).length;
	if (unchecked > 0) return { health: "unknown", note: "mcp_unchecked", param: String(unchecked) };
	return { health: "ok", note: "mcp_ok", param: String(total) };
}

export async function probeBlobs(): Promise<ProbeResult> {
	const store = collections.blobStore;
	try {
		if (store.kind === "s3" && store.reachable) {
			// Read-only: a HEAD on the bucket, never the boot check that writes a probe object.
			await store.reachable();
			return { health: "ok", note: "blobs_s3" };
		}
		await store.findOne("files", {});
		return { health: "ok", note: "blobs_gridfs" };
	} catch (err) {
		logger.warn({ err: String(err) }, "services_blobs_probe_failed");
		return { health: "down", note: "blobs_down" };
	}
}

export async function probeGalopin(): Promise<ProbeResult> {
	const dir = galopinDistDir();
	let sums: Map<string, string>;
	try {
		sums = parseSha256Sums(await readFile(join(dir, "SHA256SUMS"), "utf8"));
	} catch {
		return { health: "off", note: "galopin_missing" };
	}
	let present = 0;
	for (const name of GALOPIN_BINARIES) {
		if (!sums.has(name)) continue;
		try {
			await access(join(dir, name));
			present += 1;
		} catch {
			/* listed but absent */
		}
	}
	if (present === GALOPIN_BINARIES.length) {
		return { health: "ok", note: "galopin_ok", param: shortParam(OPENCODE_VERSION) };
	}
	return {
		health: "degraded",
		note: "galopin_partial",
		param: `${present}/${GALOPIN_BINARIES.length}`,
	};
}

export async function probeSchedules(now = Date.now()): Promise<ProbeResult> {
	if (!schedulesEnabled()) return { health: "off", note: "schedules_off" };
	const last = lastTickAt();
	// No tick yet is fine for the first minute after the process starts.
	if (last === null) {
		return process.uptime() * 1000 < 3 * TICK_MS
			? { health: "ok", note: "schedules_ok" }
			: { health: "down", note: "schedules_stalled" };
	}
	return now - last < 3 * TICK_MS
		? { health: "ok", note: "schedules_ok" }
		: { health: "down", note: "schedules_stalled" };
}

/** Mail is the gateway's. Where the chat can see an SMTP host it only checks that the port answers. */
export async function probeMail(): Promise<ProbeResult> {
	const host = optional.SMTP_HOST?.trim();
	if (!host) return { health: "unknown", note: "mail_elsewhere" };
	const port = Number.parseInt(optional.SMTP_PORT ?? "", 10) || 587;
	const reachable = await new Promise<boolean>((resolve) => {
		const socket = net.connect({ host, port, timeout: SHORT_MS });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(false));
	});
	return reachable
		? { health: "ok", note: "mail_reachable" }
		: { health: "down", note: "mail_down" };
}

export async function probeBrowser(): Promise<ProbeResult> {
	const settings = browserSettings();
	if (!settings.enabled) return off();
	const model = settings.model || undefined;
	if (!localConnectorsEnabled()) return { health: "degraded", note: "browser_needs_connectors" };
	if (!sealingAvailable()) return { health: "degraded", note: "browser_needs_key" };
	return model
		? { health: "ok", note: "browser_model", param: shortParam(model) }
		: { health: "ok", note: "browser_ok" };
}

export async function probeLocal(): Promise<ProbeResult> {
	if (!localConnectorsEnabled()) return off();
	const rows = await collections.codeDevices
		.find({ "machine.mode": "connectors", status: { $ne: "revoked" } }, { projection: { _id: 1 } })
		.toArray();
	if (rows.length === 0) return { health: "ok", note: "local_none" };
	const online = rows.filter((r) => isMachineOnline(r._id.toString())).length;
	return { health: "ok", note: "local_ok", param: `${online}/${rows.length}` };
}

export async function probeSandbox(): Promise<ProbeResult> {
	// Defensive: these settings may not exist in this build.
	const mode = (optional.SANDBOX ?? "").trim().toLowerCase();
	const url = trimSlash((optional.SANDBOX_MANAGER_URL ?? "").trim());
	if (!url || mode === "" || mode === "off") return off();
	try {
		const answer = await get(`${url}/v1/health`);
		if (answer.status !== 200) return { health: "down", note: "sandbox_down" };
		return field(answer.body, "ok") === false
			? { health: "degraded", note: "sandbox_degraded" }
			: { health: "ok", note: "sandbox_ok" };
	} catch {
		return { health: "down", note: "sandbox_down" };
	}
}
