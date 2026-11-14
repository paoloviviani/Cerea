import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import {
	applyMemoryBlocks,
	attachPendingNotes,
	blocksByPosition,
	carriedNotesBlock,
	END_OF_NOTES,
	injectCarriedNotes,
	modelNoteIdsIn,
	noteEventBlocks,
	renderNoteEvents,
} from "./blocks";
import { rememberForConversation } from "./service";
import type { NoteEvent } from "$lib/types/ScopedMemory";

describe("rendering the notes a user kept", () => {
	const events: NoteEvent[] = [
		{ kind: "added", noteId: "a", text: "Use metric units." },
		{ kind: "edited", noteId: "b", text: "Answer in French." },
	];

	it("is deterministic and closes with the end marker", () => {
		const one = renderNoteEvents(events);
		expect(renderNoteEvents(events.map((event) => ({ ...event })))).toBe(one);
		expect(one).toContain("- added: Use metric units.");
		expect(one).toContain("- now reads: Answer in French.");
		expect(one.endsWith(END_OF_NOTES)).toBe(true);
		expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}|\d\d:\d\d/);
	});

	it("is attached to user messages that have events and to nothing else", () => {
		const messages = [
			{ id: "u1", from: "user", notes: events },
			{ id: "a1", from: "assistant", notes: events },
			{ id: "u2", from: "user" },
		];
		const blocks = noteEventBlocks(messages);
		expect([...blocks.keys()]).toEqual(["u1"]);
		const applied = applyMemoryBlocks(
			messages.map((m) => ({ ...m, content: m.id })),
			blocksByPosition(messages, messages.length, blocks)
		);
		expect(applied[0].content.startsWith("[NOTES THE USER KEPT")).toBe(true);
		expect(applied[0].content.endsWith(`${END_OF_NOTES}\n\nu1`)).toBe(true);
		expect(applied[1].content).toBe("a1");
		expect(applied[2].content).toBe("u2");
	});

	it("keeps its place when preparing the messages dropped an empty first system message", () => {
		const path = [
			{ id: "s", from: "system" },
			{ id: "u1", from: "user" },
		];
		const blocks = blocksByPosition(path, 1, new Map([["u1", "BLOCK"]]));
		expect([...blocks.entries()]).toEqual([[0, "BLOCK"]]);
	});
});

describe("carrying notes over a flattened turn", () => {
	const remembered = (id: string, scope: "conversation" | "project" = "conversation") => ({
		type: MessageUpdateType.Memory as const,
		uuid: `u-${id}`,
		action: "remembered" as const,
		text: "x",
		memoryId: id,
		scope,
	});

	it("finds only the chat notes the model made", () => {
		const ids = modelNoteIdsIn([
			{ updates: [remembered("n1"), remembered("p1", "project")] },
			{ updates: [{ ...remembered("n2"), action: "forgot" as const }] },
			{},
		]);
		expect([...ids]).toEqual(["n1"]);
	});

	it("puts the block in front of the first user message, once", () => {
		const out = injectCarriedNotes(
			[
				{ role: "assistant", content: "hi" },
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
			"BLOCK"
		);
		expect(out[1].content).toBe("BLOCK\n\nfirst");
		expect(out[2].content).toBe("second");
		expect(injectCarriedNotes(out, undefined)).toBe(out);
	});

	it("renders the current text of just the notes of the flattened turns, in order, with authors", async () => {
		await ready;
		const conversationId = new ObjectId();
		const a = await rememberForConversation({
			conversationId,
			text: "First note.",
			source: "model",
		});
		const b = await rememberForConversation({
			conversationId,
			text: "Typed note.",
			source: "user",
		});
		const c = await rememberForConversation({
			conversationId,
			text: "Kept in full.",
			source: "model",
		});
		const messages = [
			{ updates: [remembered(a.memory._id.toString()), remembered(b.memory._id.toString())] },
			{ updates: [remembered(c.memory._id.toString())] },
		];
		const block = await carriedNotesBlock({ conversationId, messages, flattened: [0] });
		expect(block).toContain("NOTES FROM EARLIER IN THIS CHAT");
		expect(block).toContain("- (saved by the assistant) First note.");
		expect(block).toContain("- (typed by the user) Typed note.");
		expect(block).not.toContain("Kept in full.");
		expect(block?.endsWith(END_OF_NOTES)).toBe(true);
		expect(block?.indexOf("First note.")).toBeLessThan(block?.indexOf("Typed note.") ?? 0);
		expect(await carriedNotesBlock({ conversationId, messages, flattened: [] })).toBeUndefined();
		await collections.conversationMemories.deleteMany({ conversationId });
	});
});

describe("attaching what the user kept to their next message", () => {
	it("moves the pending events onto the newest user message, once, and leaves a regenerated message alone", async () => {
		await ready;
		const convId = new ObjectId();
		const events: NoteEvent[] = [{ kind: "added", noteId: "n1", text: "Kept." }];
		const messages = [
			{ id: "u1", from: "user" as const, content: "hi" },
			{ id: "u2", from: "user" as const, content: "again" },
		];
		await collections.conversations.insertOne({
			_id: convId,
			model: "m",
			title: "t",
			messages: structuredClone(messages),
			pendingNotes: events,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const conv = (await collections.conversations.findOne({ _id: convId })) as never as {
			_id: ObjectId;
			pendingNotes?: NoteEvent[];
			messages: (typeof messages)[number] & { notes?: NoteEvent[] }[];
		};
		const path = (
			conv.messages as unknown as {
				id: string;
				from: "user";
				content: string;
				notes?: NoteEvent[];
			}[]
		).map((m) => m);
		await attachPendingNotes({ conv: conv as never, messages: path as never });
		const stored = (await collections.conversations.findOne({ _id: convId })) as never as {
			pendingNotes?: NoteEvent[];
			messages: { id: string; notes?: NoteEvent[] }[];
		};
		expect(stored.messages.find((m) => m.id === "u2")?.notes).toEqual(events);
		expect(stored.messages.find((m) => m.id === "u1")?.notes).toBeUndefined();
		expect(stored.pendingNotes ?? []).toEqual([]);

		// Notes kept after that wait for the next message: a message that already has notes is not rewritten.
		const later: NoteEvent[] = [{ kind: "edited", noteId: "n1", text: "Changed." }];
		await collections.conversations.updateOne({ _id: convId }, { $set: { pendingNotes: later } });
		const again = (await collections.conversations.findOne({ _id: convId })) as never as {
			_id: ObjectId;
			pendingNotes?: NoteEvent[];
			messages: { id: string; from: "user"; content: string; notes?: NoteEvent[] }[];
		};
		await attachPendingNotes({ conv: again as never, messages: again.messages as never });
		const final = (await collections.conversations.findOne({ _id: convId })) as never as {
			pendingNotes?: NoteEvent[];
			messages: { id: string; notes?: NoteEvent[] }[];
		};
		expect(final.messages.find((m) => m.id === "u2")?.notes).toEqual(events);
		expect(final.pendingNotes).toEqual(later);
		await collections.conversations.deleteMany({ _id: convId });
	});
});
