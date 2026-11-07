import { config } from "$lib/server/config";

/**
 * Whether the deployment shows Settings → Usage and the quota line in the user
 * menu. On whenever a gateway is configured, unless `CHAT_USAGE_ENABLED=false`:
 * an empty or unset value used to mean "off", which hid the tab on stacks that
 * did have quotas while the error message still pointed to it.
 */
export function usageEnabled(): boolean {
	return !!config.OPENAI_BASE_URL && config.CHAT_USAGE_ENABLED !== "false";
}
