import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	knowledge: null as Record<string, unknown> | null,
	connectors: [] as Array<{ lastError?: string }>,
	devices: [] as Array<{ _id: { toString(): string } }>,
	online: new Set<string>(),
	blob: { kind: "gridfs", selfCheck: vi.fn(), findOne: vi.fn() },
	state: {
		knowledgeOn: true,
		image: null as string | null,
		imageEnv: null as string | null,
		voice: null as string | null,
		voiceEnv: null as string | null,
		searchEnv: null as string | null,
		docsConfigured: false,
		caps: null as unknown,
		gotenberg: "",
		backend: "direct",
		playwright: { reachable: true },
		mcpBase: 0,
		scheduleOn: true,
		tick: null as number | null,
		localOn: true,
		sealing: true,
		browser: { enabled: false, model: "" },
	},
}));

vi.mock("$lib/server/config", () => ({
	config: new Proxy(h.cfg, { get: (t, k) => t[k as string] }),
}));
vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("$lib/server/database", () => ({
	collections: {
		knowledgeConfig: { findOne: async () => h.knowledge },
		mcpConnectors: { find: () => ({ toArray: async () => h.connectors }) },
		codeDevices: { find: () => ({ toArray: async () => h.devices }) },
		blobStore: h.blob,
	},
}));
vi.mock("$lib/server/knowledgeEnabled", () => ({ knowledgeEnabled: () => h.state.knowledgeOn }));
vi.mock("$lib/server/webSearch/config", () => ({ envWebSearchModel: () => h.state.searchEnv }));
vi.mock("$lib/server/imageGeneration", async () => {
	const real = await vi
		.importActual<typeof import("$lib/server/imageGeneration")>("$lib/server/imageGeneration")
		.catch(() => null);
	return {
		resolveImage: real?.resolveImage,
		envImageModel: () => h.state.imageEnv,
		storedImageModel: async () => h.state.image,
	};
});
vi.mock("$lib/server/transcription", async () => {
	const real = await vi
		.importActual<typeof import("$lib/server/transcription")>("$lib/server/transcription")
		.catch(() => null);
	return {
		resolveTranscription: real?.resolveTranscription,
		envTranscriptionModel: () => h.state.voiceEnv,
		storedTranscriptionModel: async () => h.state.voice,
	};
});
vi.mock("$lib/server/documents/client", () => ({
	isDocumentsConfigured: () => h.state.docsConfigured,
	getCapabilities: async () => h.state.caps,
}));
vi.mock("$lib/server/office/gotenberg", () => ({ gotenbergUrl: () => h.state.gotenberg }));
vi.mock("$lib/server/fetching", () => ({ configuredBackend: () => h.state.backend }));
vi.mock("$lib/server/fetching/playwright", () => ({
	probePlaywrightHealth: async () => h.state.playwright,
}));
vi.mock("$lib/server/mcp/registry", () => ({
	getMcpServers: () => new Array(h.state.mcpBase).fill({}),
}));
vi.mock("$lib/server/mcp/secretBox", () => ({ sealingAvailable: () => h.state.sealing }));
vi.mock("$lib/server/schedules/limits", () => ({ schedulesEnabled: () => h.state.scheduleOn }));
vi.mock("$lib/server/schedules/scheduler", () => ({
	lastTickAt: () => h.state.tick,
	TICK_MS: 30_000,
}));
vi.mock("$lib/server/browser/settings", () => ({ browserSettings: () => h.state.browser }));
vi.mock("$lib/server/codeEnabled", () => ({ localConnectorsEnabled: () => h.state.localOn }));
vi.mock("$lib/server/code/machines", () => ({ isMachineOnline: (id: string) => h.online.has(id) }));
vi.mock("$lib/server/galopinDist", () => ({
	galopinDistDir: () => h.cfg.GALOPIN_DIST_DIR ?? "/nonexistent",
	GALOPIN_BINARIES: ["galopin-linux-amd64", "galopin-linux-arm64"],
	parseSha256Sums: (text: string) =>
		new Map(
			text
				.split("\n")
				.filter(Boolean)
				.map((l) => [l.split(/\s+/)[1], l.split(/\s+/)[0]])
		),
}));
vi.mock("$lib/codeEnrollCommand", () => ({ OPENCODE_VERSION: "1.2.3" }));
vi.mock("$lib/server/knowledge/extractorResolution", async () =>
	vi.importActual("$lib/server/knowledge/extractorResolution")
);
vi.mock("$lib/server/webSearch/resolution", async () =>
	vi.importActual("$lib/server/webSearch/resolution")
);

