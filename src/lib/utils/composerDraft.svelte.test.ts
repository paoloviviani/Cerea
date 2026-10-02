import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
	COMPOSER_DRAFT_MAX_CHARS,
	chatDraftKey,
	clearAllComposerDrafts,
	clearComposerDraft,
	codeDraftKey,
	readComposerDraft,
	writeComposerDraft,
} from "./composerDraft";

const PREFIX = "cerea:composer-draft:";

beforeEach(() => {
	for (let i = localStorage.length - 1; i >= 0; i--) {
		const key = localStorage.key(i);
		if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composerDraft keys", () => {
	it("keys chat drafts per conversation, with a home key before one exists", () => {
		expect(chatDraftKey()).toBe(`${PREFIX}chat:home`);
		expect(chatDraftKey(null)).toBe(`${PREFIX}chat:home`);
		expect(chatDraftKey("abc123")).toBe(`${PREFIX}chat:abc123`);
	});

	it("keys agent drafts per device+agent", () => {
		expect(codeDraftKey("d1", "a1")).toBe(`${PREFIX}code:d1:a1`);
		expect(codeDraftKey("d1", "a2")).not.toBe(codeDraftKey("d1", "a1"));
	});
});

describe("composerDraft storage", () => {
	it("round-trips a draft", () => {
		writeComposerDraft(`${PREFIX}chat:x`, "hello unsent");
		expect(readComposerDraft(`${PREFIX}chat:x`)).toBe("hello unsent");
	});

	it("reads null when nothing was stored", () => {
		expect(readComposerDraft(`${PREFIX}chat:missing`)).toBeNull();
	});

	it("keeps each key independent", () => {
		writeComposerDraft(`${PREFIX}chat:a`, "draft A");
		writeComposerDraft(`${PREFIX}chat:b`, "draft B");
		expect(readComposerDraft(`${PREFIX}chat:a`)).toBe("draft A");
		expect(readComposerDraft(`${PREFIX}chat:b`)).toBe("draft B");
	});

	it("clear drops the draft", () => {
		writeComposerDraft(`${PREFIX}chat:x`, "hello");
		clearComposerDraft(`${PREFIX}chat:x`);
		expect(readComposerDraft(`${PREFIX}chat:x`)).toBeNull();
	});

	it("writing an empty draft clears instead of storing nothing", () => {
		writeComposerDraft(`${PREFIX}chat:x`, "hello");
		writeComposerDraft(`${PREFIX}chat:x`, "");
		expect(readComposerDraft(`${PREFIX}chat:x`)).toBeNull();
	});

	it("truncates past the cap instead of refusing the write", () => {
		const long = "x".repeat(COMPOSER_DRAFT_MAX_CHARS + 5000);
		writeComposerDraft(`${PREFIX}chat:x`, long);
		const stored = readComposerDraft(`${PREFIX}chat:x`);
		expect(stored?.length).toBe(COMPOSER_DRAFT_MAX_CHARS);
		expect(long.startsWith(stored ?? "")).toBe(true);
	});

	it("a quota error never throws: the composer keeps working, the draft just is not kept", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("quota exceeded", "QuotaExceededError");
		});
		expect(() => writeComposerDraft(`${PREFIX}chat:x`, "hello")).not.toThrow();
	});

	it("an unreadable store reads as no draft", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		expect(readComposerDraft(`${PREFIX}chat:x`)).toBeNull();
	});

	it("clear never throws either", () => {
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		expect(() => clearComposerDraft(`${PREFIX}chat:x`)).not.toThrow();
	});
});

describe("clearAllComposerDrafts", () => {
	it("drops every draft key and keeps everything else", () => {
		writeComposerDraft(chatDraftKey("home"), "home draft");
		writeComposerDraft(chatDraftKey("abc"), "chat draft");
		writeComposerDraft(codeDraftKey("d1", "a1"), "agent draft");
		localStorage.setItem("theme", "dark");

		clearAllComposerDrafts();

		expect(readComposerDraft(chatDraftKey("home"))).toBeNull();
		expect(readComposerDraft(chatDraftKey("abc"))).toBeNull();
		expect(readComposerDraft(codeDraftKey("d1", "a1"))).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
	});

	it("never throws when storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		expect(() => clearAllComposerDrafts()).not.toThrow();
	});
});
