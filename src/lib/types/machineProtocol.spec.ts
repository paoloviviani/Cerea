import { describe, expect, it } from "vitest";
import { isPermissionMode, parseMachineFrame, parsePermissionRules } from "./machineProtocol";

const CAPABILITIES = {
	diff: true,
	children: true,
	usage: true,
	compact: true,
	images: true,
	files: true,
	worktrees: false,
	questions: true,
};

function hello(policy: Record<string, unknown>) {
	return {
		type: "hello",
		protocol: 1,
		agent: { version: "1", os: "linux", arch: "amd64", hostname: "box" },
		backends: [{ id: "opencode", version: "1.18.32", capabilities: CAPABILITIES }],
		policy,
		credential: { state: "ok" },
	};
}

describe("hello policy", () => {
	// The retired flag is sent as the constant "denied" for one release, and an
	// agent that predates the selector still sends its old capability and
	// `permission.responders`; every one of them must still connect.
	it("accepts a machine that sends the retired fields, and one that does not", () => {
		for (const policy of [
			{ autoAccept: "denied", workspaceRoots: [], allowFreeModels: false },
			{
				permission: { responders: "allowed", max: {} },
				workspaceRoots: [],
				allowFreeModels: false,
			},
			{ workspaceRoots: [], allowFreeModels: false },
		]) {
			expect(parseMachineFrame(hello(policy))?.type).toBe("hello");
		}
		const old = hello({ workspaceRoots: [], allowFreeModels: false });
		old.backends[0].capabilities = { ...CAPABILITIES, autoAccept: true } as typeof CAPABILITIES;
		expect(parseMachineFrame(old)?.type).toBe("hello");
	});

	it("accepts the machine's permission policy and keeps it for the panel to read", () => {
		const frame = parseMachineFrame(
			hello({
				permission: { max: { bash: "ask" }, rules: { edit: "ask" } },
				workspaceRoots: [],
				allowFreeModels: false,
			})
		);
		expect(frame?.type).toBe("hello");
		expect((frame as { policy: { permission: { max: unknown } } }).policy.permission.max).toEqual({
			bash: "ask",
		});
	});

	it("still refuses a policy that is not a policy", () => {
		expect(parseMachineFrame(hello({ autoAccept: "maybe", workspaceRoots: [] }))).toBeNull();
	});
});

describe("parsePermissionRules", () => {
	it("keeps well-formed rules in order, with their source", () => {
		const parsed = parsePermissionRules({
			rules: [
				{ permission: "edit", pattern: "*", action: "ask", source: "file" },
				{ permission: "edit", pattern: "*", action: "allow", source: "cerea" },
			],
			savedApprovals: [{ id: "a", permission: "bash", patterns: ["ls"] }],
		});
		expect(parsed.rules.map((rule) => [rule.action, rule.source])).toEqual([
			["ask", "file"],
			["allow", "cerea"],
		]);
		expect(parsed.savedApprovals).toEqual([{ id: "a", permission: "bash", patterns: ["ls"] }]);
	});

	it("answers empty lists for anything that is not an object", () => {
		for (const raw of [null, undefined, "x", 3, [], { rules: "no" }]) {
			expect(parsePermissionRules(raw)).toEqual({
				rules: [],
				savedApprovals: [],
				ceiling: {},
			});
		}
	});

	it("reads the machine's safe directories, and drops what is not a string", () => {
		const parsed = parsePermissionRules({ safeDirs: ["/tmp", "~/.cache", 3, null] });
		expect(parsed.safeDirs).toEqual(["/tmp", "~/.cache"]);
		// Absent stays absent (an older galopin), unlike an empty list (none).
		expect(parsePermissionRules({}).safeDirs).toBeUndefined();
		expect(parsePermissionRules({ safeDirs: [] }).safeDirs).toEqual([]);
	});

	it("reads the machine's own spelling of a saved approval (action / resource)", () => {
		const parsed = parsePermissionRules({
			savedApprovals: [
				{ id: "sav_1", action: "bash", resource: "ls *" },
				{
					id: "sav_2",
					permission: "edit",
					patterns: ["src/**"],
					removable: false,
					sessionId: "s1",
				},
				{ id: "sav_3" },
			],
		});
		expect(parsed.savedApprovals).toEqual([
			{ id: "sav_1", permission: "bash", patterns: ["ls *"] },
			{ id: "sav_2", permission: "edit", patterns: ["src/**"], sessionId: "s1", removable: false },
		]);
	});

	it("reads the session's mode and its exceptions' grant time, and drops a mode that is not one of the three", () => {
		const parsed = parsePermissionRules({
			mode: "allow",
			savedApprovals: [
				{
					id: "ex_1",
					sessionId: "s1",
					permission: "bash",
					patterns: ["git status"],
					removable: true,
					grantedAt: "2026-10-03T09:00:00Z",
				},
			],
		});
		expect(parsed.mode).toBe("allow");
		expect(parsed.savedApprovals).toEqual([
			{
				id: "ex_1",
				sessionId: "s1",
				permission: "bash",
				patterns: ["git status"],
				removable: true,
				grantedAt: "2026-10-03T09:00:00Z",
			},
		]);
		expect(parsePermissionRules({ mode: "sometimes" }).mode).toBeUndefined();
		expect(parsePermissionRules({}).mode).toBeUndefined();
		for (const mode of ["deny", "ask", "allow"]) expect(isPermissionMode(mode)).toBe(true);
		for (const bad of ["Allow", "", null, 1, undefined]) expect(isPermissionMode(bad)).toBe(false);
	});

	it("reads the ceiling and the agent, and ignores a cap that is not ask or deny", () => {
		const parsed = parsePermissionRules({
			agent: "build",
			ceiling: { bash: "ask", edit: "deny", webfetch: "allow", x: 1 },
		});
		expect(parsed.agent).toBe("build");
		expect(parsed.ceiling).toEqual({ bash: "ask", edit: "deny" });
	});

	it("keeps a rule with no source, and does not invent one", () => {
		const parsed = parsePermissionRules({
			rules: [{ permission: "edit", pattern: "*", action: "ask" }],
		});
		expect(parsed.rules[0]).toEqual({ permission: "edit", pattern: "*", action: "ask" });
	});
});
