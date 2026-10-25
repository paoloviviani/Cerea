/// <reference types="@sveltejs/kit" />
/// <reference types="unplugin-icons/types/svelte" />

import type { User } from "$lib/types/User";
import type { McpLocals } from "$lib/server/mcp/selection";

// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			sessionId: string;
			user?: User;
			isAdmin: boolean;
			token?: string;
			/** The session's OIDC `auth_time` (set once at login). Missing means
			 * the sign-in is treated as stale by the /code guard. */
			authTime?: Date;
			/** Organization to bill inference requests to (from settings) */
			billingOrganization?: string;
			/** The browser's IANA timezone for this request (conversation route). */
			timezone?: string;
			/** Rounded device coordinates for this turn; used only if the setting is "device". */
			location?: { lat: number; lon: number; accuracy?: number };
			/** The MCP servers this turn runs with (`mcpLocalsFor`). */
			mcp?: McpLocals;
			/** The language this request is rendered in (`$lib/i18n/resolve`); set for page requests. */
			locale?: import("$lib/i18n/resolve").Locale;
		}

		interface Error {
			message: string;
			errorId?: ReturnType<typeof crypto.randomUUID>;
		}
		// interface PageData {}
		// interface Platform {}
		interface PageState {
			/** First message text carried from the home/model page to a new conversation. */
			pendingMessage?: string;
			/** Nonce for looking up File[] in the client-side pendingFiles Map. */
			pendingFilesNonce?: string;
		}
	}
}

export {};
