import { afterEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { newConversationsStore } from "./conversations.svelte";

describe("conversationsStore.refresh", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("keeps each chat's project, so the Chats branch can leave project chats out", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						superjson.stringify({
							conversations: [
								{ _id: "a", title: "loose chat", updatedAt: "2026-10-07T10:00:00Z" },
								{
									_id: "b",
									title: "project chat",
									updatedAt: "2026-10-07T09:00:00Z",
									projectId: "p1",
								},
							],
							hasMore: false,
						}),
						{ headers: { "content-type": "application/json" } }
					)
			)
		);
		const store = newConversationsStore();
		await store.refresh();

		expect(store.list.map((c) => [c.id, c.projectId])).toEqual([
			["a", undefined],
			["b", "p1"],
		]);
	});
});
