import type { ObjectId } from "bson";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

export interface Session extends Timestamps {
	_id: ObjectId;
	sessionId: string;
	userId: User["_id"];
	userAgent?: string;
	ip?: string;
	expiresAt: Date;
	admin?: boolean;
	coupledCookieHash?: string;
	/**
	 * The OIDC ID token's `auth_time` claim, captured once at login (never
	 * updated by a token refresh, which re-proves the *client* to the
	 * provider but not the person). This is when the person actually
	 * authenticated — what the terminal's step-up rule reads (ADR 0090 D6):
	 * minting a terminal ticket needs this within the last 12h, else the
	 * browser is sent through a fresh login. Absent when the provider omits
	 * the claim, which counts as stale (never fresh) rather than exempt.
	 */
	authTime?: Date;

	oauth?: {
		token: {
			value: string;
			expiresAt: Date;
		};
		refreshToken?: string;
		/**
		 * The id token, kept for one purpose: `id_token_hint` on RP-initiated
		 * logout. Without it the provider cannot tell which session is being
		 * ended, so it either asks the person to confirm or refuses the
		 * post-logout redirect. Never sent anywhere else.
		 */
		idToken?: string;
	};
}