import * as probes from "./probes";
import { shortParam } from "./types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });

let fetchMock: ReturnType<typeof vi.fn>;
const ctx = (cards: probes.Card[] | null): probes.ProbeContext => ({
	token: "t",
	catalogue: async () => cards,
});

beforeEach(() => {
	for (const k of Object.keys(h.cfg)) delete h.cfg[k];
	h.cfg.OPENAI_BASE_URL = "http://gateway:8000/v1";
	Object.assign(h.state, {
		knowledgeOn: true,
		image: null,
		imageEnv: null,
		voice: null,
		voiceEnv: null,
		searchEnv: null,
		docsConfigured: false,
		caps: null,
		gotenberg: "",
		backend: "direct",
		playwright: { reachable: true },
		mcpBase: 0,
		scheduleOn: true,
		tick: null,
		localOn: true,
		sealing: true,
		browser: { enabled: false, model: "" },
	});
	h.knowledge = null;
	h.connectors = [];
	h.devices = [];
	h.online.clear();
	h.blob.kind = "gridfs";
	h.blob.selfCheck.mockReset();
	h.blob.findOne.mockReset();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

describe("gateway", () => {
	it("is not configured without a base URL", async () => {
		delete h.cfg.OPENAI_BASE_URL;
		expect(await probes.probeGateway("t")).toMatchObject({ health: "off", note: "not_configured" });
	});

	it("maps readyz ok / degraded / 503 / unreachable, and reads a version when given", async () => {
		fetchMock.mockResolvedValueOnce(json({ status: "ok", version: "0.33.2" }));
		expect(await probes.probeGateway("t")).toEqual({
			health: "ok",
			note: "gateway_ok",
			version: "0.33.2",
		});
		fetchMock.mockResolvedValueOnce(json({ status: "degraded" }));
		expect(await probes.probeGateway("t")).toMatchObject({
			health: "degraded",
			note: "gateway_degraded",
		});
		fetchMock.mockResolvedValueOnce(json({ status: "degraded" }, 503));
		expect(await probes.probeGateway("t")).toMatchObject({
			health: "down",
			note: "gateway_not_ready",
		});
		fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:8000"));
		const down = await probes.probeGateway("t");
		expect(down).toMatchObject({ health: "down", note: "gateway_down", version: null });
		expect(JSON.stringify(down)).not.toContain("10.0.0.7");
	});

	it("takes the version from a header, and asks /me when readyz is not served", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response("<html>", { status: 404, headers: { "x-pystino-version": "0.34.0" } })
			)
			.mockResolvedValueOnce(json({ id: "u" }));
		expect(await probes.probeGateway("t")).toEqual({
			health: "ok",
			note: "gateway_ok",
			version: "0.34.0",
		});
		expect(String(fetchMock.mock.calls[1][0])).toBe("http://gateway:8000/v1/me");
	});
});

