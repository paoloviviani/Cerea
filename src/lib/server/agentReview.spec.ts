/** Agent auto-approval storage (ADR 0107, per user since ADR 0109), against the real database. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({ killSwitch: undefined as string | undefined }));
vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		config: new Proxy(actual.config, {
			get: (t, k) => (k === "CHAT_AUTO_PERMISSIONS" ? env.killSwitch : Reflect.get(t, k)),
		}),
	};
});

import { collections, ready } from "$lib/server/database";
import { PERMISSION_CLASSES } from "$lib/types/machineProtocol";
import { PER_CLASS_DEFAULTS, SUMMARY_MAX } from "$lib/types/AgentReview";
import {
	appendReviewLog,
	autoApprovalAvailability,
	autoPermissionsEnabled,
	autoClassMap,
	deviceOptedOut,
	effectiveReviewSettings,
	getUserReviewSettings,
	listReviewLog,
	registerReviewTester,
	saveUserReviewSettings,
	setDeploymentReviewEnabled,
	SettingsInvalid,
} from "./agentReview";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	env.killSwitch = undefined;
	registerReviewTester(null);
	await collections.agentReviewConfig.deleteMany({});
	await collections.agentReviewUserSettings.deleteMany({});
	await collections.agentReviewLog.deleteMany({});
});

const user = new ObjectId();
const entry = (over: Record<string, unknown> = {}) => ({
	userId: user,
	deviceId: "d1",
	machine: "studio-laptop",
	sessionId: "s1",
	class: "command" as const,
	summary: "npm test",
	probability: 0.96,
	outcome: "allowed" as const,
	reason: "routine",
	applied: true,
	modelId: "judge",
	...over,
});

/** Auto-approval needs the administrator's switch and the user's own reviewer. */
async function setUp(userId: ObjectId, over: Record<string, unknown> = {}) {
	await setDeploymentReviewEnabled(true);
	await saveUserReviewSettings(userId, { enabled: true, decisionModelId: "judge", ...over });
}

