import { beforeEach, describe, expect, it } from "vitest";
import type { Message } from "$lib/types/Message";
import {
	TRANSCRIPT_CACHE_MESSAGES,
	TRANSCRIPT_CACHE_SESSIONS,
	clearTranscripts,
	dropTranscript,
	forgetTranscript,
	getTranscript,
	putTranscript,
	transcriptKey,
	type TranscriptSnapshot,
} from "./agentTranscriptCache";

const msg = (n: number): Message =>
	({
		id: `m${n}`,
		from: n % 2 ? "assistant" : "user",
		content: `c${n}`,
		machineMessageId: `mm${n}`,
	}) as Message;

const snap = (count: number, extra: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot => ({
	messages: Array.from({ length: count }, (_, i) => msg(i)),
	hasMore: false,
	before: null,
	usage: null,
	lastCompaction: null,
	...extra,
});

beforeEach(() => clearTranscripts());

describe("agentTranscriptCache", () => {
	it("keys by device and agent", () => {
		expect(transcriptKey("d1", "a1")).toBe("d1:a1");
	});

	it("returns what was stored and misses on an unknown key", () => {
		putTranscript("d:a", snap(3, { hasMore: true, before: "x" }));
		const hit = getTranscript("d:a");
		expect(hit?.messages).toHaveLength(3);
		expect(hit?.hasMore).toBe(true);
		expect(hit?.before).toBe("x");
		expect(getTranscript("d:b")).toBeUndefined();
	});

	it("keeps only the last 8 sessions, evicting the least recently used", () => {
		for (let i = 0; i < TRANSCRIPT_CACHE_SESSIONS; i += 1) putTranscript(`d:${i}`, snap(2));
		// Touch 0 so 1 is the oldest.
		getTranscript("d:0");
		putTranscript("d:new", snap(2));
		expect(getTranscript("d:1")).toBeUndefined();
		expect(getTranscript("d:0")).toBeDefined();
		expect(getTranscript("d:new")).toBeDefined();
	});

	it("trims a long transcript to the newest messages and marks older ones", () => {
		putTranscript("d:a", snap(TRANSCRIPT_CACHE_MESSAGES + 25));
		const hit = getTranscript("d:a");
		expect(hit?.messages).toHaveLength(TRANSCRIPT_CACHE_MESSAGES);
		expect(hit?.messages.at(-1)?.id).toBe(`m${TRANSCRIPT_CACHE_MESSAGES + 24}`);
		expect(hit?.hasMore).toBe(true);
		expect(hit?.before).toBe("mm25");
	});

	it("does not keep an empty transcript, and clears a previous entry for it", () => {
		putTranscript("d:a", snap(2));
		putTranscript("d:a", snap(0));
		expect(getTranscript("d:a")).toBeUndefined();
	});

	it("drops one entry, and a forgotten session cannot come back", () => {
		putTranscript("d:a", snap(2));
		putTranscript("d:b", snap(2));
		dropTranscript("d:a");
		expect(getTranscript("d:a")).toBeUndefined();
		forgetTranscript("d:b");
		putTranscript("d:b", snap(2));
		expect(getTranscript("d:b")).toBeUndefined();
	});

	it("clears everything", () => {
		putTranscript("d:a", snap(2));
		clearTranscripts();
		expect(getTranscript("d:a")).toBeUndefined();
	});
});
