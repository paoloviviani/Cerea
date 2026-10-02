import { describe, expect, it } from "vitest";
import { parseMachineFrame, parsePermissionRules } from "./machineProtocol";

const CAPABILITIES = {
	diff: true,
	children: true,
	usage: true,
	compact: true,
	images: true,
	files: true,
	worktrees: false,
	autoAccept: true,
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
	it("accepts a machine that still reports the responder flag", () => {
		const frame = parseMachineFrame(
			hello({ autoAccept: "allowed", workspaceRoots: [], allowFreeModels: false })
		);
		expect(frame?.type).toBe("hello");
	});

	// The agent half deletes `Policy.autoAccept` from the wire; a hello without
	// it must still connect, or every upgraded machine would be refused.
	it("accepts a machine that no longer reports it", () => {
		const frame = parseMachineFrame(hello({ workspaceRoots: [], allowFreeModels: false }));
		expect(frame?.type).toBe("hello");
	});

	it("accepts the machine's permission policy and keeps it for the panel to read", () => {
		const frame = parseMachineFrame(
			hello({
				permission: { responders: "allowed", max: { bash: "ask" }, rules: { edit: "ask" } },
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
			expect(parsePermissionRules(raw)).toEqual({ rules: [], savedApprovals: [], ceiling: {} });
		}
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