describe("a user's settings", () => {
	it("default to off, 0.85, the amendment's rows, loop fixed on you, 300 an hour", async () => {
		const s = await getUserReviewSettings(user);
		expect(s).toMatchObject({ enabled: false, decisionModelId: null, threshold: 0.85 });
		expect(s.perClass).toEqual(PER_CLASS_DEFAULTS);
		expect(PER_CLASS_DEFAULTS).toEqual({
			edit: "run",
			command: "reviewer",
			web: "run",
			outside: "reviewer",
			secrets: "you",
			agents: "run",
			tools: "run",
			loop: "you",
		});
		expect(Object.keys(s.perClass).sort()).toEqual([...PERMISSION_CLASSES].sort());
		expect(s.maxPerHourPerMachine).toBe(300);
		// Nothing to copy: nothing is stored by a read.
		expect(await collections.agentReviewUserSettings.countDocuments({})).toBe(0);
	});

	it("keep what is saved, per user, and fill the rest from the defaults", async () => {
		await saveUserReviewSettings(user, {
			enabled: true,
			decisionModelId: "judge",
			threshold: 0.62,
			instructions: "  Routine dev work is fine.  ",
			perClass: { secrets: "reviewer", edit: "reviewer" },
		});
		const s = await getUserReviewSettings(user);
		expect(s).toMatchObject({ enabled: true, decisionModelId: "judge", threshold: 0.62 });
		expect(s.instructions).toBe("Routine dev work is fine.");
		expect(s.perClass).toMatchObject({
			secrets: "reviewer",
			edit: "reviewer",
			command: "reviewer",
		});
		// Another user never sees them.
		const other = await getUserReviewSettings(new ObjectId());
		expect(other).toMatchObject({ enabled: false, decisionModelId: null });
	});

	it("refuse a threshold below the 0.50 floor or above 0.99", async () => {
		for (const threshold of [0.49, 0.2, 1, 0.995]) {
			await expect(saveUserReviewSettings(user, { threshold })).rejects.toBeInstanceOf(
				SettingsInvalid
			);
		}
		await saveUserReviewSettings(user, { threshold: 0.5 });
		expect((await getUserReviewSettings(user)).threshold).toBe(0.5);
	});

	it("refuse loop off you and secrets that run, and read them safely whatever is stored", async () => {
		for (const bad of [{ loop: "reviewer" }, { loop: "run" }, { secrets: "run" }] as const) {
			await expect(saveUserReviewSettings(user, { perClass: bad })).rejects.toBeInstanceOf(
				SettingsInvalid
			);
		}
		await collections.agentReviewUserSettings.insertOne({
			userId: user,
			perClass: { loop: "run", secrets: "run" },
		} as never);
		const s = await getUserReviewSettings(user);
		expect(s.perClass).toMatchObject({ loop: "you", secrets: "you" });
	});

	it("refuse over-long instructions, fence markers, and enabling without a model", async () => {
		await expect(
			saveUserReviewSettings(user, { instructions: "x".repeat(2001) })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await expect(
			saveUserReviewSettings(user, { instructions: "ok ``` then" })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await expect(
			saveUserReviewSettings(user, { instructions: "BEGIN UNTRUSTED" })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await expect(
			saveUserReviewSettings(user, { enabled: true, decisionModelId: null })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await saveUserReviewSettings(user, { instructions: "x".repeat(2000) });
	});
});

describe("the first read of a user with no settings (migration)", () => {
	it("starts from the deployment's earlier model, threshold, instructions and rows, once", async () => {
		await collections.agentReviewConfig.insertOne({
			enabled: true,
			decisionModelId: "old-judge",
			threshold: 0.9,
			instructions: "Old policy.",
			perClass: { command: "reviewer", edit: "reviewer", web: "you", secrets: "you" },
			maxPerHourPerMachine: 300,
		} as never);
		const s = await getUserReviewSettings(user);
		expect(s).toMatchObject({
			enabled: true,
			decisionModelId: "old-judge",
			threshold: 0.9,
			instructions: "Old policy.",
		});
		// Rows that never saw a card under the default machine limits seed as "runs"; the rest carry.
		expect(s.perClass).toMatchObject({ command: "reviewer", edit: "run", web: "you", loop: "you" });
		// Copy-on-read: this user's copy is stored, nobody else's is.
		expect(await collections.agentReviewUserSettings.countDocuments({})).toBe(1);
		// Later changes to the deployment's old fields do not move the copy.
		await collections.agentReviewConfig.updateOne({}, { $set: { decisionModelId: "newer" } });
		expect((await getUserReviewSettings(user)).decisionModelId).toBe("old-judge");
		// Another user is not touched until they read.
		expect(await collections.agentReviewUserSettings.countDocuments({ userId: user })).toBe(1);
	});

	it("leaves a user's own settings alone, and never copies when the deployment had no model", async () => {
		await collections.agentReviewConfig.insertOne({ enabled: true } as never);
		expect((await getUserReviewSettings(user)).decisionModelId).toBeNull();
		expect(await collections.agentReviewUserSettings.countDocuments({})).toBe(0);
	});
});

describe("what the review service decides with", () => {
	it("is the user's own settings, on only while the administrator's switch is too", async () => {
		const other = new ObjectId();
		await setUp(user, { threshold: 0.7 });
		await setDeploymentReviewEnabled(true);
		expect(await effectiveReviewSettings(user)).toMatchObject({ enabled: true, threshold: 0.7 });
		// Another user's settings are never used for this one.
		expect(await effectiveReviewSettings(other)).toMatchObject({ enabled: false, threshold: 0.85 });
		await setDeploymentReviewEnabled(false);
		expect((await effectiveReviewSettings(user)).enabled).toBe(false);
	});
});

describe("the Auto map", () => {
	it("sends run for the classes that run and ask for the rest, loop and secrets always ask", () => {
		expect(autoClassMap(PER_CLASS_DEFAULTS)).toEqual({
			edit: "run",
			command: "ask",
			web: "run",
			outside: "ask",
			secrets: "ask",
			agents: "run",
			tools: "run",
			loop: "ask",
		});
		expect(autoClassMap({ ...PER_CLASS_DEFAULTS, edit: "reviewer", web: "you" })).toMatchObject({
			edit: "ask",
			web: "ask",
		});
	});
});

describe("the kill switch", () => {
	it("is on unless exactly 'false'", () => {
		expect(autoPermissionsEnabled()).toBe(true);
		env.killSwitch = "";
		expect(autoPermissionsEnabled()).toBe(true);
		env.killSwitch = "false";
		expect(autoPermissionsEnabled()).toBe(false);
	});

	it("makes Auto's reviewer unavailable even with one configured", async () => {
		await setUp(user);
		expect((await autoApprovalAvailability(user)).available).toBe(true);
		env.killSwitch = "false";
		expect((await autoApprovalAvailability(user)).available).toBe(false);
	});

	it("is not available while the administrator's switch is off, or the user's reviewer is off or has no model", async () => {
		expect((await autoApprovalAvailability(user)).available).toBe(false);
		await setUp(user);
		await setDeploymentReviewEnabled(false);
		expect((await autoApprovalAvailability(user)).available).toBe(false);
		await setUp(user, { enabled: false });
		expect((await autoApprovalAvailability(user)).available).toBe(false);
	});
});

describe("the review log", () => {
	it("is created with a 90-day TTL and the view's indexes", async () => {
		let indexes: Array<{ key: Record<string, number>; expireAfterSeconds?: number }> = [];
		for (let i = 0; i < 50 && indexes.length < 6; i++) {
			indexes = (await collections.agentReviewLog.indexes()) as typeof indexes;
			if (indexes.length < 6) await new Promise((r) => setTimeout(r, 100));
		}
		expect(indexes.find((x) => x.key.time === 1 && !x.key.deviceId)?.expireAfterSeconds).toBe(
			90 * 86400
		);
		const keys = indexes.map((x) => Object.keys(x.key).join(","));
		for (const k of ["time,_id", "deviceId,time", "outcome,time", "class,time", "userId,time"]) {
			expect(keys).toContain(k);
		}
	});

	it("caps the summary and lists newest first, filtered, with keyset paging", async () => {
		await appendReviewLog(entry({ summary: "x".repeat(SUMMARY_MAX + 50), time: new Date(1000) }));
		for (let i = 1; i <= 5; i++) {
			await appendReviewLog(
				entry({
					summary: `cmd ${i}`,
					time: new Date(1000 + i * 1000),
					outcome: i % 2 ? "allowed" : "escalated",
					class: i === 5 ? "outside" : "command",
					deviceId: i === 4 ? "d2" : "d1",
				})
			);
		}
		const first = await listReviewLog({ limit: 3 });
		expect(first.entries.map((e) => e.summary)).toEqual(["cmd 5", "cmd 4", "cmd 3"]);
		expect(first.next).not.toBeNull();
		const second = await listReviewLog({ limit: 3, before: first.next as Date });
		expect(second.entries.map((e) => e.summary.slice(0, 5))).toEqual(["cmd 2", "cmd 1", "xxxxx"]);
		expect(second.entries[2].summary).toHaveLength(SUMMARY_MAX);
		expect(second.next).toBeNull();

		expect((await listReviewLog({ outcome: "escalated" })).entries).toHaveLength(2);
		expect((await listReviewLog({ class: "outside" })).entries.map((e) => e.summary)).toEqual([
			"cmd 5",
		]);
		expect((await listReviewLog({ deviceId: "d2" })).entries.map((e) => e.summary)).toEqual([
			"cmd 4",
		]);
	});
});

describe("the device opt-out", () => {
	it("is read per device for its owner only", async () => {
		const owner = new ObjectId();
		const id = new ObjectId();
		await collections.codeDevices.insertOne({
			_id: id,
			userId: owner,
			machineId: `m-${id}`,
			neverReview: true,
		} as never);
		expect(await deviceOptedOut(owner, id.toString())).toBe(true);
		expect(await deviceOptedOut(new ObjectId(), id.toString())).toBe(false);
		expect(await deviceOptedOut(owner, "not-an-id")).toBe(false);
		await collections.codeDevices.updateOne({ _id: id }, { $set: { neverReview: false } });
		expect(await deviceOptedOut(owner, id.toString())).toBe(false);
		await collections.codeDevices.deleteOne({ _id: id });
	});
});
