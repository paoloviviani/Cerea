/**
 * Where MCP Apps (#44) may be shown at all, a deployment-wide choice an administrator makes
 * under Admin, Connectors:
 *
 * - `off`: no apps anywhere;
 * - `deployment`: only apps from connectors the deployment provides (the administrator's and the
 *   `.env` ones), not from users' own connectors or those on their computers;
 * - `all` (the default): everything, subject to each connector's own switch.
 *
 * `MCP_APPS` in the environment is the default; a value saved by an administrator overrides it.
 * Unset means `all`. A value that is set but not one of the three fails closed to `off`.
 */
import { config } from "$lib/server/config";

import { parseAppsMode, type AppsMode } from "./appsMode.parse";

export { APPS_MODES, parseAppsMode, type AppsMode } from "./appsMode.parse";

export function appsMode(): AppsMode {
	return parseAppsMode(String(config.MCP_APPS ?? ""));
}
