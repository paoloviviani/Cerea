import { describe, expect, it } from "vitest";
import { coordinationCall, referencedSessionIds } from "./codeSessionLinks";
import type { Message } from "$lib/types/Message";

describe("coordinationCall, session_read", () => {
	const params = { target: "ses_b", last: 5 };

	it("is pending, then done with the plain transcript text, naming the session read", () => {
		expect(coordinationCall("session_read", params, undefined)).toMatchObject({
			kind: "read",
			state: "pending",
			sessionId: "ses_b",
		});
		expect(
			coordinationCall("session_read", params, {
				text: "Transcript of session…\n[user · 2026-10-08T09:00:00Z]\nhi",
				failed: false,
			})
		).toMatchObject({ kind: "read", state: "done", sessionId: "ses_b" });
	});

	it("is refused on an error result, a refusal object or an empty answer", () => {
		expect(
			coordinationCall("session_read", params, { text: undefined, failed: true })
		).toMatchObject({ state: "refused" });
		expect(
			coordinationCall("session_read", params, {
				text: '{"refused":"you cannot read your own session"}',
				failed: false,
			})
		).toMatchObject({ state: "refused" });
		expect(coordinationCall("session_read", params, { text: "", failed: false })).toMatchObject({
			state: "refused",
		});
	});
});

describe("coordinationCall", () => {
	it("ignores every other tool", () => {
		expect(coordinationCall("bash", { command: "ls" }, undefined)).toBeNull();
		expect(coordinationCall(undefined, undefined, undefined)).toBeNull();
	});

	it("reads a spawn: pending, then done with the child's id", () => {
		const params = { title: "Docs", prompt: "write them" };
		expect(coordinationCall("session_spawn", params, undefined)).toEqual({
			kind: "spawn",
			state: "pending",
			title: "Docs",
		});
		expect(
			coordinationCall("session_spawn", params, {
				text: '{"sessionId":"ses_child"}',
				failed: false,
			})
		).toEqual({ kind: "spawn", state: "done", sessionId: "ses_child", title: "Docs" });
	});

	it("carries autoApproved from a result that says the machine approved it unasked", () => {
		expect(
			coordinationCall(
				"session_spawn",
				{ title: "Docs", prompt: "x" },
				{ text: '{"sessionId":"ses_c","autoApproved":true}', failed: false }
			)
		).toMatchObject({ state: "done", autoApproved: true });
		expect(
			coordinationCall(
				"session_send",
				{ target: "ses_b", text: "x" },
				{ text: '{"autoApproved":true}', failed: false }
			)
		).toMatchObject({ state: "done", sessionId: "ses_b", autoApproved: true });
		expect(
			coordinationCall(
				"session_send",
				{ target: "ses_b", text: "x" },
				{ text: "{}", failed: false }
			)
		).not.toHaveProperty("autoApproved");
	});

	it("does not call a refused spawn spawned", () => {
		const params = { title: "Docs", prompt: "x" };
		const refusal = "The person declined to start a new session.";
		expect(
			coordinationCall("session_spawn", params, { text: refusal, failed: false })
		).toMatchObject({ state: "refused" });
		expect(coordinationCall("session_spawn", params, { text: "{}", failed: false })).toMatchObject({
			state: "refused",
		});
		expect(
			coordinationCall("session_spawn", params, { text: undefined, failed: true })
		).toMatchObject({ state: "refused" });
	});

	it("reads a send: the target from the call, done on an empty object", () => {
		const params = { target: "ses_b", text: "hi" };
		expect(coordinationCall("session_send", params, undefined)).toMatchObject({
			state: "pending",
			sessionId: "ses_b",
		});
		expect(coordinationCall("session_send", params, { text: "{}", failed: false })).toEqual({
			kind: "send",
			state: "done",
			sessionId: "ses_b",
		});
		expect(coordinationCall("session_send", params, { text: "", failed: false })).toMatchObject({
			state: "done",
		});
		expect(
			coordinationCall("session_send", params, { text: "The person declined.", failed: false })
		).toMatchObject({ state: "refused", sessionId: "ses_b" });
	});
});

describe("referencedSessionIds", () => {
	it("collects senders, send targets and spawned children, once each", () => {
		const tool = (name: string, parameters: Record<string, unknown>, text?: string) => [
			{ type: "tool", subtype: "call", uuid: name, call: { name, parameters } },
			...(text === undefined
				? []
				: [
						{
							type: "tool",
							subtype: "result",
							uuid: name,
							result: { status: "success", call: { name, parameters }, outputs: [{ text }] },
						},
					]),
		];
		const messages = [
			{
				from: "user",
				content: "hi",
				children: [],
				sentBy: { sessionId: "ses_a", title: "A", hop: 1 },
			},
			{
				from: "assistant",
				content: "",
				children: [],
				updates: [
					...tool("session_send", { target: "ses_b", text: "x" }, "{}"),
					...tool("session_spawn", { title: "C", prompt: "y" }, '{"sessionId":"ses_c"}'),
					...tool("session_send", { target: "ses_a", text: "x" }),
				],
			},
		] as unknown as Message[];
		expect(referencedSessionIds(messages).sort()).toEqual(["ses_a", "ses_b", "ses_c"]);
	});
});
