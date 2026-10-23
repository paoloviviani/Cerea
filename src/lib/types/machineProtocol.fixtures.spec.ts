/**
 * The shared wire fixtures (`agent/protocol-fixtures`, see its README): every frame the
 * machine and Cerea exchange, as canonical JSON, checked here against the schemas and
 * helpers Cerea really uses and, on the Go side, against galopin's real structs. A frame
 * either side stops accepting, or a new op / event kind / frame type without a fixture,
 * fails this spec.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CALL_ERROR_CODES,
	CEREA_TO_MACHINE_FRAME_TYPES,
	ERROR_CODES,
	MACHINE_CALL_OPS,
	MACHINE_TO_CEREA_FRAME_TYPES,
	NORMALIZED_EVENT_KINDS,
	OP_NAMES,
	delegateProfilesBody,
	eventFrameSchema,
	machineMode,
	mcpLoginResultSchema,
	mcpOpenResultSchema,
	parseDelegateProfiles,
	parseMcpList,
	type HelloFrame,
	parseMachineFrame,
	parsePermissionRules,
	type NormalizedEvent,
	type Transcript,
} from "$lib/types/machineProtocol";
import { createArgs, updateArgs } from "$lib/server/code/machineCalls";
import {
	eventToUpdates,
	newThinkingState,
	snapshotToUpdates,
} from "$lib/server/code/machineTimeline";

type Fixture = {
	file: string;
	meta: Record<string, unknown>;
	frame: Record<string, unknown> & { type: string };
};

const ROOT = fileURLToPath(new URL("../../../agent/protocol-fixtures", import.meta.url));

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : name.endsWith(".json") ? [path] : [];
	});
}

const fixtures: Fixture[] = walk(ROOT)
	.sort()
	.map((path) => {
		const body = JSON.parse(readFileSync(path, "utf8")) as {
			_meta: Fixture["meta"];
			frame: Fixture["frame"];
		};
		return { file: relative(ROOT, path), meta: body._meta, frame: body.frame };
	});

const ofType = (type: string) => fixtures.filter((f) => f.frame.type === type);
const machineToCerea = fixtures.filter((f) => f.meta.direction === "M→C");
const ceraToMachine = fixtures.filter((f) => f.meta.direction === "C→M");

function fixtureAt(file: string): Fixture {
	const hit = fixtures.find((f) => f.file === file);
	if (!hit) throw new Error(`no fixture ${file}`);
	return hit;
}

function resultOf(op: string, variant?: string): unknown {
	const hit = fixtures.find(
		(f) =>
			f.frame.type === "res" &&
			f.frame.ok === true &&
			f.meta.op === op &&
			f.meta.variant === variant
	);
	if (!hit) throw new Error(`no res fixture for ${op} ${variant ?? ""}`);
	return hit.frame.result;
}

describe("protocol fixtures: shape of the corpus", () => {
	it("is non-empty and every file says which spec section and direction it comes from", () => {
		expect(fixtures.length).toBeGreaterThan(100);
		for (const f of fixtures) {
			expect(typeof f.meta.spec, f.file).toBe("string");
			expect(["M→C", "C→M"], f.file).toContain(f.meta.direction);
		}
	});
});

describe("protocol fixtures: null variants", () => {
	it("a fixture says _meta.null exactly when its frame carries a null", () => {
		const hasNull = (value: unknown): boolean =>
			value === null ||
			(Array.isArray(value) && value.some(hasNull)) ||
			(typeof value === "object" && value !== null && Object.values(value).some(hasNull));
		for (const f of fixtures) expect(hasNull(f.frame), f.file).toBe(f.meta.null === true);
	});

	it("includes the nulls galopin can emit: a null shell, a null session usage, a null effort", () => {
		const files = fixtures.filter((f) => f.meta.null === true).map((f) => f.file);
		expect(files).toEqual(
			expect.arrayContaining([
				"ops/backend.commands.res.null.json",
				"events/session.minimal.json",
				"ops/session.setEffort.req.null.json",
			])
		);
	});
});

describe("protocol fixtures: completeness (a new op, kind or frame without a fixture fails)", () => {
	it("every op name has a req and a res fixture, and every fixture op is a known op", () => {
		const reqOps = new Set(ofType("req").map((f) => f.frame.op as string));
		const resOps = new Set(
			ofType("res")
				.filter((f) => f.frame.ok === true)
				.map((f) => f.meta.op as string)
		);
		for (const op of OP_NAMES) {
			expect(reqOps.has(op), `req fixture for ${op}`).toBe(true);
			expect(resOps.has(op), `res fixture for ${op}`).toBe(true);
		}
		for (const op of [...reqOps, ...resOps]) {
			expect((OP_NAMES as readonly string[]).includes(op), `${op} is not in OP_NAMES`).toBe(true);
		}
	});

	it("every normalized event kind has an event fixture", () => {
		const kinds = new Set(ofType("event").map((f) => (f.frame.event as NormalizedEvent).kind));
		for (const kind of NORMALIZED_EVENT_KINDS) expect(kinds.has(kind), `event ${kind}`).toBe(true);
		for (const kind of kinds)
			expect((NORMALIZED_EVENT_KINDS as readonly string[]).includes(kind)).toBe(true);
	});

	it("every frame type in both directions has a fixture, and none is unknown", () => {
		const present = (direction: "M→C" | "C→M") =>
			new Set(fixtures.filter((f) => f.meta.direction === direction).map((f) => f.frame.type));
		for (const type of MACHINE_TO_CEREA_FRAME_TYPES)
			expect(present("M→C").has(type), type).toBe(true);
		for (const type of CEREA_TO_MACHINE_FRAME_TYPES)
			expect(present("C→M").has(type), type).toBe(true);
		for (const type of present("M→C"))
			expect(MACHINE_TO_CEREA_FRAME_TYPES as readonly string[]).toContain(type);
		for (const type of present("C→M"))
			expect(CEREA_TO_MACHINE_FRAME_TYPES as readonly string[]).toContain(type);
	});

	it("every call op has a call and a callres fixture", () => {
		const calls = new Set(ofType("call").map((f) => f.frame.op));
		const answers = new Set(
			ofType("callres")
				.filter((f) => f.frame.ok === true)
				.map((f) => f.meta.op)
		);
		for (const op of MACHINE_CALL_OPS) {
			expect(calls.has(op), `call ${op}`).toBe(true);
			expect(answers.has(op), `callres ${op}`).toBe(true);
		}
		for (const op of calls) expect(MACHINE_CALL_OPS as readonly string[]).toContain(op);
	});

	it("every error code has a res / callres error fixture, and no fixture uses another", () => {
		const resCodes = new Set(
			ofType("res").flatMap((f) =>
				f.frame.ok === false ? [(f.frame.error as { code: string }).code] : []
			)
		);
		const callCodes = new Set(
			ofType("callres").flatMap((f) =>
				f.frame.ok === false ? [(f.frame.error as { code: string }).code] : []
			)
		);
		for (const code of ERROR_CODES) expect(resCodes.has(code), `res ${code}`).toBe(true);
		for (const code of CALL_ERROR_CODES) expect(callCodes.has(code), `callres ${code}`).toBe(true);
		for (const code of resCodes) expect(ERROR_CODES as readonly string[]).toContain(code);
		for (const code of callCodes) expect(CALL_ERROR_CODES as readonly string[]).toContain(code);
	});

	it("welcome advertises exactly the call families Cerea answers", () => {
		const families = new Set(MACHINE_CALL_OPS.map((op) => op.split(".")[0]));
		const welcome = fixtureAt("frames/welcome.json");
		expect(new Set((welcome.frame.features as { machineCalls: string[] }).machineCalls)).toEqual(
			families
		);
	});
});

describe("protocol fixtures: machine to Cerea frames parse with the production schemas", () => {
	for (const f of machineToCerea) {
		it(f.file, () => {
			const parsed = parseMachineFrame(f.frame);
			expect(parsed, "parseMachineFrame dropped the frame").not.toBeNull();
			expect(parsed).toEqual(f.frame);
		});
	}
});

describe("protocol fixtures: schedule call args parse with Cerea's own schemas", () => {
	for (const f of ofType("call")) {
		const op = f.frame.op as string;
		if (op !== "schedule.create" && op !== "schedule.update") continue;
		it(f.file, () => {
			const schema = op === "schedule.create" ? createArgs : updateArgs;
			expect(schema.safeParse(f.frame.args).success).toBe(true);
		});
	}
	it("a maxOccurrences variant exists for create, update and update-clear", () => {
		const args = ofType("call").map((f) => f.frame.args as Record<string, unknown>);
		expect(args.some((a) => a.name !== undefined && typeof a.maxOccurrences === "number")).toBe(
			true
		);
		expect(args.some((a) => a.name === undefined && typeof a.maxOccurrences === "number")).toBe(
			true
		);
		expect(args.some((a) => a.maxOccurrences === null)).toBe(true);
	});
});

describe("protocol fixtures: events survive Cerea's real consumers", () => {
	for (const f of ofType("event")) {
		it(f.file, () => {
			expect(eventFrameSchema.safeParse(f.frame).success).toBe(true);
			const event = f.frame.event as NormalizedEvent;
			const child = f.frame.sessionId !== f.frame.rootSessionId;
			const updates = eventToUpdates(
				event,
				undefined,
				undefined,
				child ? { childId: String(f.frame.sessionId), childTitle: "child" } : undefined,
				undefined,
				undefined,
				String(f.frame.sessionId),
				newThinkingState()
			);
			expect(Array.isArray(updates)).toBe(true);
		});
	}

	it("a permission or question asked produces an elicitation card", () => {
		for (const name of ["permission.asked", "question.asked"]) {
			const f = fixtureAt(`events/${name}.json`);
			const updates = eventToUpdates(f.frame.event as NormalizedEvent);
			expect(updates.length, name).toBeGreaterThan(0);
		}
	});
});

describe("protocol fixtures: results Cerea reads", () => {
	it("every session.sync event batch is made of valid envelopes", () => {
		const result = resultOf("session.sync") as { events: Record<string, unknown>[] };
		for (const envelope of result.events) {
			expect(eventFrameSchema.safeParse({ type: "event", ...envelope }).success).toBe(true);
		}
	});

	for (const variant of ["snapshot", "snapshot-paged"]) {
		it(`session.sync ${variant} folds into transcript updates`, () => {
			const { snapshot } = resultOf("session.sync", variant) as { snapshot: Transcript };
			expect(snapshotToUpdates(snapshot).length).toBeGreaterThan(0);
		});
	}

	it("a snapshot whose questions are null (Go's nil slice) still folds", () => {
		const { snapshot } = resultOf("session.sync", "snapshot") as {
			snapshot: Record<string, unknown>;
		};
		const nulled = { ...snapshot, questions: null } as unknown as Transcript;
		expect(() => snapshotToUpdates(nulled)).not.toThrow();
	});

	it("permission.rules parses to every field the machine sent", () => {
		const raw = resultOf("permission.rules") as Record<string, unknown>;
		const parsed = parsePermissionRules(raw);
		expect(parsed.agent).toBe(raw.agent);
		expect(parsed.mode).toBe(raw.mode);
		expect(parsed.rules).toEqual(raw.rules);
		expect(parsed.savedApprovals).toEqual(raw.savedApprovals);
		expect(parsed.ceiling).toEqual(raw.ceiling);
		expect(parsed.coordination).toEqual(raw.coordination);
		expect(parsed.safeDirs).toEqual(raw.safeDirs);
	});

	it("delegate profiles round-trip: profiles.list parses and profiles.set sends the same body", () => {
		const list = parseDelegateProfiles(resultOf("profiles.list"));
		expect(list.profiles.map((p) => p.name)).toEqual(["deep", "fast"]);
		expect(list.default).toBe("fast");
		const req = fixtureAt("ops/profiles.set.req.json");
		expect(delegateProfilesBody(list)).toEqual(req.frame.args);
		expect(parseDelegateProfiles(resultOf("profiles.list", "empty"))).toEqual({
			default: null,
			profiles: [],
		});
	});
});

describe("protocol fixtures: Cerea to machine frames", () => {
	it("req frames carry a known op, a string id and object args", () => {
		for (const f of ofType("req")) {
			expect(typeof f.frame.id, f.file).toBe("string");
			expect(OP_NAMES as readonly string[], f.file).toContain(f.frame.op);
			expect(typeof f.frame.args, f.file).toBe("object");
			expect(f.frame.args, f.file).not.toBeNull();
		}
	});

	it("callres frames answer with a result object or a coded error", () => {
		for (const f of ofType("callres")) {
			expect(typeof f.frame.id).toBe("string");
			if (f.frame.ok === true) expect(typeof f.frame.result, f.file).toBe("object");
			else {
				const error = f.frame.error as { code: string; message: string };
				expect(CALL_ERROR_CODES as readonly string[], f.file).toContain(error.code);
				expect(typeof error.message).toBe("string");
			}
		}
	});

	it("welcome, status and their variants have the documented fields", () => {
		for (const f of ceraToMachine.filter((x) => x.frame.type === "welcome")) {
			expect(typeof f.frame.deviceId).toBe("string");
			expect(["pending", "paired"]).toContain(f.frame.status);
		}
		expect(ofType("status").every((f) => f.frame.status === "paired")).toBe(true);
	});
});

describe("protocol fixtures: local MCP connectors (§10)", () => {
	it("a connectors hello reads as a connectors machine with mcp; a hello without a mode reads as an agent", () => {
		const connectors = parseMachineFrame(
			fixtureAt("frames/hello.connectors.json").frame
		) as HelloFrame;
		expect(machineMode(connectors.machine)).toBe("connectors");
		expect(connectors.machine?.capabilities.mcp).toBe(true);
		expect(connectors.backends).toEqual([]);
		const agent = parseMachineFrame(fixtureAt("frames/hello.json").frame) as HelloFrame;
		expect(machineMode(agent.machine)).toBe("agent");
		expect(machineMode(undefined)).toBe("agent");
		expect(machineMode({ mode: null, capabilities: {} })).toBe("agent");
		// A mode a newer galopin invents is an agent machine to this Cerea, never a dropped hello.
		const future = structuredClone(connectors) as unknown as { machine: { mode: string } };
		future.machine.mode = "relay";
		const parsed = parseMachineFrame(future) as HelloFrame;
		expect(parsed).not.toBeNull();
		expect(machineMode(parsed.machine)).toBe("agent");
	});

	it("mcp.list parses every server, nulls included, and reads an unknown state as invalid", () => {
		const servers = parseMcpList(resultOf("mcp.list"));
		expect(servers.map((s) => [s.name, s.transport, s.state])).toEqual([
			["notes", "stdio", "ready"],
			["crm", "http", "needs-login"],
			["old", "sse", "disabled"],
			["broken", "stdio", "invalid"],
		]);
		expect(servers[1].allowedTools).toEqual(["search", "get_contact"]);
		expect(servers[0].description).toBe("My notes folder");
		expect(parseMcpList(resultOf("mcp.list", "empty"))).toEqual([]);
		expect(parseMcpList({ servers: null })).toEqual([]);
		expect(
			parseMcpList({ servers: [{ name: "x", transport: "ws", state: "melting" }] })[0]
		).toMatchObject({ transport: "stdio", state: "invalid" });
	});

	it("mcp.open and mcp.login results parse", () => {
		expect(mcpOpenResultSchema.parse(resultOf("mcp.open")).channelId).toBe("ch_7f3a");
		expect(mcpLoginResultSchema.parse(resultOf("mcp.login")).authorizationUrl).toContain("state=");
		expect(mcpOpenResultSchema.safeParse({}).success).toBe(false);
	});

	it("mcp frames travel in both directions, with the closed variants carrying null or text", () => {
		expect(MACHINE_TO_CEREA_FRAME_TYPES).toContain("mcp");
		expect(CEREA_TO_MACHINE_FRAME_TYPES).toContain("mcp");
		expect(fixtureAt("frames/mcp.c2m.json").meta.direction).toBe("C→M");
		const closed = parseMachineFrame(fixtureAt("frames/mcp.closed.idle.json").frame);
		expect(closed).toMatchObject({ type: "mcp", closed: { reason: "idle", detail: null } });
		// A frame with no channel is dropped, not thrown.
		expect(parseMachineFrame({ type: "mcp", message: {} })).toBeNull();
	});
});
