/**
 * Resolving a connector choice, and the two ways it fails quietly (ADR 0064).
 *
 * The first is a *security* property: the browser sends ids, so an id that
 * belongs to somebody else must resolve to nothing rather than to their
 * credential. Every negative assertion here would also pass if the query
 * matched nothing for an unrelated reason, so each one is paired with a
 * positive case on the same data — the trap `sharing.py` records in the
 * gateway, where fourteen tests passed against a real bug.
 *
 * The second is not security but is worse to debug: a connector left out of a
 * turn produces an answer shaped by a missing capability, with no error
 * anywhere. That is what the name-filter test below is about.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { resolveConnectors } from "./testing/resolveConnectors";

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();
const stranger = new ObjectId();

async function addConnector(options: {
	userId: ObjectId;
	name: string;
	auth: "none" | "oauth" | "token";
	token?: string;
	scope?: "user" | "deployment";
}) {
	const { seal } = await import("./secretBox");
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: options.userId,
		scope: options.scope ?? ("user" as const),
		name: options.name,
		url: `https://${options.name.toLowerCase()}.test/mcp`,
		auth: options.auth,
		...(options.token ? { tokenSealed: seal(options.token) } : {}),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return _id;
}

beforeEach(async () => {
	await collections.mcpConnectors.deleteMany({ userId: { $in: [owner, stranger] } });
	await collections.mcpTokens.deleteMany({ userId: { $in: [owner, stranger] } });
});

describe("resolving a selection", () => {
	it("attaches a static token as a bearer", async () => {
		const id = await addConnector({
			userId: owner,
			name: "Tokenised",
			auth: "token",
			token: "static-secret-42",
		});

		const { servers, needAuthorization } = await resolveConnectors({
			connectorIds: [id.toString()],
			userId: owner,
		});

		expect(needAuthorization).toEqual([]);
		expect(servers).toHaveLength(1);
		expect(servers[0].headers?.Authorization).toBe("Bearer static-secret-42");
	});

	it("gives a stranger's id nothing, on data that resolves for its owner", async () => {
		// The pairing is the point. Asserting only the empty result would pass
		// against a query that finds nothing at all.
		const id = await addConnector({
			userId: owner,
			name: "Private",
			auth: "token",
			token: "not-yours",
		});

		const mine = await resolveConnectors({ connectorIds: [id.toString()], userId: owner });
		expect(mine.servers).toHaveLength(1);

		const theirs = await resolveConnectors({ connectorIds: [id.toString()], userId: stranger });
		expect(theirs.servers).toEqual([]);
		expect(theirs.needAuthorization).toEqual([]);
		expect(JSON.stringify(theirs)).not.toContain("not-yours");
	});

	it("leaves an unauthorised OAuth connector out rather than calling it bare", async () => {
		const id = await addConnector({ userId: owner, name: "Notion", auth: "oauth" });

		const { servers, needAuthorization } = await resolveConnectors({
			connectorIds: [id.toString()],
			userId: owner,
		});

		// A bare call would 401, the model would be told the tool failed, and
		// the person would never be told to sign in.
		expect(servers).toEqual([]);
		expect(needAuthorization).toEqual(["Notion"]);
	});

	it("survives a malformed id instead of throwing", async () => {
		const { servers } = await resolveConnectors({
			connectorIds: ["not-an-object-id"],
			userId: owner,
		});
		expect(servers).toEqual([]);
	});
});

describe("a connector the deployment shares", () => {
	/**
	 * An administrator's connector is offered to everybody, and the widening
	 * that makes that work is one `$or` away from the widening that would hand
	 * everybody everybody else's credentials. So each case here is paired: the
	 * shared one resolves for a stranger, the private one does not, on the same
	 * data in the same test.
	 *
	 * This is the shape AGENTS.md warns about in the gateway's `may_reach`,
	 * where fourteen tests passed against a real bug because every negative one
	 * failed closed for an unrelated reason.
	 */
	it("resolves for somebody who does not own it, while a private one does not", async () => {
		const shared = await addConnector({
			userId: owner,
			name: "Shared",
			auth: "none",
			scope: "deployment",
		});
		const private_ = await addConnector({ userId: owner, name: "Private", auth: "none" });

		const theirs = await resolveConnectors({
			connectorIds: [shared.toString(), private_.toString()],
			userId: stranger,
		});

		// Both ids were offered; exactly one came back.
		expect(theirs.servers.map((s) => s.name)).toEqual(["Shared"]);

		// And the owner still gets both, so the filter is not simply broken.
		const mine = await resolveConnectors({
			connectorIds: [shared.toString(), private_.toString()],
			userId: owner,
		});
		expect(mine.servers.map((s) => s.name).sort()).toEqual(["Private", "Shared"]);
	});

	it("does not lend one person's OAuth token to another", async () => {
		// The property the whole design rests on: sharing a *definition* must
		// not share a credential. The connector is reachable by the stranger and
		// the owner has authorised it; the stranger must still be told to sign
		// in rather than handed the owner's bearer.
		const { seal } = await import("./secretBox");
		const shared = await addConnector({
			userId: owner,
			name: "SharedOauth",
			auth: "oauth",
			scope: "deployment",
		});
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId: shared,
			userId: owner,
			accessTokenSealed: seal("the-owners-token"),
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const mine = await resolveConnectors({ connectorIds: [shared.toString()], userId: owner });
		expect(mine.servers[0]?.headers?.Authorization).toBe("Bearer the-owners-token");

		const theirs = await resolveConnectors({
			connectorIds: [shared.toString()],
			userId: stranger,
		});
		expect(theirs.servers).toEqual([]);
		expect(theirs.needAuthorization).toEqual(["SharedOauth"]);
		expect(JSON.stringify(theirs)).not.toContain("the-owners-token");
	});
});
