/** Saving the Auto rows re-sends the map to the user's sessions on Auto (ADR 0109). */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { collections, ready } from "$lib/server/database";
import { saveUserReviewSettings } from "$lib/server/agentReview";
import { resendAutoMap, type ResendDeps } from "./resend";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.agentReviewUserSettings.deleteMany({});
});

const OLD = { edit: "ask", command: "ask" };
const sessions = [
	{ id: "auto", permissionMode: "ask", autoClasses: OLD },
	{ id: "plain-ask", permissionMode: "ask" },
	{ id: "allow", permissionMode: "allow" },
	{ id: "plan", permissionMode: "deny" },
	{ id: "child", parentId: "auto", permissionMode: "ask", autoClasses: OLD },
];

function deps(online: Record<string, boolean>) {
	const sent: Array<{ device: string; args: Record<string, unknown> }> = [];
	const d: ResendDeps = {
		devices: async () => Object.keys(online),
		online: (id) => online[id],
		link: (id) =>
			({
				sessionList: async () => ({ sessions: sessions as never }),
				sessionSetPermissionMode: async (args: Record<string, unknown>) => {
					sent.push({ device: id, args });
					return {};
				},
			}) as never,
	};
	return { d, sent };
}

describe("resendAutoMap", () => {
	it("sends the user's new map to root sessions on Auto on connected machines only", async () => {
		const user = new ObjectId();
		await saveUserReviewSettings(user, { perClass: { edit: "run" } });
		const { d, sent } = deps({ on: true, off: false });
		expect(await resendAutoMap(user, d)).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			device: "on",
			args: { sessionId: "auto", mode: "ask", autoClasses: { edit: "run", command: "ask" } },
		});
	});

	it("skips a session that already carries the map, and never throws on a machine that fails", async () => {
		const user = new ObjectId();
		await saveUserReviewSettings(user, {});
		const map = {
			edit: "run",
			command: "ask",
			web: "run",
			outside: "ask",
			secrets: "ask",
			agents: "run",
			tools: "run",
			loop: "ask",
		};
		sessions[0] = { id: "auto", permissionMode: "ask", autoClasses: map } as never;
		const { d, sent } = deps({ on: true });
		expect(await resendAutoMap(user, d)).toBe(0);
		expect(sent).toHaveLength(0);
		const broken: ResendDeps = {
			...d,
			link: () =>
				({
					sessionList: async () => {
						throw new Error("offline");
					},
				}) as never,
		};
		expect(await resendAutoMap(user, broken)).toBe(0);
	});
});
