/**
 * Which computer a browser task or "Open browser" runs on (ADR 0116, C109). Shared by the
 * `browse` tool and the open endpoint, and decided by rules, never by the model:
 *
 * 1. The conversation already has a computer (it kept a page there, or used it): always that one,
 *    never jumping. If it is not ready: "<computer> is offline", with no fallback.
 * 2. The user's default computer (Connectors, "Use for browsing by default"), the same way: if it
 *    is not ready, "<computer> is offline".
 * 3. Exactly one ready computer: that one, no question.
 * 4. Otherwise the user is asked ("Which computer?"). The model's `machine` argument is only a
 *    hint, honoured at this step when it names one of the ready computers (exact name, any case):
 *    the user's own words in the request are then the answer. Nothing else the model passes picks.
 *
 * A device that is revoked, not paired or not the caller's never counts as a remembered computer.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import type { BrowseMachine } from "./availability";

export type MachineChoice =
	| { kind: "use"; machine: BrowseMachine; why: "conversation" | "default" | "only" | "hint" }
	| { kind: "ask"; options: BrowseMachine[] }
	| { kind: "error"; message: string };

/** What the rules read about the user and the conversation. */
export interface ChoiceStore {
	/** The computer this conversation already uses: its `browserDeviceId`, else one holding its kept page. */
	conversationDevice(userId: ObjectId, conversationId: string): Promise<string | undefined>;
	/** The user's default computer. */
	defaultDevice(userId: ObjectId): Promise<string | undefined>;
	/** A paired computer of the user's by id: its name, or undefined (gone, revoked, pending, not theirs). */
	nameOf(userId: ObjectId, deviceId: string): Promise<string | undefined>;
}

export interface ChooseInput {
	userId: ObjectId;
	/** Online computers whose browser is ready (`browseMachinesFor`). */
	ready: BrowseMachine[];
	conversationId?: string;
	/** The model's `machine` argument. */
	hint?: string;
	store?: ChoiceStore;
}

export async function chooseMachine(input: ChooseInput): Promise<MachineChoice> {
	const store = input.store ?? mongoChoiceStore;
	const { userId, ready } = input;
	const byId = (id: string) => ready.find((m) => m.id === id);

	const remembered: Array<{ id: string | undefined; why: "conversation" | "default" }> = [
		{
			id: input.conversationId
				? await store.conversationDevice(userId, input.conversationId)
				: undefined,
			why: "conversation",
		},
		{ id: await store.defaultDevice(userId), why: "default" },
	];
	for (const { id, why } of remembered) {
		if (!id) continue;
		const name = await store.nameOf(userId, id);
		if (name === undefined) continue; // revoked or gone: as if never set
		const machine = byId(id);
		if (machine) return { kind: "use", machine, why };
		return { kind: "error", message: `${name} is offline.` };
	}

	if (ready.length === 0) {
		return { kind: "error", message: "No computer of the user's has a browser ready right now." };
	}
	if (ready.length === 1) return { kind: "use", machine: ready[0], why: "only" };
	const wanted = input.hint?.trim().toLowerCase();
	if (wanted) {
		const named = ready.filter((m) => m.name.toLowerCase() === wanted);
		if (named.length === 1) return { kind: "use", machine: named[0], why: "hint" };
	}
	return { kind: "ask", options: ready };
}

export const mongoChoiceStore: ChoiceStore = {
	async conversationDevice(userId, conversationId) {
		const { ObjectId } = await import("mongodb");
		if (!ObjectId.isValid(conversationId)) return undefined;
		const conversation = await collections.conversations.findOne(
			{ _id: new ObjectId(conversationId), userId },
			{ projection: { browserDeviceId: 1 } }
		);
		if (conversation?.browserDeviceId) return conversation.browserDeviceId;
		const holder = await collections.codeDevices.findOne(
			{ userId, status: "paired", [`browserKept.${conversationId}`]: { $exists: true } },
			{ projection: { _id: 1 } }
		);
		return holder?._id.toString();
	},
	async defaultDevice(userId) {
		const device = await collections.codeDevices.findOne(
			{ userId, status: "paired", browserDefault: true },
			{ projection: { _id: 1 } }
		);
		return device?._id.toString();
	},
	async nameOf(userId, deviceId) {
		const { ObjectId } = await import("mongodb");
		if (!ObjectId.isValid(deviceId)) return undefined;
		const device = await collections.codeDevices.findOne(
			{ _id: new ObjectId(deviceId), userId, status: "paired" },
			{ projection: { name: 1 } }
		);
		return device?.name;
	},
};

/** Remembers the computer a conversation used (a targeted write; a conversation that is not the user's is left alone). */
export async function rememberConversationDevice(
	userId: ObjectId,
	conversationId: string,
	deviceId: string
): Promise<void> {
	const { ObjectId } = await import("mongodb");
	if (!ObjectId.isValid(conversationId)) return;
	await collections.conversations.updateOne(
		{ _id: new ObjectId(conversationId), userId },
		{ $set: { browserDeviceId: deviceId } }
	);
}

/** Makes one computer the user's default for browsing, or clears it with `null`. One per user. */
export async function setDefaultDevice(
	userId: ObjectId,
	deviceId: string | null
): Promise<boolean> {
	const { ObjectId } = await import("mongodb");
	if (deviceId === null) {
		await collections.codeDevices.updateMany(
			{ userId, browserDefault: true },
			{ $unset: { browserDefault: "" } }
		);
		return true;
	}
	if (!ObjectId.isValid(deviceId)) return false;
	const _id = new ObjectId(deviceId);
	const device = await collections.codeDevices.findOne(
		{ _id, userId, status: "paired" },
		{ projection: { _id: 1 } }
	);
	if (!device) return false;
	await collections.codeDevices.updateMany(
		{ userId, browserDefault: true, _id: { $ne: _id } },
		{ $unset: { browserDefault: "" } }
	);
	await collections.codeDevices.updateOne({ _id, userId }, { $set: { browserDefault: true } });
	return true;
}

/** An in-memory store, for tests. */
export function memoryChoiceStore(init: {
	devices: Record<string, string>;
	conversation?: Record<string, string>;
	default?: string;
}): ChoiceStore & { default?: string; conversation: Record<string, string> } {
	const state = { default: init.default, conversation: { ...(init.conversation ?? {}) } };
	return Object.assign(state, {
		async conversationDevice(_userId: ObjectId, conversationId: string) {
			return state.conversation[conversationId];
		},
		async defaultDevice() {
			return state.default;
		},
		async nameOf(_userId: ObjectId, deviceId: string) {
			return init.devices[deviceId];
		},
	});
}
