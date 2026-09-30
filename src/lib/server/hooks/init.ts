import { config, ready } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { registerMachineUpgrade } from "$lib/server/code/machineServer";
import { startMachineRevalidationLoop } from "$lib/server/code/machines";
import { initExitHandler } from "$lib/server/exitHandler";
import { assertOcrConfigValid } from "$lib/server/files/extractDocument";
import { configuredBackend } from "$lib/server/fetching";
import { checkAndRunMigrations } from "$lib/migrations/migrations";
import { refreshConversationStats } from "$lib/jobs/refresh-conversation-stats";
import { loadMcpServersOnStartup } from "$lib/server/mcp/registry";
import { AbortedGenerations } from "$lib/server/abortedGenerations";
import { GenerationReaper } from "$lib/server/generation/reaper";
import { ParkedCallSweeper } from "$lib/server/generation/parkedSweeper";
import { OrphanSweeper } from "$lib/server/knowledge/orphanSweep";
import { ToolApprovalSweeper } from "$lib/server/generation/toolApprovalSweeper";
import { DeliverableReaper } from "$lib/server/execution/deliverables";
import { adminTokenManager } from "$lib/server/adminToken";
import { MetricsServer } from "$lib/server/metrics";
import { getShareThumbnailPng } from "$lib/server/shareThumbnail/shareThumbnail";

export async function initServer(): Promise<void> {
	// Wait for config to be fully loaded
	await ready;

	// A direct OCR endpoint with no model named would otherwise surface as a
	// 503 on somebody's first attachment; this fails the boot instead.
	assertOcrConfigValid();

	// Ensure legacy env expected by some libs: map OPENAI_API_KEY -> HF_TOKEN if absent
	const canonicalToken = config.OPENAI_API_KEY || config.HF_TOKEN;
	if (canonicalToken) {
		process.env.HF_TOKEN ??= canonicalToken;
	}

	// Warn if legacy-only var is used
	if (!config.OPENAI_API_KEY && config.HF_TOKEN) {
		logger.warn(
			"HF_TOKEN is deprecated in favor of OPENAI_API_KEY. Please migrate to OPENAI_API_KEY."
		);
	}

	logger.info("Starting server...");
	initExitHandler();

	// The machine link's WebSocket upgrade (`/api/v2/code/machine`) is wired
	// one layer below SvelteKit, on the raw http.Server `server.js` creates
	// (adapter-node's `handler` only speaks HTTP) — see `machineServer.ts`'s
	// header for why. Registering here, rather than at module load, keeps
	// the symbol's function from going live before config/DB are ready.
	registerMachineUpgrade();
	// ADR 0093 §4.7: re-check every live machine link against the gateway
	// every 60s, independent of the machine's own token-renewal cadence.
	startMachineRevalidationLoop();

	if (config.METRICS_ENABLED === "true") {
		MetricsServer.getInstance();
	}

	checkAndRunMigrations();
	refreshConversationStats();

	// Load MCP servers at startup
	loadMcpServersOnStartup();

	// Init AbortedGenerations refresh process
	AbortedGenerations.getInstance();

	// Finalize generations whose pod died mid-run.
	GenerationReaper.getInstance();
	ParkedCallSweeper.getInstance();
	// Deny-timeout for the tool-approval gate (ADR 0075): fails closed when
	// nobody answers, rather than parking the turn forever.
	ToolApprovalSweeper.getInstance();
	// 30-day retention for persisted execute_code deliverables (ADR 0073's amendment).
	DeliverableReaper.getInstance();
	// Daily backstop for the knowledge pipeline's deleteDerived: orphan
	// chunks, unattached uploads, transcripts of deleted conversations.
	OrphanSweeper.getInstance();

	// Diagnostic only — logged once, never cached or trusted as a gate. The
	// renderer's own container healthcheck has a 60-second start period, so
	// this chat routinely finishes booting before it is ready; treating this
	// boot-time read as durable would report a healthy stack as broken until
	// a restart (ADR 0079). Whether `web_fetch_structured` is offered is
	// decided per-turn instead, against a short-lived cache
	// (`probePlaywrightHealth`), never against this snapshot. Not awaited:
	// a slow or absent renderer must not hold up the rest of boot.
	if (configuredBackend() === "playwright") {
		import("$lib/server/fetching/playwright")
			.then((m) => m.probePlaywrightHealth())
			.then((health) =>
				logger.info(
					{ reachable: health.reachable, reason: health.reason },
					"playwright_renderer_boot_check"
				)
			)
			.catch((err) => logger.warn({ err }, "playwright_renderer_boot_check_failed"));
	}

	// Warm up the share-thumbnail renderer: the first satori render in a fresh
	// process pays ~1s of font parsing + layout engine init, which would
	// otherwise land on a link unfurler's request and can exceed its timeout
	// (Slack gives up and shows no preview). Rendering the generic card now
	// also leaves it cached for shares without a renderable prompt.
	getShareThumbnailPng({
		prompt: "",
		isHuggingChat: config.isHuggingChat,
		appName: config.PUBLIC_APP_NAME,
	}).catch((err) => logger.warn({ err }, "Failed to warm up share thumbnail renderer"));

	adminTokenManager.displayToken();

	if (config.EXPOSE_API) {
		logger.warn(
			"The EXPOSE_API flag has been deprecated. The API is now required for chat-ui to work."
		);
	}
}
