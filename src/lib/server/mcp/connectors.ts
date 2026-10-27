/**
 * Reading connectors, and what the browser is allowed to know about them
 * (ADR 0064).
 *
 * The view carries no credential and no sealed value — only *whether* this
 * person has one. That is the whole point of moving the token server-side, and
 * it would be undone by a convenient `token` field on the way out.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import type { McpConnector, McpConnectorView } from "$lib/types/McpConnector";
import {
	connectorKey,
	isEnabled,
	loadPolicies,
	loadSwitches,
	policyIn,
	type ConnectorPolicy,
	type Switches,
} from "./deploymentModes";

/** One connector as the client sees it. */
export async function view(
	connector: McpConnector,
	userId: ObjectId,
	/** Whether this caller administers the deployment. */
	isAdmin = false,
	/** What a listing already read: the deployment's policies and this person's switches. */
	context?: { policies: Map<string, ConnectorPolicy>; switches: Switches },
	/**
	 * The administrator's own screen (Admin, Connectors) is the only place a
	 * deployment connector is changed. Everywhere else, Workspace included, it
	 * is read-only, whoever looks at it.
	 */
	adminScreen = false
): Promise<McpConnectorView> {
	const ctx = context ?? {
		policies: await loadPolicies(),
		switches: await loadSwitches(userId),
	};
	const key = connectorKey(connector._id.toString());
	const deployment = (connector.scope ?? "user") === "deployment";
	const policy = deployment ? policyIn(ctx.policies, key) : undefined;
	let connected = false;
	if (connector.auth === "token") {
		connected = Boolean(connector.tokenSealed);
	} else if (connector.auth === "oauth") {
		connected = Boolean(
			await collections.mcpTokens.findOne(
				{ connectorId: connector._id, userId },
				{ projection: { _id: 1 } }
			)
		);
	} else {
		// Nothing to authenticate with, so it is usable as it stands.
		connected = true;
	}

	return {
		id: connector._id.toString(),
		name: connector.name,
		url: connector.url,
		auth: connector.auth,
		connected,
		// Whether a sign-in can even be offered: OAuth, discovered, and either
		// registerable or already registered.
		canAuthorize:
			connector.auth === "oauth" &&
			Boolean(connector.oauth) &&
			Boolean(connector.oauth?.registrationEndpoint || connector.registration),
		// The header *name*, never its value. Somebody editing an `X-API-Key`
		// connector has to see which header it uses, and the name is not the
		// secret.
		tokenHeader: connector.tokenHeader,
		// The id, never the secret: it is already public — it travels in the
		// authorize URL — and seeing it is how somebody confirms the connector
		// is using the registration they pasted.
		clientId: connector.registration?.clientId,
		registrationSource: connector.registration?.source,
		scopesSupported: connector.oauth?.scopesSupported,
		issuer: connector.oauth?.issuer,
		lastError: connector.lastError,
		description: connector.description,
		tools: connector.tools,
		checkedAt: connector.checkedAt?.toISOString(),
		scope: connector.scope ?? "user",
		key,
		// This person's turns use it: its mode, then their own switch.
		enabled: isEnabled(key, policy, ctx.switches),
		...(policy
			? { mode: policy.mode, ...(isAdmin ? { alwaysLoaded: policy.alwaysLoaded } : {}) }
			: {}),
		// Using a connector and changing one are different permissions. A
		// deployment connector renders for everybody because it is offered to
		// them, and it is read-only in Workspace even for an administrator: the
		// administrator changes it on the Admin screen, which asks for the
		// listing with `?admin=1`. That answer is computed here rather than
		// guessed at in the component.
		manageable: (connector.scope ?? "user") === "user" ? true : isAdmin && adminScreen,
		updatedAt: connector.updatedAt.toISOString(),
	};
}

/**
 * Everything this person can use: their own, plus the deployment's.
 *
 * Both in one list rather than two, because from the composer's point of view
 * there is one question — which servers is this message carrying — and a
 * second list would only re-create the base/custom split that this work
 * removed. Whose it is stays visible as `scope`.
 *
 * A connector with no `scope` is one added before this existed and is treated
 * as `user`; that is the safe direction, since the alternative would silently
 * publish somebody's personal Notion connector to the whole deployment.
 */
export async function viewsFor(
	userId: ObjectId,
	isAdmin = false,
	/**
	 * The administrator's page (`?admin=1`): lists the connectors that are
	 * switched off too, and is the one listing where a deployment connector is
	 * `manageable`.
	 */
	includeOff = false
): Promise<McpConnectorView[]> {
	const rows = await collections.mcpConnectors
		.find({ $or: [{ userId }, { scope: "deployment" }] })
		.sort({ updatedAt: -1 })
		.limit(200)
		.toArray();
	const context = { policies: await loadPolicies(), switches: await loadSwitches(userId) };
	// A deployment connector that is off is offered to nobody, so it is not listed.
	const listed = rows.filter(
		(row) =>
			includeOff ||
			(row.scope ?? "user") !== "deployment" ||
			policyIn(context.policies, connectorKey(row._id.toString())).mode !== "off"
	);
	return Promise.all(listed.map((row) => view(row, userId, isAdmin, context, includeOff)));
}

/**
 * One connector this person may *use*, or null.
 *
 * Wider than `ownedBy`: a deployment connector is usable by everybody, which
 * is what signing in to one and calling it require. Changing one is a
 * different question and `ownedBy` is still what answers it.
 */
export async function usableBy(id: string, userId: ObjectId): Promise<McpConnector | null> {
	const { ObjectId: Oid } = await import("mongodb");
	if (!Oid.isValid(id)) return null;
	return collections.mcpConnectors.findOne({
		_id: new Oid(id),
		$or: [{ userId }, { scope: "deployment" }],
	});
}

/**
 * One connector this person owns, or null.
 *
 * Null for both "no such connector" and "not yours", deliberately: telling
 * those apart confirms that somebody else's connector exists.
 */
export async function ownedBy(
	id: string,
	userId: ObjectId,
	isAdmin = false
): Promise<McpConnector | null> {
	const { ObjectId: Oid } = await import("mongodb");
	if (!Oid.isValid(id)) return null;
	const connector = await collections.mcpConnectors.findOne({ _id: new Oid(id) });
	if (!connector) return null;
	// A deployment connector is an administrator's to change, whoever added it.
	// A personal one is its owner's and nobody else's — including an
	// administrator's, because "I administer this deployment" is not "I may
	// edit your private Notion credential".
	if ((connector.scope ?? "user") === "deployment") return isAdmin ? connector : null;
	return connector.userId.equals(userId) ? connector : null;
}