describe("catalogue-backed services", () => {
	const cards = (kind: string, ...ids: string[]) => ids.map((id) => ({ id, kind, local: false }));

	it("extractor: ok, missing, none, direct, and the catalogue being down", async () => {
		expect(await probes.probeExtractor(ctx(cards("ocr", "ocr-1")))).toEqual({
			health: "ok",
			note: "extractor_ok",
			param: "ocr-1",
		});
		h.cfg.CHAT_OCR_MODEL = "gone";
		expect(await probes.probeExtractor(ctx(cards("ocr", "ocr-1")))).toMatchObject({
			health: "degraded",
			note: "extractor_missing",
		});
		h.cfg.CHAT_OCR_MODEL = "";
		expect(await probes.probeExtractor(ctx([]))).toMatchObject({
			health: "off",
			note: "extractor_none",
		});
		expect(await probes.probeExtractor(ctx(null))).toMatchObject({
			health: "degraded",
			note: "catalogue_down",
		});
		h.cfg.CHAT_OCR_BASE_URL = "https://ocr.example";
		expect(await probes.probeExtractor(ctx(null))).toEqual({
			health: "ok",
			note: "extractor_direct",
		});
	});

	it("embedding: off when knowledge is off or no model, ok, missing", async () => {
		h.state.knowledgeOn = false;
		expect(await probes.probeEmbedding(ctx([]))).toMatchObject({
			health: "off",
			note: "knowledge_off",
		});
		h.state.knowledgeOn = true;
		expect(await probes.probeEmbedding(ctx([]))).toMatchObject({
			health: "off",
			note: "embedding_unset",
		});
		h.knowledge = { embeddingModel: "emb" };
		expect(await probes.probeEmbedding(ctx(cards("embedding", "emb")))).toMatchObject({
			health: "ok",
			note: "embedding_ok",
			param: "emb",
		});
		expect(await probes.probeEmbedding(ctx(cards("embedding", "other")))).toMatchObject({
			health: "degraded",
			note: "embedding_missing",
		});
	});

	it("search: none, policy, named, stale", async () => {
		expect(await probes.probeSearch(ctx([]))).toMatchObject({ health: "off", note: "search_none" });
		expect(await probes.probeSearch(ctx(cards("search", "s1")))).toMatchObject({
			health: "ok",
			note: "search_policy",
		});
		h.state.searchEnv = "s1";
		expect(await probes.probeSearch(ctx(cards("search", "s1")))).toMatchObject({
			health: "ok",
			note: "search_ok",
			param: "s1",
		});
		h.state.searchEnv = "s9";
		expect(await probes.probeSearch(ctx(cards("search", "s1")))).toMatchObject({
			health: "degraded",
			note: "search_stale",
		});
	});

	it("image and transcription: first available, none, or a named one that is not listed", async () => {
		expect(await probes.probeImage(ctx(cards("image", "img")))).toMatchObject({
			health: "ok",
			note: "image_ok",
			param: "img",
		});
		expect(await probes.probeImage(ctx([]))).toMatchObject({ health: "off", note: "image_none" });
		h.state.image = "gone";
		expect(await probes.probeImage(ctx(cards("image", "img")))).toMatchObject({
			health: "off",
			note: "image_none",
		});
		expect(await probes.probeTranscription(ctx(cards("transcription", "w")))).toMatchObject({
			health: "ok",
			note: "transcription_ok",
		});
		expect(await probes.probeTranscription(ctx([]))).toMatchObject({
			health: "off",
			note: "transcription_none",
		});
		expect(await probes.probeTranscription(ctx(null))).toMatchObject({
			health: "degraded",
			note: "catalogue_down",
		});
	});
});

describe("redaction", () => {
	it("says which modality, and is off when the guessed address is not there", async () => {
		fetchMock.mockResolvedValueOnce(
			json({ status: "ok", engine: "presidio", ner_engines: [{ available: false }] })
		);
		expect(await probes.probeRedaction()).toEqual({ health: "ok", note: "redaction_pattern" });
		fetchMock.mockResolvedValueOnce(
			json({ status: "ok", engine: "presidio", ner_engines: [{ available: true }] })
		);
		expect(await probes.probeRedaction()).toEqual({ health: "ok", note: "redaction_ner" });
		fetchMock.mockResolvedValueOnce(json({ status: "loading", engine: "presidio" }));
		expect(await probes.probeRedaction()).toMatchObject({
			health: "degraded",
			note: "redaction_degraded",
		});
		fetchMock.mockResolvedValueOnce(json({ status: "ok", engine: "noop" }));
		expect(await probes.probeRedaction()).toMatchObject({ health: "off" });
		fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
		expect(await probes.probeRedaction()).toMatchObject({ health: "off", note: "not_configured" });
	});

	it("an address somebody set that does not answer is down", async () => {
		h.cfg.CHAT_REDACTION_URL = "http://r:1";
		fetchMock.mockRejectedValueOnce(new Error("boom"));
		expect(await probes.probeRedaction()).toMatchObject({ health: "down", note: "redaction_down" });
		fetchMock.mockResolvedValueOnce(json({}, 500));
		expect(await probes.probeRedaction()).toMatchObject({ health: "down" });
	});
});

