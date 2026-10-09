import { describe, expect, it } from "vitest";
import { forkableMessageIds } from "./codeFork";
import type { Message } from "$lib/types/Message";

const assistant = (id: string, machineMessageId?: string): Message => ({
	id,
	from: "assistant",
	content: `answer ${id}`,
	children: [],
	...(machineMessageId ? { machineMessageId } : {}),
});
const user = (id: string): Message => ({ id, from: "user", content: id, children: [] });

describe("forkableMessageIds", () => {
	it("an idle session offers the fork on every assistant message the machine named", () => {
		const messages = [
			user("u1"),
			assistant("a1", "wire-a1"),
			user("u2"),
			assistant("a2", "wire-a2"),
			assistant("a3", "wire-a3"),
		];
		expect(forkableMessageIds(messages, false)).toEqual(new Set(["a1", "a2", "a3"]));
	});

	it("a message without a machineMessageId is never offered: the fork route cuts at a wire message", () => {
		const messages = [user("u1"), assistant("a1"), assistant("a2", "wire-a2")];
		expect(forkableMessageIds(messages, false)).toEqual(new Set(["a2"]));
	});

	it("while the session runs, the running turn's messages — after the last user message — are not offered; earlier turns are", () => {
		// The same positional rule covers a steered turn: a message before the
		// person's mid-turn message stays offered, the continuation after it
		// (the live turn's own work) does not.
		const messages = [
			user("u1"),
			assistant("a1", "wire-a1"),
			user("u2"),
			assistant("a2", "wire-a2"),
		];
		expect(forkableMessageIds(messages, true)).toEqual(new Set(["a1"]));
	});

	it("a busy session with no user message offers nothing: all of it is the live turn", () => {
		const messages = [assistant("a1", "wire-a1")];
		expect(forkableMessageIds(messages, true)).toEqual(new Set());
	});

	it("user messages are never offered", () => {
		const messages = [user("u1"), assistant("a1", "wire-a1"), user("u2")];
		expect(forkableMessageIds(messages, false)).toEqual(new Set(["a1"]));
	});

	it("a failed ending is a fixed point like any other: the session is not running", () => {
		const messages = [
			user("u1"),
			assistant("a1", "wire-a1"),
			user("u2"),
			assistant("a2", "wire-a2"),
		];
		expect(forkableMessageIds(messages, false)).toEqual(new Set(["a1", "a2"]));
	});
});
