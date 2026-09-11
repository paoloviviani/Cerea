import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * A remote MCP server somebody has added, and how it authenticates
 * (ADR 0064).
 *
 * The *definition* lives here; a credential never does. An OAuth token is a
 * row in `mcpTokens`, keyed on `(userId, connectorId)`, because one shared
 * connector credential would mean everybody reading the same Notion workspace
 * as one identity. A static token is the connector's own but still encrypted
 * and still server-side — the point of this ADR is where the credential lives,
 * not how it was obtained.
 *
 * Only remote servers. Running MCP servers ourselves is what a gateway is for,
 * and ADR 0063 records why we do not have one.
 */
/** Our RFC 7591 registration with one authorization server. */
export interface McpRegistration {
	clientId: string;
	/** Sealed. Absent for a public client, which PKCE makes acceptable. */
	clientSecretSealed?: string;
	registeredAt: Date;
}

export interface McpConnector extends Timestamps {
	_id: ObjectId;

	/** Who added it. Only they see it, until connector sharing exists. */
	userId: User["_id"];

	name: string;
	/** The MCP endpoint, e.g. `https://mcp.notion.com/mcp`. */
	url: string;

	/**
	 * How it authenticates.
	 *
	 * `oauth` and `token` are the two the requirement names. `none` is real
	 * too — a server on a private network, or a public one — and worth
	 * distinguishing from "we have not looked yet", which is what a missing
	 * `probedAt` means.
	 */
	auth: "none" | "oauth" | "token";

	/** What the server told us about its own OAuth, from discovery. */
	oauth?: {
		/** The authorization server, from protected-resource metadata. */
		issuer: string;
		authorizationEndpoint: string;
		tokenEndpoint: string;
		registrationEndpoint?: string;
		revocationEndpoint?: string;
		scopesSupported?: string[];
		/**
		 * RFC 8707 resource indicator. The MCP spec requires it, and it is what
		 * stops a token minted for one resource being replayed at another.
		 */
		resource: string;
		/** Whether the server offers PKCE S256. Refused if it does not. */
		supportsS256: boolean;
	};

	/**
	 * Our registration with that authorization server, once per connector,
	 * by RFC 7591. Sealed, because a client secret is a credential.
	 *
	 * Not a client-ID metadata document: CIMD would have the provider fetch a
	 * document from us, and this deployment serves `tls internal` — a CA
	 * nothing has heard of. ADR 0063 measured that.
	 */
	registration?: McpRegistration;

	/** For `auth: "token"` — the static credential, sealed. */
	tokenSealed?: string;

	/** When the server was last asked how it authenticates. */
	probedAt?: Date;
	/** Why the last probe or connection failed, for the row to show. */
	lastError?: string;
}

/**
 * One person's authorisation of one connector.
 *
 * Separate from the connector so that a definition can be shared later
 * without a token going with it, and so that revoking one person's access is
 * a single delete.
 */
export interface McpToken extends Timestamps {
	_id: ObjectId;
	connectorId: McpConnector["_id"];
	userId: User["_id"];

	/** Sealed. */
	accessTokenSealed: string;
	/** Sealed. Absent when the server issues none, which some do not. */
	refreshTokenSealed?: string;
	/** When the access token stops working; refreshed shortly before. */
	expiresAt?: Date;
	scope?: string;
}

/** What the client is given: never a credential, only whether there is one. */
export interface McpConnectorView {
	id: string;
	name: string;
	url: string;
	auth: "none" | "oauth" | "token";
	/** Whether *this* person has a usable credential for it. */
	connected: boolean;
	/** For an OAuth connector, whether it can be signed in to at all. */
	canAuthorize: boolean;
	scopesSupported?: string[];
	issuer?: string;
	lastError?: string;
	updatedAt: string;
}

/**
 * One in-flight authorization, from the redirect out to the callback back.
 *
 * Holds the PKCE verifier — which never leaves the server, or PKCE buys
 * nothing — and the session that started the flow, so the callback can refuse
 * a code arriving in a different browser. A TTL index expires these, because
 * an abandoned consent screen should not leave a usable state lying about.
 */
export interface McpOauthPending {
	_id: ObjectId;
	/** The `state` parameter: single-use, deleted when consumed. */
	state: string;
	connectorId: McpConnector["_id"];
	userId: User["_id"];
	sessionId: string;
	verifier: string;
	/** Where to land afterwards, within this app. */
	next: string;
	createdAt: Date;
	expiresAt: Date;
}
