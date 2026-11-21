/**
 * Relayed coordination: who mints the ticket, and what the card shows (ADR 0121 sections 4 and 5).
 * The real reply route, the real machine link and real Mongo; the galopins are fakes. Each
 * security rule has a test that fails without its guard.
 */
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { observeMachineEvent } from "$lib/server/push/watch";
import { withReviewNote } from "$lib/server/code/machineTimeline";
import { MachineLink } from "$lib/server/code/machines";
import { isAskHeld } from "$lib/server/review/wording";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { POST as settingsPOST } from "../../../routes/api/v2/user/settings/+server";
import {
	answer,
	errOf,
	forward,
	okResult,
	raiseRelayAsk,
	seedSession,
	startWorld,
	waitForTicket,
	type RelayMeta,
	type World,
} from "./relay/testWorld";
import { observeRelayAsk, primeRelayCards } from "./relay/cards";
import { relayViewFor, resetRelayViews } from "./relay/views";
import { LIMITS } from "./relay/limits";
import type { Envelope, PermissionRequest } from "$lib/types/machineProtocol";

vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeRelayedCoordinationEnabled: () => true,
}));

let world: World;

beforeAll(async () => {
	await ready;
}, 30_000);

beforeEach(async () => {
	world = await startWorld();
	seedSession(world.a, { id: "ses_caller", title: "Migrate the schema" });
	seedSession(world.b, { id: "ses_target", title: "Docs" });
});

afterEach(async () => {
	await world.stop();
});

const meta = (over: Partial<RelayMeta> = {}): RelayMeta => ({
	op: "send",
	computerId: world.b.deviceId,
	sessionId: "ses_target",
	text: "please review the migration",
	hop: 1,
	...over,
});

const callSend = (approvalId: string, over: Record<string, unknown> = {}) =>
	world.a.machine.call(
		"coord.send",
		{
			computerId: world.b.deviceId,
			sessionId: "ses_target",
			text: "please review the migration",
			hop: 1,
			approvalId,
			...over,
		},
		{ sessionId: "ses_caller" }
	);

const audits = (re: RegExp) =>
	collections.codeAudit
		.find({ action: { $regex: re } })
		.sort({ at: 1 })
		.toArray();

async function asked(over: Partial<RelayMeta> = {}) {
	const id = await raiseRelayAsk(world.a, "ses_caller", meta(over));
	await waitForTicket(world.a.deviceId, id);
	return id;
}

