/**
 * `deviceView`'s re-enroll flag (ADR 0093 §12) and `listDevices`'s filter,
 * against the fixed issuer `vitest-setup-server.ts` configures
 * (`CODE_MACHINE_ISSUER=http://127.0.0.1:18999`) — config is a process-wide
 * snapshot no spec can flip per test, so every case here is written against
 * that one fixed value rather than a mocked one.
 *
 * `enrolledIssuer`/`revokedAt` aren't declared on `CodeDevice` on this branch
 * yet (they land with `auth/c-gateway-identity`); inserted via `as never`,
 * matching the rest of this suite's own workaround for the same gap.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { deviceView, listDevices } from "./codeDevices";
import type { CodeDevice } from "$lib/types/CodeAgent";

const CONFIGURED_ISSUER = "http://127.0.0.1:18999";

let insertedUserIds: ObjectId[] = [];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	insertedUserIds = [];
});

function baseDevice(overrides: Record<string, unknown> = {}): CodeDevice {
	return {
		_id: new ObjectId(),
		userId: new ObjectId(),
		machineId: `m-${new ObjectId()}`,
		name: "laptop",
		status: "paired",
		sub: "sub",
		iss: "iss",
		backends: [],
		policy: {},
		credentialState: "ok",
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as never as CodeDevice;
}

describe("deviceView: the re-enroll flag", () => {
	it("is absent when enrolledIssuer matches the configured issuer and nothing is revoked", () => {
		const view = deviceView(baseDevice({ enrolledIssuer: CONFIGURED_ISSUER }), true);
		expect(view.reenroll).toBeUndefined();
	});

	it("is absent for a device that predates enrolledIssuer/revokedAt entirely", () => {
		const view = deviceView(baseDevice(), true);
		expect(view.reenroll).toBeUndefined();
	});

	it("is issuer_changed when enrolledIssuer no longer matches, and still paired", () => {
		const view = deviceView(baseDevice({ enrolledIssuer: "https://old-idp.example.org" }), true);
		expect(view.reenroll).toBe("issuer_changed");
	});

	it("is revoked when revokedAt is set, regardless of enrolledIssuer", () => {
		const view = deviceView(
			baseDevice({
				status: "revoked",
				enrolledIssuer: CONFIGURED_ISSUER,
				revokedAt: new Date(),
			}),
			false
		);
		expect(view.reenroll).toBe("revoked");
	});

	it("prefers revoked over issuer_changed when both would otherwise apply", () => {
		const view = deviceView(
			baseDevice({
				status: "revoked",
				enrolledIssuer: "https://old-idp.example.org",
				revokedAt: new Date(),
			}),
			false
		);
		expect(view.reenroll).toBe("revoked");
	});
});

describe("listDevices", () => {
	it("includes a gateway-revoked device (revokedAt set), but excludes a plain manual revoke", async () => {
		const userId = new ObjectId();
		insertedUserIds.push(userId);
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
		} as never);

		const gatewayRevoked = baseDevice({
			userId,
			name: "gateway-revoked",
			status: "revoked",
			revokedAt: new Date(),
		});
		const manuallyRevoked = baseDevice({ userId, name: "manually-revoked", status: "revoked" });
		const stillPaired = baseDevice({ userId, name: "still-paired" });
		await collections.codeDevices.insertMany([gatewayRevoked, manuallyRevoked, stillPaired]);

		const views = await listDevices({ user: { _id: userId } } as never);
		const names = views.map((v) => v.name).sort();

		expect(names).toEqual(["gateway-revoked", "still-paired"]);
		expect(views.find((v) => v.name === "gateway-revoked")?.reenroll).toBe("revoked");
		expect(views.find((v) => v.name === "still-paired")?.reenroll).toBeUndefined();

		await collections.codeDevices.deleteMany({
			_id: { $in: [gatewayRevoked._id, manuallyRevoked._id, stillPaired._id] },
		});
	});
});
