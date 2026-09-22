/**
 * Unit tests for the machine pairing endpoint: the zod boundaries, the
 * bearer → user mapping, and the dedupe rule, against the real Mongo
 * collections.
 *
 * Hermetic on purpose: the one thing this suite must NOT do is speak to an
 * identity provider. `getOIDCUserFromToken` is mocked (a resolve for the
 * known identity, a reject for the expired token), which is exactly the
 * seam the hook already drew — the endpoint's own logic starts at the claims,
 * and the userinfo round trip itself was verified against the live issuer
 * when the endpoint was built. The relay probe is mocked for the same reason
 * (it would dial `CODE_RELAY_URL`); the tests assert it runs *before* any
 * row is written, which is the load-bearing order.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/auth", () => ({
	getOIDCUserFromToken: vi.fn(),
}));

vi.mock("$lib/server/codeDaemon", () => ({
	probePairingOffer: vi.fn(),
}));

vi.mock("$lib/server/codeEnabled", () => ({
	codeAgentsEnabled: () => true,
}));

import { POST } from "./+server";
import { collections, ready } from "$lib/server/database";
import { getOIDCUserFromToken } from "$lib/server/auth";
import { probePairingOffer } from "$lib/server/codeDaemon";
import type { CodeDevice } from "$lib/types/CodeAgent";

const mockedUserinfo = vi.mocked(getOIDCUserFromToken);
const mockedProbe = vi.mocked(probePairingOffer);

const USER_ID = new ObjectId();

const userRow = {
	_id: USER_ID,
	name: "Pairing Tester",
	email: "pairing@example.org",
	avatarUrl: "",
	hfUserId: "userinfo-sub-1",
	createdAt: new Date(),
	updatedAt: new Date(),
};

async function call(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	const request = new Request("http://localhost:5173/api/v2/code/enroll/machine", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const event = {
		request,
		url: new URL(request.url),
	} as unknown as Parameters<typeof POST>[0];
	return POST(event);
}

/** Resolves to the HttpError the endpoint raised (or null when it responded). */
async function catchError(promise: Promise<Response>): Promise<unknown> {
	try {
		await promise;
		return null;
	} catch (err) {
		return err;
	}
}

function pairingOffer() {
	return `https://app.paseo.sh/#offer=${Buffer.from(
		JSON.stringify({
			v: 2,
			serverId: "srv_machine_1",
			daemonPublicKeyB64: "dGVzdC1wdWJsaWMta2V5",
		})
	).toString("base64url")}`;
}

/** HttpError (the `error()` helper) carries status + message body. */
function errorOf(err: unknown): { status: number; message: string } {
	expect(err).toBeTruthy();
	const e = err as { status?: number; body?: { message?: string } };
	return { status: e.status ?? 0, message: e.body?.message ?? "" };
}

beforeAll(async () => {
	// The collections object is assigned by the module's connect promise;
	// awaiting it is the only setup this suite needs.
	await ready;
});

beforeEach(async () => {
	vi.clearAllMocks();
	mockedUserinfo.mockResolvedValue({ sub: userRow.hfUserId } as never);
	mockedProbe.mockResolvedValue({ version: "0.8.0" });
	await collections.users.deleteMany({});
	await collections.codeDevices.deleteMany({});
	await collections.users.insertOne(userRow);
});

afterEach(async () => {
	await collections.users.deleteMany({});
	await collections.codeDevices.deleteMany({});
});

