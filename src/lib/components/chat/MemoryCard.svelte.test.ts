/** The memory card names where a write went, and its undo calls that list's own route. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import MemoryCard from "./MemoryCard.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { MessageUpdateType, type MessageMemoryUpdate } from "$lib/types/MessageUpdate";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const update = (extra: Partial<MessageMemoryUpdate>): MessageMemoryUpdate => ({
	type: MessageUpdateType.Memory,
	uuid: "u1",
	action: "remembered",
	text: "Use metric units.",
	memoryId: "m1",
	...extra,
});

async function undoCalls(extra: Partial<MessageMemoryUpdate>) {
	const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
	vi.stubGlobal("fetch", fetchMock);
	renderWithApp(MemoryCard, { update: update(extra) });
	const undo = [...document.querySelectorAll("button")].find((b) =>
		b.textContent?.includes("Undo")
	);
	if (!undo) throw new Error("no undo button");
	await userEvent.click(undo);
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
	return String((fetchMock.mock.calls[0] as unknown[])[0]);
}

describe("MemoryCard scopes", () => {
	it("says where a chat note went, and undoes through the chat's route", async () => {
		const url = await undoCalls({ scope: "conversation", conversationId: "c1" });
		expect(document.body.textContent).toContain("in this chat's notes");
		expect(url).toContain("/api/v2/conversations/c1/memory/m1");
	});

	it("undoes a project note through the project's route", async () => {
		const url = await undoCalls({ scope: "project", projectId: "p1" });
		expect(document.body.textContent).toContain("in the project's notes");
		expect(url).toContain("/api/v2/projects/p1/memory/m1");
	});

	it("undoes a global note, and an old card with no scope, through personal memory", async () => {
		const url = await undoCalls({ scope: "global" });
		expect(document.body.textContent).toContain("in your memory, for every chat");
		expect(url).toMatch(/\/api\/v2\/memory\/m1$/);
		document.body.innerHTML = "";
		expect(await undoCalls({})).toMatch(/\/api\/v2\/memory\/m1$/);
	});
});
