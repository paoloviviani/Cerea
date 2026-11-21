/**
 * Relayed coordination, Cerea's half (ADR 0121): the `coord.*` machine calls, with the real
 * machine link, the real HTTP reply route and real Mongo; only the galopins are fakes. Every
 * negative assertion is paired with a positive one on the same data, so none passes for an
 * unrelated reason, and each security rule has a test that fails without its guard.
 */
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import {
	answer,
	errOf,
	forward,
	okResult,
	raiseRelayAsk,
	seedSession,
	startWorld,
	waitForTicket,
	type Mach,
	type RelayMeta,
	type World,
} from "./relay/testWorld";
import { setChatReplicasForTests } from "./relay/facts";
import { LIMITS } from "./relay/limits";
import { resetRelayViews } from "./relay/views";
import { sweepExpiredTickets } from "./relay/tickets";

const flags = vi.hoisted(() => ({ deployment: true }));
vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeRelayedCoordinationEnabled: () => flags.deployment,
}));

let world: World;
let callerSession: string;
let targetSession: string;
let sends: Array<Record<string, unknown>>;
let reads: Array<Record<string, unknown>>;
let spawns: Array<Record<string, unknown>>;

beforeAll(async () => {
	await ready;
}, 30_000);

beforeEach(async () => {
	flags.deployment = true;
	world = await startWorld();
	callerSession = seedSession(world.a, { id: "ses_caller", title: "Migrate the schema" }).id;
	targetSession = seedSession(world.b, { id: "ses_target", title: "Docs" }).id;
	sends = [];
	reads = [];
	spawns = [];
	world.b.machine.onOp("coord.send", (args: Record<string, unknown>) => {
		sends.push(args);
		return {};
	});
	world.b.machine.onOp("coord.read", (args: Record<string, unknown>) => {
		reads.push(args);
		return { text: "[Content of a session]\nhello", truncated: false };
	});
	world.b.machine.onOp("coord.spawn", (args: Record<string, unknown>) => {
		spawns.push(args);
		return { sessionId: "ses_new", title: "[from desk] t", workspace: "laptop-repo" };
	});
});

afterEach(async () => {
	setChatReplicasForTests(undefined);
	await world.stop();
});

afterAll(() => {
	resetRelayViews();
});

/** The target's session in the fake machine's model, for a test to change under a card. */
function targetOnB() {
	const found = world.b.machine.model.sessions.find((s) => s.id === "ses_target");
	if (!found) throw new Error("the target session is not seeded");
	return found;
}

const sendMeta = (over: Partial<RelayMeta> = {}): RelayMeta => ({
	op: "send",
	computerId: "",
	sessionId: "ses_target",
	text: "please review the migration",
	hop: 1,
	...over,
});

/** Raise the card on the caller, wait for Cerea's record, answer once through the real route. */
async function approved(meta: RelayMeta, from: Mach = world.a, session = "ses_caller") {
	const full: RelayMeta = { ...meta, computerId: meta.computerId || world.b.deviceId };
	const id = await raiseRelayAsk(from, session, full);
	await waitForTicket(from.deviceId, id);
	const res = await answer(from, session, id, "once");
	expect(res.status).toBe(200);
	return id;
}

