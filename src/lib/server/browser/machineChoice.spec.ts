/** Which computer: the rules of `machineChoice.ts`, case by case. The model never picks. */
import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { chooseMachine, memoryChoiceStore } from "./machineChoice";

const laptop = { id: "a".repeat(24), name: "Laptop" };
const desk = { id: "b".repeat(24), name: "Desk" };
const phone = { id: "c".repeat(24), name: "Phone" };
const devices = { [laptop.id]: "Laptop", [desk.id]: "Desk", [phone.id]: "Phone" };
const userId = new ObjectId();
const CONV = "conv-1";

const choose = (
	ready: Array<{ id: string; name: string }>,
	store = memoryChoiceStore({ devices }),
	extra: { conversationId?: string; hint?: string } = {}
) => chooseMachine({ userId, ready, store, ...extra });

describe("which computer", () => {
	it("1. one ready computer: used, no question", async () => {
		expect(await choose([laptop])).toEqual({ kind: "use", machine: laptop, why: "only" });
	});

	it("2. a conversation that has a computer always uses it, never another", async () => {
		const store = memoryChoiceStore({ devices, conversation: { [CONV]: desk.id } });
		expect(await choose([laptop, desk], store, { conversationId: CONV })).toEqual({
			kind: "use",
			machine: desk,
			why: "conversation",
		});
		// Even when it is the other one that is the only ready computer: no jump.
		expect(await choose([laptop], store, { conversationId: CONV })).toEqual({
			kind: "error",
			message: "Desk is offline.",
		});
		// And over the user's default.
		const withDefault = memoryChoiceStore({
			devices,
			conversation: { [CONV]: desk.id },
			default: laptop.id,
		});
		expect(await choose([laptop, desk], withDefault, { conversationId: CONV })).toMatchObject({
			machine: desk,
		});
	});

	it("3. the user's default, when the chat has none", async () => {
		const store = memoryChoiceStore({ devices, default: desk.id });
		expect(await choose([laptop, desk, phone], store)).toEqual({
			kind: "use",
			machine: desk,
			why: "default",
		});
		// A conversation of another computer is not affected by a default elsewhere.
		const other = memoryChoiceStore({ devices, default: desk.id, conversation: { x: laptop.id } });
		expect(await choose([laptop, desk], other, { conversationId: "y" })).toMatchObject({
			machine: desk,
		});
	});

	it("4. otherwise it asks, listing the ready computers", async () => {
		expect(await choose([laptop, desk])).toEqual({ kind: "ask", options: [laptop, desk] });
	});

	it("4b. the machine hint counts only when the user's latest message names the computer, as a whole word", async () => {
		const hinted = (hint: string, userText?: string) =>
			choose([laptop, desk], undefined, { hint, userText });
		expect(await hinted("DESK", "use my desk please")).toEqual({
			kind: "use",
			machine: desk,
			why: "hint",
		});
		// The hint alone (the model's say-so) is not enough, nor is an unattended run (no user text).
		expect(await hinted("Desk", "check the flights")).toMatchObject({ kind: "ask" });
		expect(await hinted("Desk")).toMatchObject({ kind: "ask" });
		// Not a whole word: "desktop" does not name "Desk".
		expect(await hinted("Desk", "use my desktop")).toMatchObject({ kind: "ask" });
		// Not a ready computer, an id, a partial name.
		expect(await hinted("Phone", "use the Phone")).toMatchObject({ kind: "ask" });
		expect(await hinted(desk.id, `use ${desk.id}`)).toMatchObject({ kind: "ask" });
		expect(await hinted("des", "use des")).toMatchObject({ kind: "ask" });
		// The hint never beats the chat's computer or the default.
		const store = memoryChoiceStore({ devices, default: laptop.id });
		expect(
			await choose([laptop, desk], store, { hint: "Desk", userText: "use Desk" })
		).toMatchObject({ machine: laptop });
	});

	it("5. a chosen computer that is offline stops, with no fallback", async () => {
		const store = memoryChoiceStore({ devices, default: phone.id });
		expect(await choose([laptop, desk], store)).toEqual({
			kind: "error",
			message: "Phone is offline.",
		});
		expect(await choose([laptop], store)).toEqual({ kind: "error", message: "Phone is offline." });
	});

	it("a revoked or unknown computer is not remembered: the rules go on", async () => {
		const gone = { id: "d".repeat(24) };
		const store = memoryChoiceStore({
			devices,
			default: gone.id,
			conversation: { [CONV]: gone.id },
		});
		expect(await choose([laptop], store, { conversationId: CONV })).toMatchObject({
			kind: "use",
			why: "only",
		});
		expect(await choose([laptop, desk], store, { conversationId: CONV })).toMatchObject({
			kind: "ask",
		});
	});

	it("no ready computer is an error, not a question", async () => {
		expect(await choose([])).toEqual({
			kind: "error",
			message: expect.stringContaining("No computer"),
		});
	});
});
