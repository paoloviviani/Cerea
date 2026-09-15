import { vi } from "vitest";

// The deployment flag is read through the config proxy; mock the config module
// (passing everything else through to the real one) so the flag is controllable
// per test. The real config still resolves its env through the setup file's
// $env/dynamic/private mock, so the database plumbing stays intact.
const configState = vi.hoisted(() => ({ enabled: true }));

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		get config() {
			return new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (prop === "CHAT_CODE_TOOL_ENABLED") {
						return configState.enabled ? "true" : "";
					}
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	CODE_EXECUTION_DEADLINE_MS,
	EXECUTE_CODE_TOOL_NAME,
	MAX_EXECUTE_CODE_CALLS,
	codeResumeResultText,
	createExecuteCodeBuiltin,
	isExecuteCodeEnabled,
	isParkedCodeCall,
} from "./executeCodeTool";
import type { BuiltinToolContext } from "./types";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

const emitted: unknown[] = [];

const ctx = (over: Partial<BuiltinToolContext> = {}): BuiltinToolContext => ({
	uuid: "uuid-1",
	toolCallId: "call-1",
	conversationId: new ObjectId(),
	messageId: "msg-1",
	userId: new ObjectId(),
	sessionId: "sess-1",
	elicitationSink: {
		conversationId: new ObjectId(),
		emit: (update) => emitted.push(update),
	},
	...over,
});

// A fresh factory per call: the per-turn cap is counted in the factory's
// closure, so tests stay independent. The cap test creates its own instance.
const tool = () => createExecuteCodeBuiltin()[0];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.parkedCalls.deleteMany({});
	emitted.length = 0;
});

