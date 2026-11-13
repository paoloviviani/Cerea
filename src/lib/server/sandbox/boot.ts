import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { SandboxClient } from "./client";
import { parseSandboxSettings, type SandboxSettings } from "./config";

/** The deployment's sandbox settings, read from the chat's configuration. */
export function sandboxSettings(): SandboxSettings {
	return parseSandboxSettings({
		SANDBOX: config.SANDBOX,
		SANDBOX_MANAGER_URL: config.SANDBOX_MANAGER_URL,
		SANDBOX_MANAGER_TOKEN: config.SANDBOX_MANAGER_TOKEN,
	});
}

/**
 * One line at start: off, or on with the manager's health. A mismatch between SANDBOX and the URL
 * and token is a warning, never a half-on feature. Never throws and never delays the boot.
 */
export function logSandboxAtBoot(): void {
	const settings = sandboxSettings();
	for (const problem of settings.problems)
		logger.warn({ mode: settings.mode }, `[sandbox] ${problem}`);
	if (!settings.config) {
		if (settings.problems.length === 0) logger.info("[sandbox] off");
		return;
	}
	const { mode, url, token } = settings.config;
	new SandboxClient({ url, token })
		.health()
		.then((h) =>
			logger.info(
				{
					mode,
					runtime: h.runtime ?? null,
					machines: h.machines ?? false,
					version: h.version ?? null,
				},
				"[sandbox] manager healthy"
			)
		)
		.catch((err: unknown) =>
			logger.warn(
				{ mode, error: String(err) },
				"[sandbox] the manager is configured but not reachable"
			)
		);
}
