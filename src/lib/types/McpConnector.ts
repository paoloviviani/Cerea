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
/** Our registration with one authorization server. */
export interface McpRegistration {
	clientId: string;
	/** Sealed. Absent for a public client, which PKCE makes acceptable. */
	clientSecretSealed?: string;
	registeredAt: Date;
	/**
	 * How we got these credentials.
	 *
	 * `dcr` is RFC 7591 dynamic registration and is the default. `static` is a
	 * client id and secret an operator already holds, which exists because a
	 * provider is free not to offer DCR at all — and without this mode such a
	 * server simply cannot be signed in to, which was a real dead end rather
	 * than a theoretical one. Metadata discovery still runs either way; only
	 * the registration step is skipped.
	 *
	 * It matters beyond display: a static registration must never be replaced
	 * by a re-probe, because the credentials are somebody's to manage and not
	 * ours to overwrite.
	 */
	source: "dcr" | "static";
}

/**
 * How the deployment offers one of its own connectors (the `.env` servers and
 * the administrator's) (ADR 0104). `on` is the default: on for everyone, and a
 * person may switch it off in Workspace. `locked`: on for everyone and nobody
 * may switch it off. `off`: offered to nobody.
 */
export type ConnectorMode = "off" | "on" | "locked";

export const CONNECTOR_MODES: readonly ConnectorMode[] = ["off", "on", "locked"];

/**
 * One stored policy row. `key` is `connector:<id>` or `base:<server name>`. A
 * connector with no row is `on` and not always loaded.
 */
export interface ConnectorModeRow extends Timestamps {
	_id: ObjectId;
	key: string;
	mode: ConnectorMode;
	/** Loaded from the start of every turn instead of being a catalogue line the model loads. */
	alwaysLoaded?: boolean;
}

/**
 * One person's own switches (ADR 0104): the connectors they turned off that
 * are on by default (the deployment's in mode `on`, and their own), and the
 * ones they turned on that are off by default (those on their machines).
 * Keys as in `ConnectorModeRow`, plus `local:<device>:<server>`. One row per
 * person.
 */
export interface ConnectorSwitchesRow extends Timestamps {
	_id: ObjectId;
	userId: User["_id"];
	off: string[];
	on: string[];
}

export interface McpConnector extends Timestamps {
	_id: ObjectId;

	/**
	 * Who added it. For a `user` connector this is also who may edit it; for a
	 * `deployment` one it is only a record of which administrator added it,
	 * kept because "who put this here" is asked about a server everyone's
	 * requests are going to.
	 */
	userId: User["_id"];

	/**
	 * Whose connector this is.
	 *
	 * `user` — one person's, visible and editable only by them. The original
	 * shape, and still the default.
	 *
	 * `deployment` — an administrator's, offered to everybody. **The definition
	 * is shared; the credential never is.** Each person signs in to it
	 * themselves and their token stays keyed on `(userId, connectorId)`
	 * exactly as before, so a shared Notion connector still means everybody
	 * reading their own workspace as themselves. ADR 0064 anticipated this
	 * ("a connector's *definition* is worth sharing; a token never is") and
	 * this is that, no more.
	 *
	 * The one exception is a `token` connector: a static credential belongs to
	 * the connector rather than to a person, so a deployment-scoped one shares
	 * its key with everyone who uses it. That is a real decision an
	 * administrator makes — an API key the organisation holds — and the screen
	 * says so rather than leaving it to be discovered.
	 */
	scope: "user" | "deployment";

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
	/**
	 * Which header carries that credential, and what precedes it.
	 *
	 * `Authorization` / `Bearer ` covers most of the world, but `X-API-Key`
	 * with no prefix is common enough that the old headers editor was being
	 * used for it. The header *name* is not a secret and is stored plainly —
	 * only the value is sealed — which is also what lets a custom server
	 * migrated out of localStorage keep working unchanged.
	 */
	tokenHeader?: string;
	tokenPrefix?: string;

	/** When the server was last asked how it authenticates. */
	probedAt?: Date;
	/** Why the last probe or connection failed, for the row to show. */
	lastError?: string;

	/**
	 * What the last check found, so a row can list its tools.
	 *
	 * This is the one capability connectors lacked that the old server list
	 * had, and here it is strictly better: the check runs server-side with the
	 * sealed credential, so it can reach a server whose token the browser has
	 * never seen. Stored rather than recomputed, because the dialog should open
	 * already knowing and a check is a round trip to somebody else's server.
	 */
	tools?: { name: string; description?: string }[];
	checkedAt?: Date;

