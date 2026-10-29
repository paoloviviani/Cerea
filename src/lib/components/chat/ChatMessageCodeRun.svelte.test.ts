import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ChatMessage from "./ChatMessage.svelte";
import {
	MessageCodeExecutionUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
} from "$lib/types/MessageUpdate";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

const CODE = "make_report()";
const call = (uuid: string) => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid,
	call: { name: "execute_code", parameters: { code: CODE } },
});
const result = (uuid: string) => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Result,
	uuid,
	result: {
		status: "success",
		call: { name: "execute_code", parameters: {} },
		outputs: [{ text: "ok" }],
		display: true,
	},
});
const request = (toolUuid?: string) => ({
	type: MessageUpdateType.CodeExecution,
	subtype: MessageCodeExecutionUpdateType.Request,
	executionId: "e1",
	code: CODE,
	...(toolUuid ? { toolUuid } : {}),
});
const resolved = {
	type: MessageUpdateType.CodeExecution,
	subtype: MessageCodeExecutionUpdateType.Resolved,
	executionId: "e1",
	outcome: { ok: true, stdout: "", stderr: "" },
	files: [{ name: "report.pdf", size: 10, sha256: "a".repeat(64) }],
};

const mount = (updates: unknown[]) =>
	render(ChatMessage, {
		message: { id: "m1", from: "assistant", content: "Done.", children: [], updates },
		loading: false,
		isLast: true,
		readOnly: false,
	} as never);

describe("an execute_code run in a message", () => {
	it("is one card, 'Ran code', with no separate 'Called tool' row (request names its call)", () => {
		const view = mount([call("t1"), request("t1"), result("t1"), resolved]);
		const out = view.baseElement.textContent ?? "";
		expect(out).toContain("Ran code");
		expect(out).not.toContain("Called tool");
		expect(out).not.toContain("execute_code");
		expect(view.baseElement.querySelectorAll('[data-testid="code-execution-card"]')).toHaveLength(
			1
		);
	});

	it("is still one card for a message stored before the request carried its call's uuid", () => {
		const view = mount([call("t1"), request(), result("t1"), resolved]);
		const out = view.baseElement.textContent ?? "";
		expect(out).toContain("Ran code");
		expect(out).not.toContain("Called tool");
		expect(out).not.toContain("execute_code");
	});

	it("keeps other tools' rows as they were", () => {
		const other = {
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Call,
			uuid: "t2",
			call: { name: "bash", parameters: {} },
		};
		const view = mount([other, call("t1"), request("t1"), resolved]);
		expect(view.baseElement.textContent ?? "").toMatch(/bash/);
	});
});