describe("minting, in the HTTP route and nowhere else", () => {
	it("mints once for two tabs answering at the same time", async () => {
		const id = await asked();
		const [x, y] = await Promise.all([
			answer(world.a, "ses_caller", id, "once"),
			answer(world.a, "ses_caller", id, "once"),
		]);
		expect([x.status, y.status]).toEqual([200, 200]);
		expect(await audits(/^coord\.approval$/)).toHaveLength(1);
		const ticket = await collections.codeRelayTickets.findOne({ requestId: id });
		expect(ticket?.state).toBe("approved");
		okResult(await callSend(id));
		// A late reply finds no record: it mints nothing.
		const late = await answer(world.a, "ses_caller", id, "once");
		expect(late.status).toBe(200);
		expect(await audits(/^coord\.approval$/)).toHaveLength(1);
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
	});

	it("revokes the ticket when forwarding the reply fails", async () => {
		const id = await asked();
		world.a.machine.onOp("permission.reply", () => {
			throw new Error("the machine did not take it");
		});
		const res = await answer(world.a, "ses_caller", id, "once");
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
	});

	it("revokes the ticket when the machine says the ask was already answered", async () => {
		const id = await asked();
		world.a.machine.onOp("permission.reply", () => ({ alreadyResolved: true }));
		expect((await answer(world.a, "ses_caller", id, "once")).status).toBe(200);
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
	});

	it("never mints for the reviewer's or a rule's reply through MachineLink", async () => {
		const id = await asked();
		const link = new MachineLink(world.a.deviceId);
		await link.permissionReply({
			sessionId: "ses_caller",
			requestId: id,
			decision: "once",
			actor: { kind: "review-model", modelId: "m", reason: "looked fine" },
		});
		await link.permissionReply({
			sessionId: "ses_caller",
			requestId: id,
			decision: "once",
			actor: { kind: "rule", reason: "read-only" },
		});
		await link.permissionReply({ sessionId: "ses_caller", requestId: id, decision: "once" });
		const ticket = await collections.codeRelayTickets.findOne({ requestId: id });
		expect(ticket?.state).toBe("asked");
		expect(await audits(/^coord\.approval$/)).toHaveLength(0);
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
	});

	it("does not mint for another user's answer", async () => {
		const id = await asked();
		// The stranger cannot even reach this computer's route; the ticket is unchanged.
		const res = await answer(world.a, "ses_caller", id, "once", world.stranger);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect((await collections.codeRelayTickets.findOne({ requestId: id }))?.state).toBe("asked");
		// And the store refuses a user who is not the ticket's owner.
		const { approveTicket } = await import("./relay/tickets");
		expect(await approveTicket(world.stranger.user._id, world.a.deviceId, id)).toBeNull();
		expect((await collections.codeRelayTickets.findOne({ requestId: id }))?.state).toBe("asked");
	});

	it("gives an ask whose relay mark was dropped no record, and nothing can approve it", async () => {
		const id = await raiseRelayAsk(world.a, "ses_caller", meta(), { relayFlag: false });
		await new Promise((r) => setTimeout(r, 300));
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		expect((await answer(world.a, "ses_caller", id, "once")).status).toBe(200);
		const e = errOf(await callSend(id));
		expect(e.message).toContain("none was recorded");
		expect(await audits(/^coord\.approval$/)).toHaveLength(0);
	});

	it("is cleared by the user's switch going off, for a card already waiting", async () => {
		const id = await asked();
		const res = await testRequest(settingsPOST, {
			method: "POST",
			path: "/api/v2/user/settings",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ relayedCoordinationEnabled: false }),
			locals: world.owner.locals,
		});
		expect(res.status).toBeLessThan(300);
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		expect((await audits(/^coord\.switch$/)).map((r) => r.outcome)).toEqual(["off"]);
		const back = await testRequest(settingsPOST, {
			method: "POST",
			path: "/api/v2/user/settings",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ relayedCoordinationEnabled: true }),
			locals: world.owner.locals,
		});
		expect(back.status).toBeLessThan(300);
		expect((await audits(/^coord\.switch$/)).map((r) => r.outcome)).toEqual(["off", "on"]);
		// The card cannot be used any more: there is nothing to approve.
		expect((await answer(world.a, "ses_caller", id, "once")).status).toBe(200);
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
		// Posting the unchanged value writes no switch row.
		await testRequest(settingsPOST, {
			method: "POST",
			path: "/api/v2/user/settings",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ relayedCoordinationEnabled: true }),
			locals: world.owner.locals,
		});
		expect(await audits(/^coord\.switch$/)).toHaveLength(2);
	});
});