	/**
	 * One sentence on what it is for, shown to the assistant in its list of
	 * connectors it can load (ADR 0104). Optional: without one the sentence is
	 * made from the tool names.
	 */
	description?: string;
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

/**
 * What a person picks from, whoever defined it.
 *
 * One shape for both kinds, because the dialog used to have two lists whose
 * only real difference was authentication — and one that was a defect: a
 * "custom" server lived in `localStorage`, so it did not follow anybody to a
 * second device. What survives of that split is `scope`, and it is the half
 * that was never about storage: an administrator's connector is offered to
 * everybody and is nobody else's to delete.
 */
/** What the client is given: never a credential, only whether there is one. */
export interface McpConnectorView {
	id: string;
	name: string;
	url: string;
	auth: "none" | "oauth" | "token";
	/** Whose it is. `deployment` entries come from an administrator. */
	scope: "user" | "deployment";
	/**
	 * Whether *this* caller may edit or remove it here. A person's own: true. A
	 * deployment connector: false in Workspace for everybody, administrators
	 * included, and true only in the administrator's listing (`?admin=1`) — the
	 * row still renders, because it is offered to them, but it is changed on
	 * the Admin screen.
	 */
	manageable: boolean;
	/**
	 * The key a switch is stored under (`connector:<id>`, or the local id).
	 */
	key: string;
	/**
	 * For a deployment connector, how it is offered (`off` ones are not listed to
	 * anyone but an administrator). Absent on a person's own.
	 */
	mode?: ConnectorMode;
	/** Deployment connector: loaded from the start of every turn (administrators see it). */
	alwaysLoaded?: boolean;
	/** Whether this person's turns use it: its mode and their own switch together. */
	enabled: boolean;
	/** Whether *this* person has a usable credential for it. */
	connected: boolean;
	/** For an OAuth connector, whether it can be signed in to at all. */
	canAuthorize: boolean;
	/** Which header carries a static token. Never its value. */
	tokenHeader?: string;
	/**
	 * The OAuth client id in use, and where it came from.
	 *
	 * A client id is not a secret — it travels in the authorize URL the browser
	 * follows — and showing it is what lets somebody confirm the connector is
	 * using the registration they pasted. The secret never appears here.
	 */
	clientId?: string;
	registrationSource?: "dcr" | "static";
	scopesSupported?: string[];
	issuer?: string;
	lastError?: string;
	/** The administrator's one sentence on what it is for, when there is one. */
	description?: string;
	/** From the last check. Absent means "not checked", not "none". */
	tools?: { name: string; description?: string }[];
	checkedAt?: string;
	updatedAt: string;
	/**
	 * Set on a server that runs on one of this person's own machines (ADR 0102): `id` is then
	 * `local:<deviceId>:<server>` and `name` reads "<server> · on <machine>". `connected` means
	 * the machine is online and the server `ready`; otherwise `state` and `detail` say why not.
	 * Nothing here is a credential: a sign-in's tokens stay on the machine.
	 */
	local?: McpLocalView;
}

export interface McpLocalView {
	deviceId: string;
	machineName: string;
	server: string;
	transport: "stdio" | "http" | "sse";
	description?: string;
	/** `offline` is the machine not being connected, whatever the server's last known state. */
	state: "ready" | "disabled" | "invalid" | "needs-login" | "offline";
	detail?: string;
	/** The machine's own ceiling (`allowedTools`), when it sets one. */
	allowedTools?: string[];
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

/**
 * One in-flight sign-in of a local connector (ADR 0102, PROTOCOL.md §10.5): from the redirect
 * out to the callback back.
 *
 * Keyed by the `state` the machine put in the authorization URL, and bound to the person and
 * the session that started it, the device and the server it is for. Holds no token and no PKCE
 * verifier: both stay on the machine. Single use (deleted when consumed) and short-lived (a TTL
 * index drops an abandoned one).
 */
export interface LocalConnectorOauth {
	_id: ObjectId;
	state: string;
	userId: User["_id"];
	sessionId: string;
	deviceId: string;
	server: string;
	/** Where to land afterwards, within this app. */
	next: string;
	createdAt: Date;
	expiresAt: Date;
}