describe("POST /api/v2/code/enroll/machine", () => {
	it("refuses a call with no bearer before touching anything", async () => {
		const err = errorOf(await call({ name: "box", offer: pairingOffer() }).catch((e) => e));
		expect(err.status).toBe(401);
		expect(err.message).toContain("Bearer");
		expect(mockedUserinfo).not.toHaveBeenCalled();
		expect(mockedProbe).not.toHaveBeenCalled();
		expect(await collections.codeDevices.countDocuments()).toBe(0);
	});

	it("answers 401 with a re-enroll message when the provider rejects the token", async () => {
		mockedUserinfo.mockRejectedValue(new Error("invalid_grant"));
		const err = errorOf(
			await catchError(
				call({ name: "box", offer: pairingOffer() }, { authorization: "Bearer stale-token" })
			)
		);
		expect(err.status).toBe(401);
		expect(err.message.toLowerCase()).toContain("run the enrollment again");
		expect(await collections.codeDevices.countDocuments()).toBe(0);
	});

	it("answers 404 when the token's sub matches no chat user", async () => {
		mockedUserinfo.mockResolvedValue({ sub: "never-seen-in-the-chat" } as never);
		const err = errorOf(
			await catchError(
				call({ name: "box", offer: pairingOffer() }, { authorization: "Bearer good-token" })
			)
		);
		expect(err.status).toBe(404);
		expect(err.message).toContain("Log into the chat once before pairing a machine");
		expect(await collections.codeDevices.countDocuments()).toBe(0);
	});

	it("rejects a malformed body with 400", async () => {
		const err = errorOf(
			await call({ name: "", offer: pairingOffer() }, { authorization: "Bearer good-token" }).catch(
				(e) => e
			)
		);
		expect(err.status).toBe(400);
		expect(mockedProbe).not.toHaveBeenCalled();
	});

	it("rejects a malformed offer with 400 and writes nothing", async () => {
		const err = errorOf(
			await catchError(
				call(
					{ name: "box", offer: "https://app.paseo.sh/#offer=not-json" },
					{ authorization: "Bearer good-token" }
				)
			)
		);
		expect(err.status).toBe(400);
		expect(await collections.codeDevices.countDocuments()).toBe(0);
	});

	it("refuses to write a row when the probe fails", async () => {
		mockedProbe.mockRejectedValue(
			Object.assign(new Error("unreachable"), { status: 502, body: { message: "no daemon" } })
		);
		const err = errorOf(
			await catchError(
				call({ name: "box", offer: pairingOffer() }, { authorization: "Bearer good-token" })
			)
		);
		expect(err.status).toBe(502);
		expect(await collections.codeDevices.countDocuments()).toBe(0);
	});

	it("pairs the machine: probe first, then a paired row owned by the token's user", async () => {
		const response = await call(
			{ name: "lab box", offer: pairingOffer() },
			{ authorization: "Bearer good-token" }
		);
		expect(response.status).toBe(200);

		// The probe ran against the offer's own relay identity — the row is
		// only written after it answered.
		expect(mockedProbe).toHaveBeenCalledWith({
			serverId: "srv_machine_1",
			daemonPublicKey: "dGVzdC1wdWJsaWMta2V5",
		});

		const rows = await collections.codeDevices.find().toArray();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row.userId?.toString()).toBe(USER_ID.toString());
		expect(row.status).toBe("paired");
		expect(row.name).toBe("lab box");
		expect(row.daemonId).toBe("srv_machine_1");
		expect(row.daemonPublicKey).toBe("dGVzdC1wdWJsaWMta2V5");
		expect(row.pairedAt).toBeTruthy();
		expect(row.pairingCode).toBeUndefined();
		expect(row.expiresAt).toBeUndefined();

		const body = superjson.parse(await response.text()) as { device: Record<string, unknown> };
		expect(body.device).toMatchObject({
			name: "lab box",
			status: "paired",
			daemonId: "srv_machine_1",
		});
	});

	it("re-pairing the same daemon rotates the key instead of duplicating the row", async () => {
		const now = new Date();
		const existing: CodeDevice = {
			_id: new ObjectId(),
			userId: USER_ID,
			name: "lab box",
			status: "paired",
			daemonId: "srv_machine_1",
			daemonPublicKey: "old-key",
			createdAt: now,
			updatedAt: now,
			pairedAt: now,
		};
		await collections.codeDevices.insertOne(existing);

		const offer = `https://app.paseo.sh/#offer=${Buffer.from(
			JSON.stringify({
				v: 2,
				serverId: "srv_machine_1",
				daemonPublicKeyB64: "bmV3LWtleQ==",
			})
		).toString("base64url")}`;

		const response = await call(
			{ name: "lab box (re-paired)", offer },
			{ authorization: "Bearer good-token" }
		);
		expect(response.status).toBe(200);

		const rows = await collections.codeDevices.find({ userId: USER_ID }).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0].daemonPublicKey).toBe("bmV3LWtleQ==");
		expect(rows[0].name).toBe("lab box (re-paired)");
		expect(rows[0]._id.toString()).toBe(existing._id.toString());
	});

	it("never dedupes across owners: another user's daemon id does not match", async () => {
		const other = new ObjectId();
		await collections.codeDevices.insertOne({
			_id: new ObjectId(),
			userId: other,
			name: "someone else's box",
			status: "paired",
			daemonId: "srv_machine_1",
			daemonPublicKey: "their-key",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		await call({ name: "box", offer: pairingOffer() }, { authorization: "Bearer good-token" });

		const rows = await collections.codeDevices.find({ daemonId: "srv_machine_1" }).toArray();
		expect(rows).toHaveLength(2);
	});
});