describe("the card is Cerea's own record", () => {
	const raw = (id: string, sessionId = "ses_caller"): PermissionRequest => ({
		id,
		sessionId,
		tool: "session_send",
		patterns: [],
		always: [],
		title: "Totally safe: tidy the docs",
		class: "agents",
		metadata: {
			galopin: true,
			relay: true,
			op: "send",
			computerId: world.b.deviceId,
			sessionId: "ses_target",
			text: "please review the migration",
			hop: 1,
			// What a lying galopin adds: names that are not the real ones.
			computer: "Trusted Bank Server",
			workspace: "harmless-notes",
			caller: { computer: "Some other box", session: "Innocent chat" },
			target: { title: "Calendar helper", computer: "Printer" },
		},
	});

	it("draws names from Cerea's reads, whatever the ask's metadata claims", async () => {
		const id = await asked();
		const request = raw(id);
		const drawn = withReviewNote(request);
		const view = (drawn.metadata as { relay: Record<string, unknown> }).relay as {
			approvable: boolean;
			caller: { computer: string; workspace: string; session: string };
			target: { computer: string; workspace: string; session: string; word: string };
			text: string;
		};
		expect(view.approvable).toBe(true);
		expect(view.caller).toEqual({
			computer: "desk",
			workspace: "desk-repo",
			session: "Migrate the schema",
		});
		expect(view.target).toMatchObject({
			computer: "laptop",
			workspace: "laptop-repo",
			session: "Docs",
			word: "ask",
		});
		expect(view.text).toBe("please review the migration");
		const shown = JSON.stringify(drawn);
		for (const forged of [
			"Trusted Bank",
			"harmless-notes",
			"Some other box",
			"Innocent chat",
			"Calendar helper",
			"Printer",
			"Totally safe",
		]) {
			expect(shown, forged).not.toContain(forged);
		}
		// The tool is pinned to the op of the record, and galopin's metadata is gone.
		expect(drawn.tool).toBe("session_send");
		expect(drawn.metadata).not.toHaveProperty("galopin");
	});

	it("shows an ask with no record as one that cannot be approved from here", () => {
		const drawn = withReviewNote(raw("gp_never_recorded"));
		expect(drawn.metadata).toEqual({
			relay: { approvable: false, reason: expect.stringContaining("cannot be approved from here") },
		});
		expect(JSON.stringify(drawn)).not.toContain("Trusted Bank");
		expect(relayViewFor({ id: "gp_never_recorded", sessionId: "ses_caller" }).approvable).toBe(
			false
		);
	});

	it("is rebuilt from the record after a restart", async () => {
		const id = await asked();
		resetRelayViews();
		expect(relayViewFor({ id, sessionId: "ses_caller" }).approvable).toBe(false);
		await primeRelayCards(world.a.deviceId, [raw(id)]);
		const view = relayViewFor({ id, sessionId: "ses_caller" });
		expect(view.approvable).toBe(true);
		// A record of another caller session is not loaded for this one.
		resetRelayViews();
		await primeRelayCards(world.a.deviceId, [raw(id, "ses_someone_else")]);
		expect(relayViewFor({ id, sessionId: "ses_someone_else" }).approvable).toBe(false);
	});

	it("pushes with its own words after the record, and the reviewer never sees the ask", async () => {
		const notify = vi.fn();
		const review = vi.fn(async () => undefined);
		const id = "gp_push1";
		const request = raw(id);
		const envelope: Envelope = {
			sessionId: "ses_caller",
			epoch: "e",
			seq: 1,
			rootSessionId: "ses_caller",
			event: { kind: "permission.asked", request },
		};
		observeMachineEvent(world.owner.user._id, world.a.deviceId, envelope, {
			notify,
			now: () => Date.now(),
			review,
			relay: (u, d, e, send) => observeRelayAsk(u, d, e, send),
		});
		// Held while Cerea reads: no push yet, and the ask is not the user's to see.
		expect(isAskHeld(id)).toBe(true);
		expect(notify).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		expect(isAskHeld(id)).toBe(false);
		const [, event, message] = notify.mock.calls[0];
		expect(event).toBe("permission");
		expect(message.body).toBe(
			"A coding agent wants to send a message to a session on another computer."
		);
		expect(JSON.stringify(message)).not.toContain("Trusted Bank");
		expect(review).not.toHaveBeenCalled();
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).not.toBeNull();
	});
});