const callSend = (approvalId: string, over: Record<string, unknown> = {}, from: Mach = world.a) =>
	from.machine.call(
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

const audits = (action?: RegExp) =>
	collections.codeAudit
		.find({ ...(action ? { action: { $regex: action } } : {}) })
		.sort({ at: 1 })
		.toArray();

describe("the happy path", () => {
	it("delivers an approved send once, from Cerea's own labels, and audits it without content", async () => {
		const id = await approved(sendMeta());
		const res = await callSend(id);
		okResult(res);
		expect(sends).toHaveLength(1);
		const delivered = sends[0] as {
			sessionId: string;
			text: string;
			hop: number;
			relayId: string;
			from: Record<string, string>;
		};
		expect(delivered).toMatchObject({
			sessionId: "ses_target",
			text: "please review the migration",
			hop: 1,
		});
		// `from` is Cerea's: device name, the caller session's own title, the workspace's name.
		expect(delivered.from).toMatchObject({
			computerId: world.a.deviceId,
			computer: "desk",
			sessionId: "ses_caller",
			title: "Migrate the schema",
			workspace: "desk-repo",
		});
		const rows = await audits(/^coord\./);
		const sendRow = rows.find((r) => r.action === "coord.send");
		expect(sendRow).toMatchObject({
			outcome: "ok",
			origin: "agent",
			sessionId: "ses_caller",
			targetDeviceId: world.b.deviceId,
			targetSessionId: "ses_target",
			hop: 1,
			relayId: delivered.relayId,
		});
		expect(sendRow?.deviceId?.toHexString()).toBe(world.a.deviceId);
		const approval = rows.find((r) => r.action === "coord.approval");
		expect(approval).toMatchObject({
			outcome: "approved",
			approvalId: id,
			sessionId: "ses_caller",
		});
		// No content: not the text, not a title, not a name.
		const text = JSON.stringify(rows);
		expect(text).not.toContain("please review");
		expect(text).not.toContain("Migrate the schema");
		expect(text).not.toContain("Docs");
		expect(text).not.toContain("laptop-repo");
	});

	it("reads and spawns, each with its own ticket, and the target sees Cerea's `from`", async () => {
		const rid = await approved({ op: "read", sessionId: "ses_target", last: 5 });
		const read = okResult<{ text: string }>(
			await world.a.machine.call(
				"coord.read",
				{ computerId: world.b.deviceId, sessionId: "ses_target", last: 5, hop: 1, approvalId: rid },
				{ sessionId: "ses_caller" }
			)
		);
		expect(read.text).toContain("hello");
		expect(reads[0]).toMatchObject({ sessionId: "ses_target", last: 5, computer: "laptop" });

		const sid = await approved({
			op: "spawn",
			workspaceId: "ws_laptop",
			prompt: "write the changelog",
			title: "Changelog",
			mode: "build",
		});
		const spawned = okResult<{ sessionId: string; computer: string }>(
			await world.a.machine.call(
				"coord.spawn",
				{
					computerId: world.b.deviceId,
					workspaceId: "ws_laptop",
					prompt: "write the changelog",
					title: "Changelog",
					mode: "build",
					hop: 1,
					approvalId: sid,
				},
				{ sessionId: "ses_caller" }
			)
		);
		expect(spawned).toMatchObject({ sessionId: "ses_new", computer: "laptop" });
		expect(spawns[0]).toMatchObject({ workspaceId: "ws_laptop", mode: "build", hop: 1 });
		expect((spawns[0] as { from: { computer: string } }).from.computer).toBe("desk");
	});
});

describe("the same owner, on every call", () => {
	it("gives another owner's, an unpaired, a revoked and an unknown computer the same refusal", async () => {
		const pending = await world.connect(world.owner, "pending-box", { unpaired: true });
		const revoked = await world.connect(world.owner, "revoked-box");
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(revoked.deviceId) },
			{ $set: { status: "revoked" } }
		);
		const targets = [
			world.s.deviceId, // another owner's, online and capable
			pending.deviceId,
			revoked.deviceId,
			new ObjectId().toHexString(),
			"not-an-id",
			"",
		];
		for (const op of ["resolve", "read", "send", "spawn"]) {
			for (const computerId of targets) {
				const res = await world.a.machine.call(
					`coord.${op}`,
					{
						computerId,
						op: "send",
						sessionId: "ses_target",
						workspaceId: "ws_x",
						text: "t",
						prompt: "p",
						title: "t",
						mode: "build",
						last: 3,
						hop: 1,
						approvalId: "gp_none",
					},
					{ sessionId: "ses_caller" }
				);
				const e = errOf(res);
				expect([e.code, e.message], `${op} -> ${computerId}`).toEqual([
					"forbidden",
					"No such computer.",
				]);
			}
		}
		// ...and the same call to the owner's own other computer is not that refusal.
		const ok = await world.a.machine.call(
			"coord.resolve",
			{
				computerId: world.b.deviceId,
				op: "send",
				sessionId: "ses_target",
			},
			{ sessionId: "ses_caller" }
		);
		okResult(ok);
		// Nothing reached the stranger's machine.
		expect(world.s.machine.opLog.filter((o) => o.op.startsWith("coord."))).toEqual([]);
	});

	it("ignores an owner id in the arguments", async () => {
		const res = await world.a.machine.call(
			"coord.resolve",
			{
				computerId: world.s.deviceId,
				op: "send",
				sessionId: "ses_target",
				userId: world.stranger.user._id.toString(),
				owner: world.stranger.user._id.toString(),
			},
			{ sessionId: "ses_caller" }
		);
		expect(errOf(res).message).toBe("No such computer.");
	});

	it("refuses a call from a computer that is not paired", async () => {
		const pending = await world.connect(world.owner, "pending-caller", { unpaired: true });
		seedSession(pending, { id: "ses_p" });
		const res = await pending.machine.call("coord.list", {}, { sessionId: "ses_p" });
		expect(errOf(res).code).toBe("forbidden");
	});

	it("refuses a computer addressing itself", async () => {
		const res = await world.a.machine.call(
			"coord.resolve",
			{
				computerId: world.a.deviceId,
				op: "send",
				sessionId: "ses_caller",
			},
			{ sessionId: "ses_caller" }
		);
		expect(errOf(res).code).toBe("invalid");
	});

	it("lists only the owner's other computers", async () => {
		seedSession(world.c, { id: "ses_c1", title: "Garage work" });
		world.b.machine.onOp("coord.list", () => ({
			sessions: [
				{
					sessionId: "ses_target",
					title: "Docs",
					workspaceId: "ws_laptop",
					workspace: "laptop-repo",
					mode: "build",
					permissionMode: "ask",
					status: "idle",
				},
			],
			workspaces: [{ id: "ws_laptop", name: "laptop-repo" }],
		}));
		world.c.machine.onOp("coord.list", () => ({
			sessions: [
				{
					sessionId: "ses_c1",
					title: "Garage work",
					workspaceId: "ws_garage",
					workspace: "garage-repo",
					mode: "build",
					permissionMode: "ask",
					status: "idle",
				},
			],
		}));
		const list = okResult<{
			computers: Array<{
				id: string;
				name: string;
				online: boolean;
				relay: boolean;
				self: boolean;
				workspaces?: unknown[];
			}>;
			sessions: Array<{ computerId: string; title: string }>;
		}>(await world.a.machine.call("coord.list", { workspaces: true }, { sessionId: "ses_caller" }));
		expect(list.computers.map((c) => c.name).sort()).toEqual(["garage", "laptop"]);
		expect(list.computers.every((c) => c.relay && c.online && !c.self)).toBe(true);
		expect(list.sessions.map((s) => s.title).sort()).toEqual(["Docs", "Garage work"]);
		expect(list.computers.find((c) => c.name === "laptop")?.workspaces).toEqual([
			{ id: "ws_laptop", name: "laptop-repo" },
		]);
		// The stranger's computer is nowhere in it, and was never asked.
		expect(JSON.stringify(list)).not.toContain(world.s.deviceId);
		expect(world.s.machine.opLog.filter((o) => o.op.startsWith("coord."))).toEqual([]);
		expect((await audits(/^coord\.list$/))[0]).toMatchObject({ outcome: "ok" });
	});

	it("leaves out a slow computer with a note, not an error", async () => {
		world.b.machine.onOp("coord.list", () => new Promise(() => undefined));
		world.c.machine.onOp("coord.list", () => ({ sessions: [] }));
		vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
		try {
			const pending = world.a.machine.call(
				"coord.list",
				{},
				{ sessionId: "ses_caller", timeoutMs: 20_000 }
			);
			await vi.advanceTimersByTimeAsync(5_500);
			const list = okResult<{ note?: string; computers: Array<{ name: string; relay: boolean }> }>(
				await pending
			);
			expect(list.note).toContain("laptop did not answer in time");
			expect(list.computers.find((c) => c.name === "laptop")?.relay).toBe(false);
			expect(list.computers.find((c) => c.name === "garage")?.relay).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the switches", () => {
	it("refuses every op while the user's switch is off, and works again when it is on", async () => {
		const id = await approved(sendMeta());
		await collections.settings.updateOne(
			{ userId: world.owner.user._id },
			{ $set: { relayedCoordinationEnabled: false } },
			{ upsert: true }
		);
		for (const op of ["list", "resolve", "read", "send", "spawn"]) {
			const res = await world.a.machine.call(
				`coord.${op}`,
				{
					computerId: world.b.deviceId,
					op: "send",
					sessionId: "ses_target",
					text: "t",
					hop: 1,
					approvalId: id,
				},
				{ sessionId: "ses_caller" }
			);
			expect(errOf(res)).toEqual({
				code: "forbidden",
				message: "Relayed coordination is switched off in the user's Cerea settings.",
			});
		}
		expect(sends).toHaveLength(0);
		expect((await audits(/refused/)).map((r) => r.outcome)).toContain("switch_off");
		// On again: the ticket was not spent by the refusals above.
		await collections.settings.updateOne(
			{ userId: world.owner.user._id },
			{ $set: { relayedCoordinationEnabled: true } }
		);
		okResult(await callSend(id));
		expect(sends).toHaveLength(1);
	});

	it("refuses while the deployment's switch is off, whatever the user's says", async () => {
		const id = await approved(sendMeta());
		flags.deployment = false;
		const e = errOf(await callSend(id));
		expect(e.message).toContain("switched off");
		const l = errOf(await world.a.machine.call("coord.list", {}, { sessionId: "ses_caller" }));
		expect(l.code).toBe("forbidden");
		expect(sends).toHaveLength(0);
		flags.deployment = true;
		okResult(await callSend(id));
	});
});

describe("the approval ticket", () => {
	it("refuses a call with no ticket, a made-up one, and one answered on the machine itself", async () => {
		const none = errOf(await callSend("gp_never_asked"));
		expect(none.code).toBe("forbidden");
		expect(none.message).toContain("none was recorded");
		// A card that is shown but never answered in Cerea: the machine's own answer never mints.
		const id = await raiseRelayAsk(world.a, "ses_caller", {
			...sendMeta(),
			computerId: world.b.deviceId,
		});
		await waitForTicket(world.a.deviceId, id);
		const unanswered = errOf(await callSend(id));
		expect(unanswered.message).toContain("Answer the card in Cerea");
		expect(sends).toHaveLength(0);
		expect((await audits(/refused/)).filter((r) => r.outcome === "no_ticket")).toHaveLength(2);
		// ...and the same ticket, once answered in Cerea, works.
		await answer(world.a, "ses_caller", id, "once");
		okResult(await callSend(id));
	});

	it("serves a ticket once", async () => {
		const id = await approved(sendMeta());
		okResult(await callSend(id));
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
		expect(sends).toHaveLength(1);
	});

	it("serves a ticket once under two concurrent calls", async () => {
		const id = await approved(sendMeta());
		const [x, y] = await Promise.all([callSend(id), callSend(id)]);
		expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
		expect(sends).toHaveLength(1);
	});

	it("refuses a ticket of another computer", async () => {
		// The same card id on two computers: C's approved ticket is not A's.
		seedSession(world.c, { id: "ses_caller" });
		const id = await approved(sendMeta(), world.c);
		const e = errOf(await callSend(id));
		expect(e.message).toContain("none was recorded");
		expect(sends).toHaveLength(0);
		// C's own ticket is intact.
		okResult(
			await world.c.machine.call(
				"coord.send",
				{
					computerId: world.b.deviceId,
					sessionId: "ses_target",
					text: "please review the migration",
					hop: 1,
					approvalId: id,
				},
				{ sessionId: "ses_caller" }
			)
		);
	});

	it("audits a hash mismatch as its own outcome, for every covered field", async () => {
		const cases: Array<[string, Record<string, unknown>, RelayMeta?]> = [
			["text", { text: "something else" }],
			["session", { sessionId: "ses_other" }],
			["hop", { hop: 2 }],
			["computer", { computerId: world.c.deviceId }],
		];
		seedSession(world.b, { id: "ses_other", title: "Other" });
		for (const [field, over] of cases) {
			const id = await approved(sendMeta());
			const e = errOf(await callSend(id, over));
			expect(e.code, field).toBe("forbidden");
			expect(e.message, field).toContain("What was approved is not what was sent");
		}
		expect((await audits(/refused/)).filter((r) => r.outcome === "ticket_mismatch")).toHaveLength(
			cases.length
		);
		expect(sends).toHaveLength(0);
	});

	it("binds a ticket to the caller's session", async () => {
		seedSession(world.a, { id: "ses_other_caller", title: "Another" });
		const id = await approved(sendMeta());
		const res = await world.a.machine.call(
			"coord.send",
			{
				computerId: world.b.deviceId,
				sessionId: "ses_target",
				text: "please review the migration",
				hop: 1,
				approvalId: id,
			},
			{ sessionId: "ses_other_caller" }
		);
		expect(errOf(res).message).toContain("What was approved is not what was sent");
		expect((await audits(/refused/)).map((r) => r.outcome)).toContain("ticket_mismatch");
		// The ticket was spent by the attempt: it cannot be used from the right session now.
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
	});

	it("refuses an expired ticket and audits the expiry", async () => {
		const id = await approved(sendMeta());
		await collections.codeRelayTickets.updateOne(
			{ deviceId: world.a.deviceId, requestId: id },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
		expect(sends).toHaveLength(0);
		expect((await audits(/^coord\.approval$/)).map((r) => r.outcome)).toContain("expired");
	});

	it("sweeps expired tickets and audits each once", async () => {
		const id = await raiseRelayAsk(world.a, "ses_caller", {
			...sendMeta(),
			computerId: world.b.deviceId,
		});
		await waitForTicket(world.a.deviceId, id);
		await collections.codeRelayTickets.updateOne(
			{ requestId: id },
			{ $set: { expiresAt: new Date(Date.now() - 1) } }
		);
		expect(await sweepExpiredTickets()).toBe(1);
		expect(await sweepExpiredTickets()).toBe(0);
		expect((await audits(/^coord\.approval$/)).filter((r) => r.outcome === "expired")).toHaveLength(
			1
		);
	});

	it("turns 'always' into once and stores nothing for a relay card", async () => {
		const id = await raiseRelayAsk(world.a, "ses_caller", {
			...sendMeta(),
			computerId: world.b.deviceId,
		});
		await waitForTicket(world.a.deviceId, id);
		const replies: Array<{ decision: string }> = [];
		world.a.machine.onOp("permission.reply", (args: { decision: string }) => {
			replies.push(args);
			return {};
		});
		expect((await answer(world.a, "ses_caller", id, "always")).status).toBe(200);
		expect(replies.map((r) => r.decision)).toEqual(["once"]);
		okResult(await callSend(id));
	});

	it("deletes the ticket on a reject, and the call then has none", async () => {
		const id = await raiseRelayAsk(world.a, "ses_caller", {
			...sendMeta(),
			computerId: world.b.deviceId,
		});
		await waitForTicket(world.a.deviceId, id);
		expect((await answer(world.a, "ses_caller", id, "reject")).status).toBe(200);
		expect(await collections.codeRelayTickets.findOne({ requestId: id })).toBeNull();
		expect(errOf(await callSend(id)).message).toContain("none was recorded");
		expect((await audits(/^coord\.approval$/)).map((r) => r.outcome)).toContain("rejected");
	});

	it("survives a Cerea restart between the answer and the call", async () => {
		const id = await approved(sendMeta());
		// A restart forgets everything in process memory; the ticket is in Mongo.
		resetRelayViews();
		okResult(await callSend(id));
		expect(sends).toHaveLength(1);
	});

	it("re-checks the target live: a subagent, a looser word and an unknown session are refused", async () => {
		// The target became looser after the card showed it on Ask.
		const looser = await approved(sendMeta());
		targetOnB().permissionMode = "allow";
		const e = errOf(await callSend(looser));
		expect(e.message).toContain("loosened");
		expect(sends).toHaveLength(0);
		// A more cautious word since the card is fine.
		targetOnB().permissionMode = "ask";
		const same = await approved(sendMeta());
		targetOnB().permissionMode = "deny";
		okResult(await callSend(same));
		// It became a subagent of another session.
		targetOnB().permissionMode = "ask";
		const kid = await approved(sendMeta());
		targetOnB().parentId = "ses_somebody";
		expect(errOf(await callSend(kid)).code).toBe("not_found");
		// It no longer exists.
		targetOnB().parentId = null;
		const gone = await approved(sendMeta());
		world.b.machine.model.sessions = world.b.machine.model.sessions.filter(
			(s) => s.id !== "ses_target"
		);
		expect(errOf(await callSend(gone)).code).toBe("not_found");
		expect(sends).toHaveLength(1);
	});
});

describe("limits", () => {
	it("refuses a text over 8 KiB, a blank one, and a hop outside 1 to 3, before the ticket", async () => {
		const id = await approved(sendMeta());
		expect(errOf(await callSend(id, { text: "x".repeat(8193) })).code).toBe("invalid");
		expect(errOf(await callSend(id, { text: "   " })).code).toBe("invalid");
		expect(errOf(await callSend(id, { hop: 0 })).code).toBe("invalid");
		expect(errOf(await callSend(id, { hop: 4 })).code).toBe("invalid");
		// None of those spent the ticket.
		okResult(await callSend(id));
		// Exactly 8 KiB is fine.
		const big = "é".repeat(4096);
		const bigId = await approved(sendMeta({ text: big }));
		okResult(await callSend(bigId, { text: big }));
	});

	it("limits a computer to 30 requests a minute, and an owner to 120 reads and sends an hour", async () => {
		const now = new Date();
		await collections.codeRelayEvents.insertMany(
			Array.from({ length: LIMITS.perComputerPerMinute }, () => ({
				_id: new ObjectId(),
				kind: "call" as const,
				op: "send",
				userId: world.owner.user._id,
				deviceId: world.a.deviceId,
				at: now,
			}))
		);
		const id = await approved(sendMeta());
		const e = errOf(await callSend(id));
		expect(e.code).toBe("limit");
		expect(e.message).toContain("30");
		// Another computer of the owner has its own minute.
		await collections.codeRelayEvents.deleteMany({});
		const old = new Date(Date.now() - 10 * 60_000);
		await collections.codeRelayEvents.insertMany(
			Array.from({ length: LIMITS.perOwnerCallsPerHour }, () => ({
				_id: new ObjectId(),
				kind: "call" as const,
				op: "read",
				userId: world.owner.user._id,
				deviceId: world.c.deviceId,
				at: old,
			}))
		);
		const owner = errOf(await callSend(id));
		expect(owner.code).toBe("limit");
		expect(owner.message).toContain("120");
		// A spawn has its own hourly budget.
		await collections.codeRelayEvents.deleteMany({});
		await collections.codeRelayEvents.insertMany(
			Array.from({ length: LIMITS.perOwnerSpawnsPerHour }, () => ({
				_id: new ObjectId(),
				kind: "call" as const,
				op: "spawn",
				userId: world.owner.user._id,
				deviceId: world.c.deviceId,
				at: old,
			}))
		);
		const spawnId = await approved({
			op: "spawn",
			workspaceId: "ws_laptop",
			prompt: "p",
			title: "t",
			mode: "build",
		});
		const spawn = errOf(
			await world.a.machine.call(
				"coord.spawn",
				{
					computerId: world.b.deviceId,
					workspaceId: "ws_laptop",
					prompt: "p",
					title: "t",
					mode: "build",
					hop: 1,
					approvalId: spawnId,
				},
				{ sessionId: "ses_caller" }
			)
		);
		expect(spawn.code).toBe("limit");
		// ...while a send is still fine for the same owner.
		okResult(await callSend(id));
	});

	it("limits coord.list to 10 a minute per computer", async () => {
		world.b.machine.onOp("coord.list", () => ({ sessions: [] }));
		world.c.machine.onOp("coord.list", () => ({ sessions: [] }));
		for (let i = 0; i < LIMITS.listPerMinute; i++) {
			okResult(await world.a.machine.call("coord.list", {}, { sessionId: "ses_caller" }));
		}
		expect(
			errOf(await world.a.machine.call("coord.list", {}, { sessionId: "ses_caller" })).code
		).toBe("limit");
		okResult(await world.c.machine.call("coord.list", {}, { sessionId: "ses_c" }));
	});
});

describe("the target", () => {
	it("says offline, older, vetoed and unknown plainly, and queues nothing", async () => {
		const id = await approved(sendMeta());
		world.b.machine.close();
		await new Promise((r) => setTimeout(r, 300));
		const offline = errOf(await callSend(id));
		expect(offline).toEqual({
			code: "unavailable",
			message: "laptop is offline; nothing was sent.",
		});
		// It comes back: nothing was queued, nothing is delivered.
		expect(sends).toHaveLength(0);
		const back = await world.connect(world.owner, "laptop2");
		await new Promise((r) => setTimeout(r, 200));
		expect(back.machine.opLog.filter((o) => o.op.startsWith("coord."))).toEqual([]);
	});

	it("refuses a target that runs an older galopin, and one whose owner vetoed it", async () => {
		const older = await world.connect(world.owner, "oldbox", { relay: false });
		const e1 = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: older.deviceId, op: "send", sessionId: "x" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(e1.code).toBe("unsupported");
		expect(e1.message).toContain("older galopin");
		const vetoed = await world.connect(world.owner, "vetobox", {
			policy: { relayedCoordination: "denied" },
		});
		const e2 = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: vetoed.deviceId, op: "send", sessionId: "x" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(e2.code).toBe("unsupported");
		expect(e2.message).toContain("turned relayed coordination off");
		const noTools = await world.connect(world.owner, "notools", {
			policy: { agentTools: "denied" },
		});
		expect(
			errOf(
				await world.a.machine.call(
					"coord.resolve",
					{ computerId: noTools.deviceId, op: "send", sessionId: "x" },
					{ sessionId: "ses_caller" }
				)
			).code
		).toBe("unsupported");
		// The list shows them as computers that cannot take requests, not as sessions.
		world.b.machine.onOp("coord.list", () => ({ sessions: [] }));
		world.c.machine.onOp("coord.list", () => ({ sessions: [] }));
		const list = okResult<{ computers: Array<{ name: string; relay: boolean }> }>(
			await world.a.machine.call("coord.list", {}, { sessionId: "ses_caller" })
		);
		expect(list.computers.find((c) => c.name === "oldbox")?.relay).toBe(false);
		expect(list.computers.find((c) => c.name === "vetobox")?.relay).toBe(false);
		expect(list.computers.find((c) => c.name === "laptop")?.relay).toBe(true);
	});

	it("says unknown session and subagent as 'no such session'", async () => {
		const unknown = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_nope" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(unknown).toEqual({ code: "not_found", message: "No such session on laptop." });
		seedSession(world.b, { id: "ses_kid", parentId: "ses_target" });
		const kid = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_kid" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(kid).toEqual({ code: "not_found", message: "No such session on laptop." });
		const ws = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "spawn", workspaceId: "ws_nope" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(ws.code).toBe("not_found");
	});

	it("says 'unreachable from this server' when several replicas are configured", async () => {
		world.b.machine.close();
		await new Promise((r) => setTimeout(r, 300));
		setChatReplicasForTests(2);
		const e = errOf(
			await world.a.machine.call(
				"coord.resolve",
				{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
				{ sessionId: "ses_caller" }
			)
		);
		expect(e.code).toBe("unavailable");
		expect(e.message).toContain("unreachable from this server");
		setChatReplicasForTests(undefined);
		expect(
			errOf(
				await world.a.machine.call(
					"coord.resolve",
					{ computerId: world.b.deviceId, op: "send", sessionId: "ses_target" },
					{ sessionId: "ses_caller" }
				)
			).message
		).toContain("offline");
	});

	it("passes the target's own refusal on in words, and a timed-out send says it may have arrived", async () => {
		world.b.machine.onOp("coord.send", () => {
			throw Object.assign(
				new Error("rate limit: at most 5 relayed requests per minute from the same session"),
				{ code: "invalid" }
			);
		});
		const id = await approved(sendMeta());
		const e = errOf(await callSend(id));
		expect(e.code).toBe("invalid");
		expect(e.message).toContain("rate limit");
	});
});

describe("the hop and depth ledger", () => {
	it("counts hops from its own ledger: a chain of four is refused at the fourth", async () => {
		// desk:s1 -> laptop:t1 (hop 1) -> garage:g1 (hop 2) -> laptop:t2 (hop 3) -> desk:s2 (hop 4: refused)
		seedSession(world.b, { id: "t1" });
		seedSession(world.c, { id: "g1" });
		seedSession(world.b, { id: "t2" });
		seedSession(world.a, { id: "s2" });
		seedSession(world.a, { id: "s1" });
		const hop = async (m: Mach, from: string, to: Mach, target: string, claimed = 1) => {
			const meta: RelayMeta = {
				op: "send",
				computerId: to.deviceId,
				sessionId: target,
				text: "t",
				hop: claimed,
			};
			const id = await raiseRelayAsk(m, from, meta);
			await waitForTicket(m.deviceId, id);
			await answer(m, from, id, "once");
			return m.machine.call(
				"coord.send",
				{ computerId: to.deviceId, sessionId: target, text: "t", hop: claimed, approvalId: id },
				{ sessionId: from }
			);
		};
		okResult(await hop(world.a, "s1", world.b, "t1"));
		// The sender claims hop 1 again: Cerea's ledger says t1 was reached at hop 1, so this is 2.
		okResult(await hop(world.b, "t1", world.c, "g1"));
		okResult(await hop(world.c, "g1", world.b, "t2"));
		const seen = world.b.machine.opLog
			.filter((o) => o.op === "coord.send")
			.map((o) => (o.args as { hop: number }).hop);
		expect(seen).toEqual([1, 3]);
		const fourth = errOf(await hop(world.b, "t2", world.a, "s2"));
		expect(fourth.code).toBe("limit");
		expect(fourth.message).toContain("at most 3 times");
	});

	it("does not reset on a lying hop, a local spawn or a message the owner types", async () => {
		seedSession(world.b, { id: "t1" });
		seedSession(world.c, { id: "g1" });
		seedSession(world.a, { id: "s1" });
		const reach = async (m: Mach, from: string, to: Mach, target: string, claimed: number) => {
			const id = await raiseRelayAsk(m, from, {
				op: "send",
				computerId: to.deviceId,
				sessionId: target,
				text: "t",
				hop: claimed,
			});
			await waitForTicket(m.deviceId, id);
			await answer(m, from, id, "once");
			return m.machine.call(
				"coord.send",
				{ computerId: to.deviceId, sessionId: target, text: "t", hop: claimed, approvalId: id },
				{ sessionId: from }
			);
		};
		okResult(await reach(world.a, "s1", world.b, "t1", 1));
		okResult(await reach(world.b, "t1", world.c, "g1", 1));
		const ledger = (device: string, session: string) =>
			collections.codeRelayLedger.findOne({ _id: `${device}:${session}` });
		expect((await ledger(world.c.deviceId, "g1"))?.hop).toBe(2);

		// The owner types into g1, and g1 spawns a local session: neither touches its row.
		const typed = await forward(
			world.owner,
			"POST",
			`/api/v2/code/v1/agents/g1/messages?device=${world.c.deviceId}`,
			{ text: "carry on" }
		);
		expect(typed.status).toBe(200);
		const spawned = await forward(
			world.owner,
			"POST",
			`/api/v2/code/v1/agents?device=${world.c.deviceId}`,
			{ workspaceId: world.c.machine.model.workspaces[0].id, provider: "opencode", posture: "plan" }
		);
		expect(spawned.status).toBe(200);
		expect((await ledger(world.c.deviceId, "g1"))?.hop).toBe(2);

		// g1 claims hop 1 for its next send, as if the chain had begun there: Cerea says 3.
		seedSession(world.b, { id: "t9" });
		okResult(await reach(world.c, "g1", world.b, "t9", 1));
		expect((await ledger(world.b.deviceId, "t9"))?.hop).toBe(3);
		const delivered = world.b.machine.opLog
			.filter((o) => o.op === "coord.send")
			.map((o) => (o.args as { hop: number }).hop);
		expect(delivered).toEqual([1, 3]);
	});

	it("refuses a spawn past the depth limit across computers", async () => {
		const spawnFrom = async (m: Mach, session: string, to: Mach) => {
			const meta: RelayMeta = {
				op: "spawn",
				computerId: to.deviceId,
				workspaceId: to.machine.model.workspaces[0].id,
				prompt: "p",
				title: "t",
				mode: "build",
			};
			const id = await raiseRelayAsk(m, session, meta);
			await waitForTicket(m.deviceId, id);
			await answer(m, session, id, "once");
			return m.machine.call(
				"coord.spawn",
				{
					computerId: to.deviceId,
					workspaceId: meta.workspaceId,
					prompt: "p",
					title: "t",
					mode: "build",
					hop: 1,
					approvalId: id,
				},
				{ sessionId: session }
			);
		};
		let n = 0;
		for (const m of [world.b, world.c]) {
			m.machine.onOp("coord.spawn", () => ({
				sessionId: `spawned_${m.name}_${++n}`,
				title: "t",
				workspace: "w",
			}));
		}
		// desk:ses_caller (depth 0) -> laptop spawned_1 (depth 1) -> garage spawned_2 (depth 2) -> refused.
		const first = okResult<{ sessionId: string }>(await spawnFrom(world.a, "ses_caller", world.b));
		seedSession(world.b, { id: first.sessionId });
		expect(
			(await collections.codeRelayLedger.findOne({ _id: `${world.b.deviceId}:${first.sessionId}` }))
				?.depth
		).toBe(1);
		const second = okResult<{ sessionId: string }>(
			await spawnFrom(world.b, first.sessionId, world.c)
		);
		seedSession(world.c, { id: second.sessionId });
		expect(
			(
				await collections.codeRelayLedger.findOne({
					_id: `${world.c.deviceId}:${second.sessionId}`,
				})
			)?.depth
		).toBe(2);
		const third = errOf(await spawnFrom(world.c, second.sessionId, world.a));
		expect(third.code).toBe("limit");
		expect(third.message).toContain("2 deep");
	});

	it("keeps a ledger row for 24 hours", async () => {
		const indexes = await collections.codeRelayLedger.indexes();
		expect(indexes.find((i) => i.key.at === 1)?.expireAfterSeconds).toBe(24 * 60 * 60);
		const id = await approved(sendMeta());
		okResult(await callSend(id));
		const row = await collections.codeRelayLedger.findOne({
			_id: `${world.b.deviceId}:ses_target`,
		});
		expect(row?.hop).toBe(1);
		expect(Date.now() - (row?.at.getTime() ?? 0)).toBeLessThan(5000);
		void callerSession;
		void targetSession;
	});
});