describe("documents and previews", () => {
	it("documents: not configured, ok, down", async () => {
		expect(await probes.probeDocuments()).toMatchObject({ health: "off" });
		h.state.docsConfigured = true;
		expect(await probes.probeDocuments()).toMatchObject({ health: "down", note: "documents_down" });
		h.state.caps = { formats: {} };
		expect(await probes.probeDocuments()).toMatchObject({ health: "ok", note: "documents_ok" });
	});

	it("office: not configured, up, reporting a problem, not answering", async () => {
		expect(await probes.probeOffice()).toMatchObject({ health: "off" });
		h.state.gotenberg = "http://gotenberg:3000";
		fetchMock.mockResolvedValueOnce(json({ status: "up" }));
		expect(await probes.probeOffice()).toMatchObject({ health: "ok" });
		fetchMock.mockResolvedValueOnce(json({ status: "down" }));
		expect(await probes.probeOffice()).toMatchObject({ health: "degraded" });
		fetchMock.mockRejectedValueOnce(new Error("x"));
		expect(await probes.probeOffice()).toMatchObject({ health: "down", note: "office_down" });
	});
});

describe("fetch browser", () => {
	it("direct without an endpoint is not configured; playwright without one is down", async () => {
		expect(await probes.probeFetch()).toMatchObject({ health: "off", note: "fetch_direct" });
		h.state.backend = "playwright";
		expect(await probes.probeFetch()).toMatchObject({ health: "down", note: "fetch_down" });
	});

	it("reachable is ok; unreachable is down only when pages are sent there", async () => {
		h.cfg.PLAYWRIGHT_WS_ENDPOINT = "ws://pw:3000/";
		expect(await probes.probeFetch()).toMatchObject({ health: "ok", note: "fetch_standby" });
		h.state.backend = "playwright";
		expect(await probes.probeFetch()).toMatchObject({ health: "ok", note: "fetch_browser" });
		h.state.playwright = { reachable: false };
		expect(await probes.probeFetch()).toMatchObject({ health: "down" });
		h.state.backend = "direct";
		expect(await probes.probeFetch()).toMatchObject({ health: "degraded" });
	});
});

describe("connectors", () => {
	it("mcp: none, all fine, some failed, all failed (from the stored check)", async () => {
		expect(await probes.probeMcp()).toMatchObject({ health: "off", note: "mcp_none" });
		h.state.mcpBase = 1;
		h.connectors = [{}, {}];
		expect(await probes.probeMcp()).toEqual({ health: "ok", note: "mcp_ok", param: "3" });
		h.connectors = [{ lastError: "x" }, {}];
		expect(await probes.probeMcp()).toEqual({
			health: "degraded",
			note: "mcp_some_failed",
			param: "1/3",
		});
		h.state.mcpBase = 0;
		h.connectors = [{ lastError: "x" }];
		expect(await probes.probeMcp()).toMatchObject({ health: "down", note: "mcp_all_failed" });
	});

	it("local connectors: off, none paired, counts online", async () => {
		h.state.localOn = false;
		expect(await probes.probeLocal()).toMatchObject({ health: "off" });
		h.state.localOn = true;
		expect(await probes.probeLocal()).toMatchObject({ health: "ok", note: "local_none" });
		h.devices = [{ _id: { toString: () => "a" } }, { _id: { toString: () => "b" } }];
		h.online.add("a");
		expect(await probes.probeLocal()).toEqual({ health: "ok", note: "local_ok", param: "1/2" });
	});

	it("browser use: off, needs connectors, needs the key, ok with and without a model", async () => {
		expect(await probes.probeBrowser()).toMatchObject({ health: "off" });
		h.state.browser = { enabled: true, model: "" };
		h.state.localOn = false;
		expect(await probes.probeBrowser()).toMatchObject({
			health: "degraded",
			note: "browser_needs_connectors",
		});
		h.state.localOn = true;
		h.state.sealing = false;
		expect(await probes.probeBrowser()).toMatchObject({
			health: "degraded",
			note: "browser_needs_key",
		});
		h.state.sealing = true;
		expect(await probes.probeBrowser()).toEqual({ health: "ok", note: "browser_ok" });
		h.state.browser.model = "m1";
		expect(await probes.probeBrowser()).toEqual({
			health: "ok",
			note: "browser_model",
			param: "m1",
		});
	});
});