describe("the execute_code tool", () => {
	it("registers exactly one tool when the flag is on", () => {
		const tools = createExecuteCodeBuiltin();
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe(EXECUTE_CODE_TOOL_NAME);
		expect(tools[0].mayPark).toBe(true);
	});

	it("registers nothing when the deployment flag is off", () => {
		configState.enabled = false;
		try {
			expect(isExecuteCodeEnabled()).toBe(false);
			expect(createExecuteCodeBuiltin()).toEqual([]);
		} finally {
			configState.enabled = true;
		}
	});

	it("says in its own description that the call goes through function calling", () => {
		// Pinned beside the execution prompt's rule (executionPrompt.spec.ts):
		// the description reaches models that never read the system prompt, and
		// the recorded failure was a model writing the call into its reply as
		// text because nothing anywhere said how the tool is invoked.
		const description = createExecuteCodeBuiltin()[0]?.definition.function.description ?? "";
		expect(description).toContain("function-calling mechanism, as a real");
		expect(description).toContain("never by writing the call into your reply as text markup");
	});

	it("parks the turn on the browser and emits the code execution request", async () => {
		const c = ctx();
		const before = Date.now();

		const outcome = await tool().execute({ code: "print('hi')" }, c);

		expect(outcome).toEqual({ awaitingInput: true });
		const row = await collections.parkedCalls.findOne({});
		expect(row).toMatchObject({
			conversationId: c.conversationId,
			messageId: "msg-1",
			toolCallId: "call-1",
			toolUuid: "uuid-1",
			kind: "code",
			status: "waiting",
			reason: "code execution in the person's browser",
			code: "print('hi')",
			userId: c.userId,
			sessionId: "sess-1",
			attempts: 0,
		});
		// The deadline covers a cold worker (load budget) plus one run plus grace.
		expect(row?.resumeAt.getTime()).toBeGreaterThanOrEqual(
			before + CODE_EXECUTION_DEADLINE_MS - 1_000
		);

		// The code streams to the browser over the elicitation channel, and the
		// park is a lifecycle transition carried on the same channel.
		expect(emitted).toHaveLength(2);
		const [request, turnState] = emitted as [
			{ type: string; subtype: string; executionId: string; code: string; expiresAt?: number },
			{ type: string; state: string },
		];
		expect(request.type).toBe(MessageUpdateType.CodeExecution);
		expect(request.subtype).toBe("request");
		expect(request.executionId).toBe(row?.parkedCallId);
		expect(request.code).toBe("print('hi')");
		expect(request.expiresAt).toBe(row?.resumeAt.getTime());
		expect(turnState.type).toBe(MessageUpdateType.TurnState);
		expect(turnState.state).toBe("awaiting_input");
		expect(await isParkedCodeCall(c.conversationId as ObjectId, row?.parkedCallId ?? "")).toBe(
			true
		);
	});

	it("refuses past the per-turn cap with an obedient message", async () => {
		const c = ctx();
		// One factory instance for the whole loop: the cap counts in its closure.
		const cappedTool = createExecuteCodeBuiltin()[0];
		let outcome;
		for (let i = 0; i < MAX_EXECUTE_CODE_CALLS; i += 1) {
			outcome = await cappedTool.execute({ code: `print(${i})` }, c);
			expect(outcome).toEqual({ awaitingInput: true });
		}
		outcome = await cappedTool.execute({ code: "print('over')" }, c);
		expect(outcome).toHaveProperty("error");
		expect(String((outcome as { error: string }).error)).toContain(
			`limit of ${MAX_EXECUTE_CODE_CALLS} calls`
		);
		expect(await collections.parkedCalls.countDocuments({})).toBe(MAX_EXECUTE_CODE_CALLS);
	});

	it("refuses an empty snippet without parking", async () => {
		const outcome = await tool().execute({ code: "   " }, ctx());
		expect(outcome).toHaveProperty("error");
		expect(await collections.parkedCalls.countDocuments({})).toBe(0);
	});

	it("declines to park where nothing could wake it", async () => {
		const outcome = await tool().execute(
			{ code: "print('x')" },
			ctx({ conversationId: undefined, messageId: undefined })
		);
		expect(outcome).toHaveProperty("error");
		expect(await collections.parkedCalls.countDocuments({})).toBe(0);
	});

	it("refuses without a browser channel instead of parking a stranded turn", async () => {
		const outcome = await tool().execute(
			{ code: "print('x')" },
			ctx({ elicitationSink: undefined })
		);
		expect(outcome).toHaveProperty("error");
		expect(String((outcome as { error: string }).error)).toContain("unavailable");
		expect(await collections.parkedCalls.countDocuments({})).toBe(0);
	});
});

describe("the tool result a resumed code turn reads", () => {
	const outcome = {
		ok: true,
		stdout: "hello\n",
		stderr: "",
		result: "'done'",
		files: [{ path: "/home/pyodide/out.csv", size: 120 }],
	};

	const park = (over: Record<string, unknown> = {}) =>
		({
			parkedCallId: "exec-1",
			kind: "code",
			reason: "code execution in the person's browser",
			outcome,
			...over,
		}) as never;

	it("reports the outcome and names the created files", () => {
		const text = codeResumeResultText(park(), false);
		expect(text).toContain("Execution finished in the person's browser sandbox.");
		expect(text).toContain("stdout:\nhello");
		expect(text).toContain("Result: 'done'");
		expect(text).toContain("out.csv");
		expect(text).toContain("session-only");
	});

	it("reports a failed run as an error the model can act on", () => {
		const text = codeResumeResultText(
			park({ outcome: { ok: false, stdout: "", stderr: "", error: "NameError: x" } }),
			false
		);
		expect(text).toContain("Execution finished with an error.");
		expect(text).toContain("NameError: x");
		expect(text).not.toContain("Result:");
	});

	it("falls back to a fence when the browser never answered", () => {
		const text = codeResumeResultText(park({ outcome: undefined }), false);
		expect(text).toContain("The execution environment was unavailable");
		expect(text).toContain("Do NOT claim any execution result or file");
		expect(text).toContain("present the code as a code block");
	});

	it("warns about an expired session on the resumed round", () => {
		const text = codeResumeResultText(park(), true);
		expect(text).toContain("signed-in session expired");
	});
});
