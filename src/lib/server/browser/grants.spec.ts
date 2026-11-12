import { beforeAll, describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ on: true, connectors: true }));
vi.mock("./settings", () => ({ browserEnabled: () => flag.on }));
vi.mock("$lib/server/codeEnabled", () => ({ localConnectorsEnabled: () => flag.connectors }));

import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { FAKE_BROWSER_KEY } from "./fakeRuntime";
import { GRANT_TTL_MS, deviceBrowserKey, makeGrant, signGrant, verifyGrant } from "./grants";
import { handleBrowserCall } from "./keyCall";
import { mongoLeaseStore } from "./lease";

await ready;
beforeAll(() => {
	process.env.CHAT_SECRET_KEY = "test-secret-for-browser-keys";
});

const userId = new ObjectId();

async function device(
	status = "paired",
	owner = userId,
	machine: unknown = { mode: "connectors" }
) {
	const _id = new ObjectId();
	await collections.codeDevices.insertOne({
		_id,
		userId: owner,
		machineId: `m-${_id}`,
		name: "Laptop",
		status,
		sub: "s",
		iss: "i",
		backends: [],
		policy: {},
		machine,
		credentialState: { state: "ok" },
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id.toString();
}

describe("signed grants", () => {
	const key = FAKE_BROWSER_KEY;
	const base = { index: 0, id: "approval-1", digest: "a".repeat(32) };

	it("signs id|digest|exp with HMAC-SHA256 in hex, and expires after ten minutes", () => {
		const grant = makeGrant(key, base, 1_000);
		expect(grant.exp).toBe(1_000 + GRANT_TTL_MS);
		expect(GRANT_TTL_MS).toBe(10 * 60_000);
		expect(grant.sig).toBe(
			signGrant(key, { id: "approval-1", digest: base.digest, exp: grant.exp })
		);
		expect(grant.sig).toMatch(/^[0-9a-f]{64}$/);
		// A fixed vector, for the runtime to reproduce.
		expect(
			signGrant(Buffer.alloc(32, 7), {
				id: "approval-1",
				digest: "a".repeat(32),
				exp: 1700000000000,
			})
		).toBe("d149fc5c553d0b73174a2534e58b9582181bcb638dfe75e4462b8677376a0e91");
	});

	it("verifies, and rejects a changed id, digest, expiry or key, and an old grant", () => {
		const grant = makeGrant(key, base, 5_000);
		expect(verifyGrant(key, grant, 6_000)).toBe("ok");
		expect(verifyGrant(key, { ...grant, id: "x" })).toBe("bad");
		expect(verifyGrant(key, { ...grant, digest: "b".repeat(32) })).toBe("bad");
		expect(verifyGrant(key, { ...grant, exp: grant.exp + 1 })).toBe("bad");
		expect(verifyGrant(Buffer.alloc(32, 1), grant, 6_000)).toBe("bad");
		expect(verifyGrant(key, grant, grant.exp + 1)).toBe("expired");
	});

	it("signs a site-rule grant the same way", () => {
		const grant = makeGrant(key, { index: 0, id: "site:shop.example.com", digest: base.digest });
		expect(verifyGrant(key, grant)).toBe("ok");
	});
});

describe("the device's browser key", () => {
	it("is 32 random bytes, made once, kept sealed, and the same on every read", async () => {
		const id = await device();
		const a = await deviceBrowserKey(id, userId);
		const b = await deviceBrowserKey(id, userId);
		expect(a).toHaveLength(32);
		expect(b.equals(a)).toBe(true);
		const row = await collections.codeDevices.findOne({ _id: new ObjectId(id) });
		expect(row?.browserKeySealed).toMatch(/^v1:/);
		expect(row?.browserKeySealed).not.toContain(a.toString("base64"));
		expect((await deviceBrowserKey(await device(), userId)).equals(a)).toBe(false);
	});

	it("agrees on one key when two first uses race", async () => {
		const id = await device();
		const [a, b] = await Promise.all([deviceBrowserKey(id, userId), deviceBrowserKey(id, userId)]);
		expect(a.equals(b)).toBe(true);
	});

	it("is never made for somebody else's device", async () => {
		const id = await device("paired", new ObjectId());
		await expect(deviceBrowserKey(id, userId)).rejects.toThrow("No such machine");
	});
});

describe("the machine call browser.key (PROTOCOL.md 10.7)", () => {
	const frame = (op = "browser.key") => ({ type: "call", id: "c1", op, args: {} }) as never;

	it("hands a paired device its key over the link", async () => {
		flag.on = true;
		const id = await device();
		const res = await handleBrowserCall(id, frame());
		expect(res).toMatchObject({ type: "callres", id: "c1", ok: true });
		const key = (res as { result: { key: string; alg: string } }).result;
		expect(key.alg).toBe("HMAC-SHA256");
		expect(Buffer.from(key.key, "base64url").equals(await deviceBrowserKey(id, userId))).toBe(true);
	});

	it("refuses an unpaired device, an unknown device, an unknown op, and a deployment with browsing off", async () => {
		flag.on = true;
		expect(await handleBrowserCall(await device("pending"), frame())).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await handleBrowserCall(new ObjectId().toString(), frame())).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		expect(await handleBrowserCall(await device(), frame("browser.nope"))).toMatchObject({
			ok: false,
			error: { code: "unsupported" },
		});
		flag.on = false;
		expect(await handleBrowserCall(await device(), frame())).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		flag.on = true;
		flag.connectors = false;
		expect(await handleBrowserCall(await device(), frame())).toMatchObject({
			ok: false,
			error: { code: "forbidden" },
		});
		flag.connectors = true;
		// A machine that cannot serve local servers at all (no connectors mode, no mcp.json).
		expect(
			await handleBrowserCall(await device("paired", userId, { capabilities: {} }), frame())
		).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});
});

describe("the per-device lease (ML3)", () => {
	it("lets one task hold a machine, and frees it on release", async () => {
		const id = await device();
		const first = await mongoLeaseStore.acquire(id, userId, "task-1");
		expect(first).not.toBeNull();
		expect(await mongoLeaseStore.acquire(id, userId, "task-2")).toBeNull();
		await first?.release();
		const second = await mongoLeaseStore.acquire(id, userId, "task-3");
		expect(second).not.toBeNull();
		await second?.release();
	});

	it("is taken by one of two tasks that start together", async () => {
		const id = await device();
		const results = await Promise.all([
			mongoLeaseStore.acquire(id, userId, "a"),
			mongoLeaseStore.acquire(id, userId, "b"),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		await Promise.all(results.map((l) => l?.release()));
	});

	it("frees a machine whose holder crashed, once the lease has run out", async () => {
		const id = await device();
		await mongoLeaseStore.acquire(id, userId, "crashed");
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(id) },
			{ $set: { "browserLease.until": new Date(Date.now() - 1000) } }
		);
		const next = await mongoLeaseStore.acquire(id, userId, "next");
		expect(next).not.toBeNull();
		await next?.release();
	});

	it("check() is true while held, false once another task holds it or the row ran out", async () => {
		const id = await device();
		const lease = await mongoLeaseStore.acquire(id, userId, "mine");
		expect(await lease?.check()).toBe(true);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(id) },
			{ $set: { "browserLease.until": new Date(Date.now() - 1000) } }
		);
		expect(await lease?.check()).toBe(false);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(id) },
			{ $set: { browserLease: { holder: "someone-else", until: new Date(Date.now() + 60_000) } } }
		);
		expect(await lease?.check()).toBe(false);
		await lease?.release();
	});

	it("check() is false when renewal has failed for longer than the TTL", async () => {
		const id = await device();
		const lease = await mongoLeaseStore.acquire(id, userId, "slow");
		expect(await lease?.check()).toBe(true);
		const real = Date.now;
		Date.now = () => real() + 61_000;
		try {
			expect(await lease?.check()).toBe(false);
		} finally {
			Date.now = real;
			await lease?.release();
		}
	});

	it("is not taken on somebody else's device, and a late release by a stale holder frees nothing", async () => {
		const other = await device("paired", new ObjectId());
		expect(await mongoLeaseStore.acquire(other, userId, "x")).toBeNull();
		const id = await device();
		const old = await mongoLeaseStore.acquire(id, userId, "old");
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(id) },
			{ $set: { "browserLease.until": new Date(Date.now() - 1000) } }
		);
		const fresh = await mongoLeaseStore.acquire(id, userId, "fresh");
		await old?.release();
		expect(await mongoLeaseStore.acquire(id, userId, "third")).toBeNull();
		await fresh?.release();
	});
});