describe("storage and agents", () => {
	it("blob store: gridfs ok, s3 ok, failure is down with no error text", async () => {
		h.blob.findOne.mockResolvedValue(null);
		expect(await probes.probeBlobs()).toMatchObject({ health: "ok", note: "blobs_gridfs" });
		h.blob.kind = "s3";
		h.blob.selfCheck.mockResolvedValueOnce(undefined);
		expect(await probes.probeBlobs()).toMatchObject({ health: "ok", note: "blobs_s3" });
		h.blob.selfCheck.mockRejectedValueOnce(new Error("Cannot reach http://rustfs:9000 bucket x"));
		const down = await probes.probeBlobs();
		expect(down).toEqual({ health: "down", note: "blobs_down" });
	});

	it("galopin: missing is not configured, partial is amber, complete is ok with the pin", async () => {
		expect(await probes.probeGalopin()).toMatchObject({ health: "off", note: "galopin_missing" });
		const dir = mkdtempSync(join(tmpdir(), "galopin-"));
		h.cfg.GALOPIN_DIST_DIR = dir;
		const sum = "a".repeat(64);
		writeFileSync(
			join(dir, "SHA256SUMS"),
			`${sum}  galopin-linux-amd64\n${sum}  galopin-linux-arm64\n`
		);
		writeFileSync(join(dir, "galopin-linux-amd64"), "x");
		expect(await probes.probeGalopin()).toEqual({
			health: "degraded",
			note: "galopin_partial",
			param: "1/2",
		});
		writeFileSync(join(dir, "galopin-linux-arm64"), "x");
		expect(await probes.probeGalopin()).toEqual({
			health: "ok",
			note: "galopin_ok",
			param: "1.2.3",
		});
	});

	it("schedules: off, heartbeat fresh, stalled", async () => {
		h.state.scheduleOn = false;
		expect(await probes.probeSchedules(1_000_000)).toMatchObject({ health: "off" });
		h.state.scheduleOn = true;
		h.state.tick = 1_000_000 - 60_000;
		expect(await probes.probeSchedules(1_000_000)).toMatchObject({ health: "ok" });
		h.state.tick = 1_000_000 - 200_000;
		expect(await probes.probeSchedules(1_000_000)).toMatchObject({
			health: "down",
			note: "schedules_stalled",
		});
	});
});

describe("mail and sandbox", () => {
	it("mail without an SMTP host in the chat's view says it is set up elsewhere", async () => {
		expect(await probes.probeMail()).toEqual({ health: "off", note: "mail_elsewhere" });
	});

	it("mail with a host: a refused port is down", async () => {
		h.cfg.SMTP_HOST = "127.0.0.1";
		h.cfg.SMTP_PORT = "1";
		expect(await probes.probeMail()).toEqual({ health: "down", note: "mail_down" });
	});

	it("sandbox is not configured unless the mode and the manager address are both set", async () => {
		expect(await probes.probeSandbox()).toMatchObject({ health: "off", note: "not_configured" });
		h.cfg.SANDBOX_MANAGER_URL = "http://m:1";
		expect(await probes.probeSandbox()).toMatchObject({ health: "off" });
		h.cfg.SANDBOX = "on";
		fetchMock.mockResolvedValueOnce(json({ ok: true }));
		expect(await probes.probeSandbox()).toMatchObject({ health: "ok" });
		expect(String(fetchMock.mock.calls[0][0])).toBe("http://m:1/v1/health");
		fetchMock.mockResolvedValueOnce(json({ ok: false }));
		expect(await probes.probeSandbox()).toMatchObject({ health: "degraded" });
		fetchMock.mockResolvedValueOnce(json({}, 500));
		expect(await probes.probeSandbox()).toMatchObject({ health: "down" });
		fetchMock.mockRejectedValueOnce(new Error("x"));
		expect(await probes.probeSandbox()).toMatchObject({ health: "down", note: "sandbox_down" });
	});
});

describe("shortParam", () => {
	it("bounds, flattens and drops empties", () => {
		expect(shortParam("a\nb\u0000c")).toBe("a b c");
		expect(shortParam("x".repeat(200))?.length).toBe(80);
		expect(shortParam("  ")).toBeUndefined();
		expect(shortParam(null)).toBeUndefined();
	});
});
