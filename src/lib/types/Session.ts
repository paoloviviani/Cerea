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