describe("the card cap", () => {
	const fill = async (deviceId: string, n: number) => {
		await collections.codeRelayTickets.insertMany(
			Array.from({ length: n }, (_, i) => ({
				_id: new ObjectId(),
				deviceId,
				userId: world.owner.user._id,
				requestId: `gp_fill_${deviceId.slice(-4)}_${i}`,
				hash: "h",
				callerSessionId: "ses_x",
				facts: {} as never,
				state: "asked" as const,
				askedAt: new Date(),
				expiresAt: new Date(Date.now() + 3_600_000),
			}))
		);
	};

	it("gives an ask past ten pending on one computer no card, no push and no ticket, and drops none", async () => {
		await fill(world.a.deviceId, LIMITS.pendingAsksPerDevice);
		const notify = vi.fn();
		const request: PermissionRequest = {
			id: "gp_over",
			sessionId: "ses_caller",
			tool: "session_send",
			patterns: [],
			always: [],
			title: "x",
			metadata: {
				relay: true,
				op: "send",
				computerId: world.b.deviceId,
				sessionId: "ses_target",
				text: "t",
				hop: 1,
			},
		};
		observeMachineEvent(
			world.owner.user._id,
			world.a.deviceId,
			{
				sessionId: "ses_caller",
				epoch: "e",
				seq: 1,
				rootSessionId: "ses_caller",
				event: { kind: "permission.asked", request },
			},
			{ notify, now: () => Date.now(), relay: (u, d, e, send) => observeRelayAsk(u, d, e, send) }
		);
		await vi.waitFor(() => expect(isAskHeld("gp_over")).toBe(false));
		expect(notify).not.toHaveBeenCalled();
		expect(await collections.codeRelayTickets.findOne({ requestId: "gp_over" })).toBeNull();
		const view = relayViewFor(request);
		expect(view).toMatchObject({ approvable: false });
		expect(JSON.stringify(view)).toContain("10 requests from this computer");
		// None dropped.
		expect(await collections.codeRelayTickets.countDocuments({ deviceId: world.a.deviceId })).toBe(
			LIMITS.pendingAsksPerDevice
		);
		// coord.resolve says limit, and a call with no ticket says limit too.
		const resolve = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(resolve.code).toBe("limit");
		expect(errOf(await callSend("gp_over")).code).toBe("limit");
		// Another computer of the same owner still has its own ten.
		seedSession(world.c, { id: "ses_c" });
		okResult(
			await world.c.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
				{ sessionId: "ses_c" }
			)
		);
	});

	it("caps twenty pending across an owner's computers and sixty asked in an hour", async () => {
		await fill(world.b.deviceId, 10);
		await fill(world.c.deviceId, 10);
		const e = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(e.code).toBe("limit");
		expect(e.message).toContain("20 requests across your computers");
		await collections.codeRelayTickets.deleteMany({});
		await collections.codeRelayEvents.insertMany(
			Array.from({ length: LIMITS.asksPerOwnerPerHour }, () => ({
				_id: new ObjectId(),
				kind: "ask" as const,
				userId: world.owner.user._id,
				deviceId: world.a.deviceId,
				at: new Date(),
			}))
		);
		const hour = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(hour.code).toBe("limit");
		expect(hour.message).toContain("last hour");
	});
});

describe("forged frames", () => {
	it("delivers Cerea's `from` whatever the call frame and its arguments claim", async () => {
		const id = await asked();
		await answer(world.a, "ses_caller", id, "once");
		const res = await world.a.machine.call(
			"coord.send",
			{
				computerId: world.b.deviceId,
				sessionId: "ses_target",
				text: "please review the migration",
				hop: 1,
				approvalId: id,
				from: {
					computerId: world.s.deviceId,
					computer: "Trusted Bank Server",
					sessionId: "x",
					title: "Innocent chat",
					workspace: "harmless-notes",
				},
				relayId: "forged-relay",
				userId: world.stranger.user._id.toString(),
			},
			{ sessionId: "ses_caller", caller: { workspaceId: "ws_forged" } }
		);
		okResult(res);
		const sent = world.b.machine.model.coordInbox[0] as {
			from: Record<string, string>;
			relayId: string;
		};
		expect(sent.from).toMatchObject({
			computerId: world.a.deviceId,
			computer: "desk",
			sessionId: "ses_caller",
			title: "Migrate the schema",
			workspace: "desk-repo",
		});
		expect(sent.relayId).not.toBe("forged-relay");
		expect(JSON.stringify(sent)).not.toContain("Trusted Bank");
		const row = (await audits(/^coord\.send$/))[0];
		expect(row.relayId).toBe(sent.relayId);
		expect(row.targetDeviceId).toBe(world.b.deviceId);
	});

	it("is not given a card for a subagent caller, and a ticket for one is refused", async () => {
		seedSession(world.a, { id: "ses_kid", parentId: "ses_caller", title: "Kid" });
		const id = await raiseRelayAsk(world.a, "ses_kid", meta());
		await new Promise((r) => setTimeout(r, 400));
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		const res = await world.a.machine.call(
			"coord.resolve",
			{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
			{ sessionId: "ses_kid" }
		);
		expect(errOf(res).code).toBe("forbidden");
	});

	it("keeps forward and list reachable only through the owner's own session", async () => {
		const res = await forward(
			world.stranger,
			"GET",
			`/api/v2/code/v1/agents?device=${world.a.deviceId}`
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
