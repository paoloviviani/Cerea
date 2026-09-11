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
}) {
	const { seal } = await import("./secretBox");
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: options.userId,
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
		const { resolveSelection } = await import("./selection");
		const id = await addConnector({
			userId: owner,
			name: "Tokenised",
			auth: "token",
			token: "static-secret-42",
		});

		const { servers, needAuthorization } = await resolveSelection({
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
		const { resolveSelection } = await import("./selection");
		const id = await addConnector({
			userId: owner,
			name: "Private",
			auth: "token",
			token: "not-yours",
		});

		const mine = await resolveSelection({ connectorIds: [id.toString()], userId: owner });
		expect(mine.servers).toHaveLength(1);

		const theirs = await resolveSelection({ connectorIds: [id.toString()], userId: stranger });
		expect(theirs.servers).toEqual([]);
		expect(theirs.needAuthorization).toEqual([]);
		expect(JSON.stringify(theirs)).not.toContain("not-yours");
	});

	it("leaves an unauthorised OAuth connector out rather than calling it bare", async () => {
		const { resolveSelection } = await import("./selection");
		const id = await addConnector({ userId: owner, name: "Notion", auth: "oauth" });

		const { servers, needAuthorization } = await resolveSelection({
			connectorIds: [id.toString()],
			userId: owner,
		});

		// A bare call would 401, the model would be told the tool failed, and
		// the person would never be told to sign in.
		expect(servers).toEqual([]);
		expect(needAuthorization).toEqual(["Notion"]);
	});

	it("survives a malformed id instead of throwing", async () => {
		const { resolveSelection } = await import("./selection");
		const { servers } = await resolveSelection({
			connectorIds: ["not-an-object-id"],
			userId: owner,
		});
		expect(servers).toEqual([]);
	});
});

describe("what the client sent about ad-hoc servers", () => {
	it("keeps the URL and drops the credential", async () => {
		const { withoutClientCredentials } = await import("./selection");
		const out = withoutClientCredentials([
			{ name: "Old", url: "https://old.test/mcp", headers: { Authorization: "Bearer leaked" } },
		]);
		expect(out).toEqual([{ name: "Old", url: "https://old.test/mcp" }]);
		expect(JSON.stringify(out)).not.toContain("leaked");
	});
});

describe("the name filter the turn is narrowed by", () => {
	/**
	 * `runMcpFlow` filters the merged server list to `selectedServerNames`, and
	 * the client used to build that list from its servers alone. A turn with one
	 * connector and no servers therefore sent `[]` — an array, so the filter ran
	 * — and arrived with no tools, no error and an answer that just quietly did
	 * not use Notion. This reproduces the filter rather than the whole flow,
	 * because the defect was in what the two sides agreed the list contained.
	 */
	const narrow = (servers: { name: string }[], names: string[] | undefined) =>
		Array.isArray(names) ? servers.filter((s) => names.includes(s.name)) : servers;

	it("drops a connector whose name was left out of the list", () => {
		expect(narrow([{ name: "Notion" }], [])).toEqual([]);
	});

	it("keeps it once the list names it", () => {
		expect(narrow([{ name: "Notion" }], ["Notion"])).toEqual([{ name: "Notion" }]);
	});
});
