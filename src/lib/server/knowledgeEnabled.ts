import { config } from "$lib/server/config";

/**
 * The deployment switch for the knowledge pipeline (`CHAT_KNOWLEDGE_ENABLED`).
 *
 * On unless explicitly `"false"`, so existing deployments — which never set
 * the variable — keep the pipeline they already run. A deployment without the
 * chat's Postgres sets it `false`, and the knowledge surface hides instead of
 * failing: the workspace tab, the project and composer affordances, the admin
 * section, and the API routes that serve them.
 *
 * Distinct from the pipeline's own runtime switch (the admin console's
 * `enabled`, which also needs an embedding model named): that one is a product
 * decision an administrator makes; this one is a deployment decision an
 * operator makes, and no console toggle can cross it.
 */
export function knowledgeEnabled(): boolean {
	return config.CHAT_KNOWLEDGE_ENABLED !== "false";
}
