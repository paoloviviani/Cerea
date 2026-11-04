/** Agent auto-approval storage (ADR 0107), against the real database. */
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
	deviceOptedOut,
	getAgentReviewSettings,
	listReviewLog,
	needsPassingTest,
	registerReviewTester,
	saveAgentReviewSettings,
	settingsFingerprint,
	SettingsInvalid,
} from "./agentReview";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	env.killSwitch = undefined;
	registerReviewTester(null);
	await collections.agentReviewConfig.deleteMany({});
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

describe("settings", () => {
	it("default to off, 0.90, the ADR's rows, loop fixed on you, 300 an hour", async () => {
		const s = await getAgentReviewSettings();
		expect(s).toMatchObject({ enabled: false, decisionModelId: null, threshold: 0.9 });
		expect(s.perClass).toEqual(PER_CLASS_DEFAULTS);
		expect(PER_CLASS_DEFAULTS).toMatchObject({
			command: "reviewer",
			outside: "reviewer",
			secrets: "you",
			loop: "you",
		});
		expect(Object.keys(s.perClass).sort()).toEqual([...PERMISSION_CLASSES].sort());
		expect(s.maxPerHourPerMachine).toBe(300);
	});

	it("keep what is saved, and fill the rest from the defaults", async () => {
		await saveAgentReviewSettings({
			enabled: true,
			decisionModelId: "judge",
			threshold: 0.62,
			instructions: "  Routine dev work is fine.  ",
			perClass: { secrets: "reviewer" },
			maxPerHourPerMachine: 50,
		});
		const s = await getAgentReviewSettings();
		expect(s).toMatchObject({
			enabled: true,
			decisionModelId: "judge",
			threshold: 0.62,
			maxPerHourPerMachine: 50,
		});
		expect(s.instructions).toBe("Routine dev work is fine.");
		expect(s.perClass.secrets).toBe("reviewer");
		expect(s.perClass.command).toBe("reviewer");
	});

	it("refuse a threshold below the 0.50 floor or above 0.99", async () => {
		for (const threshold of [0.49, 0.2, 1, 0.995]) {
			await expect(saveAgentReviewSettings({ threshold })).rejects.toBeInstanceOf(SettingsInvalid);
		}
		await saveAgentReviewSettings({ threshold: 0.5 });
		expect((await getAgentReviewSettings()).threshold).toBe(0.5);
	});

	it("refuse loop on the reviewer, and read loop as you whatever is stored", async () => {
		await expect(
			saveAgentReviewSettings({ perClass: { loop: "reviewer" } })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await collections.agentReviewConfig.insertOne({ perClass: { loop: "reviewer" } } as never);
		expect((await getAgentReviewSettings()).perClass.loop).toBe("you");
	});

	it("refuse over-long instructions, fence markers, and enabling without a model", async () => {
		await expect(
			saveAgentReviewSettings({ instructions: "x".repeat(2001) })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await expect(saveAgentReviewSettings({ instructions: "ok ``` then" })).rejects.toBeInstanceOf(
			SettingsInvalid
		);
		await expect(
			saveAgentReviewSettings({ instructions: "BEGIN UNTRUSTED" })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await expect(
			saveAgentReviewSettings({ enabled: true, decisionModelId: null })
		).rejects.toBeInstanceOf(SettingsInvalid);
		await saveAgentReviewSettings({ instructions: "x".repeat(2000) });
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

	it("makes the third step unavailable even with a reviewer configured", async () => {
		await saveAgentReviewSettings({ enabled: true, decisionModelId: "judge" });
		expect((await autoApprovalAvailability()).available).toBe(true);
		env.killSwitch = "false";
		expect((await autoApprovalAvailability()).available).toBe(false);
	});

	it("is not available while the reviewer is off or has no model", async () => {
		expect((await autoApprovalAvailability()).available).toBe(false);
		await saveAgentReviewSettings({ enabled: false, decisionModelId: "judge" });
		expect((await autoApprovalAvailability()).available).toBe(false);
	});
});

describe("the save-time test gate", () => {
	const base = {
		enabled: true,
		decisionModelId: "judge",
		threshold: 0.9,
		instructions: "a",
		perClass: PER_CLASS_DEFAULTS,
		maxPerHourPerMachine: 300,
	};
	it("does not apply until a tester is registered", async () => {
		const saved = await getAgentReviewSettings();
		expect(needsPassingTest(saved, { ...saved, ...base })).toBe(false);
	});
	it("applies to a changed model, threshold or instructions once registered, and passes with a matching fingerprint", async () => {
		registerReviewTester(async () => ({ passed: true, cases: [] }));
		const saved = { ...(await getAgentReviewSettings()), ...base };
		for (const change of [
			{ threshold: 0.8 },
			{ instructions: "b" },
			{ decisionModelId: "other" },
		]) {
			const next = { ...saved, ...change };
			expect(needsPassingTest(saved, next)).toBe(true);
			expect(
				needsPassingTest({ ...saved, testedFingerprint: settingsFingerprint(next) }, next)
			).toBe(false);
		}
		// Turning it on is a change too; unchanged values already running are not.
		expect(needsPassingTest({ ...saved, enabled: false }, saved)).toBe(true);
		expect(
			needsPassingTest(saved, { ...saved, perClass: { ...saved.perClass, edit: "you" } })
		).toBe(false);
		expect(
			needsPassingTest({ ...saved, enabled: false }, { ...saved, enabled: false, threshold: 0.7 })
		).toBe(false);
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
