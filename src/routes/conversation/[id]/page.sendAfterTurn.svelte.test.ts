import ConversationPage from "./+page.svelte";
import { renderWithApp, appNavigation, setPage } from "$lib/components/__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { newConversationsStore, CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";
import { PARENT_NOT_FOUND_MESSAGE } from "$lib/utils/sendRefusals";

/**
 * A send made right after a turn: the page still holds the ids it minted for the optimistic
 * messages until its post-turn refresh lands. The send waits for that refresh and names the
 * server's id; a 409 from the server is answered by one refresh and one re-send.
 */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/stores/mcpServers", async () => {
	const { writable, derived } = await import("svelte/store");
	const { vi } = await import("vitest");
	const allMcpServers = writable([]);
	const selectedServerIds = writable(new Set<string>());
	const enabledServers = derived([allMcpServers, selectedServerIds], ([$a, $s]) =>
		($a as { id: string }[]).filter((s) => ($s as Set<string>).has(s.id))
	);
	return {
		allMcpServers,
		selectedServerIds,
		enabledServers,
		enabledServersCount: derived(enabledServers, ($enabled) => ($enabled as unknown[]).length),
		mcpServersLoaded: writable(true),
		toggleServer: vi.fn(),
		disableAllServers: vi.fn(),
		healthCheckServer: vi.fn(async () => ({ status: "unknown" })),
	};
});
vi.mock("$lib/stores/mcpConnectors", async () => {
	const { writable, derived } = await import("svelte/store");
	const { vi } = await import("vitest");
	const connectors = writable([]);
	const selectedConnectorIds = writable(new Set<string>());
	const enabledConnectors = derived([connectors, selectedConnectorIds], ([$a, $s]) =>
		($a as { id: string }[]).filter((c) => ($s as Set<string>).has(c.id))
	);
	return {
		connectors,
		connectorsLoaded: writable(true),
		connectorsFailed: writable(false),
		selectedConnectorIds,
		enabledConnectors,
		enabledConnectorsCount: derived(enabledConnectors, ($e) => ($e as unknown[]).length),
		totalEnabledMcpCount: derived(enabledConnectors, () => 0),
		refreshConnectors: vi.fn(async () => {}),
		toggleConnector: vi.fn(),
		disableAllConnectors: vi.fn(),
		selectConnector: vi.fn(),
		migrateCustomServers: vi.fn(async () => 0),
		addConnector: vi.fn(async () => ({})),
	};
});

const model = { id: "m", name: "M", displayName: "M", providers: [] } as never;
const t = new Date();
const msg = (
	id: string,
	from: string,
	content: string,
	ancestors: string[],
	children: string[]
) => ({
	id,
	from,
	content,
	ancestors,
	children,
	createdAt: t,
	updatedAt: t,
	...(from === "assistant"
		? {
				updates: [
					{ type: "finalAnswer", text: content },
					{ type: "status", status: "finished" },
				],
			}
		: {}),
});
// What the server holds after the first turn, in its own ids.
const serverTree = (second = false) => [
	msg("u0", "user", "one", [], ["a0"]),
	msg("a0", "assistant", "first answer", ["u0"], second ? ["u1"] : []),
	...(second
		? [
				msg("u1", "user", "two", ["u0", "a0"], ["a1"]),
				msg("a1", "assistant", "second answer", ["u0", "a0", "u1"], []),
			]
		: []),
];
const dataFor = (messages: unknown[]) => ({
	models: [model],
	oldModels: [],
	model: "m",
	title: "Chat",
	messages,
	rootMessageId: "u0",
	knowledgeBases: [],
	prunedArtifactVersions: [],
	turnState: null,
});
const streamOf = (text: string) =>
	new Response(
		new ReadableStream({
			start(controller) {
				for (const update of [
					{ type: "stream", token: text },
					{ type: "finalAnswer", text, interrupted: false },
					{ type: "status", status: "finished" },
				])
					controller.enqueue(new TextEncoder().encode(JSON.stringify(update) + "\n"));
				controller.close();
			},
		}),
		{ headers: { "Content-Type": "application/jsonl" } }
	);

type Post = {
	id?: string;
	inputs?: string;
	is_retry?: boolean;
	userMessageId?: string;
	assistantMessageId?: string;
};
let posts: Post[];
let respond: (post: Post) => Response;

beforeEach(() => {
	posts = [];
	respond = () => streamOf("ok");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/conversation/c1") && init?.method === "POST") {
				const post = JSON.parse(String((init.body as FormData).get("data"))) as Post;
				posts.push(post);
				return respond(post);
			}
			return new Response("{}", { status: 200 });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
	await (browserPage as unknown as { viewport: (w: number, h: number) => Promise<void> }).viewport(
		1280,
		800
	);
	setPage({ params: { id: "c1" }, route: { id: "/conversation/[id]" }, data: {} });
	const store = newConversationsStore();
	store.prepend({ id: "c1", title: "Chat", model: "m", updatedAt: new Date() });
	const settings = writable({ directPaste: false, activeModel: "m" });
	const screen = renderWithApp(ConversationPage, { data: dataFor(serverTree()) } as never, {
		page: { params: { id: "c1" }, route: { id: "/conversation/[id]" }, data: {} },
		context: new Map<unknown, unknown>([
			["settings", settings],
			[CONVERSATIONS_CONTEXT_KEY, store],
		]),
	});
	const box = () => screen.container.querySelector("textarea") as HTMLTextAreaElement;
	const type = (text: string) => {
		box().focus();
		box().value = text;
		box().dispatchEvent(new Event("input", { bubbles: true }));
		box().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	};
	return { screen, box, type };
}

/** Holds the post-turn refresh until `release` hands the page the server's tree. */
function holdRefresh(screen: { rerender: (props: never) => unknown }) {
	let release: () => void = () => {};
	appNavigation().invalidate.mockImplementation(
		() =>
			new Promise<undefined>((resolve) => {
				release = () => {
					void screen.rerender({ data: dataFor(serverTree(true)) } as never);
					resolve(undefined);
				};
			})
	);
	return () => release();
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a send right after a turn", () => {
	it("waits for the refresh and names the server's id, once, even on a second Enter", async () => {
		const { screen, type } = await mount();
		const release = holdRefresh(screen);
		type("two");
		await vi.waitFor(() => expect(appNavigation().invalidate).toHaveBeenCalled());
		expect(posts.map((post) => post.id)).toEqual(["a0"]);
		type("three");
		type("three");
		await settle();
		expect(posts).toHaveLength(1);
		release();
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		// Under the server's last assistant, not the id this tab minted for it.
		expect(posts[1]).toMatchObject({ inputs: "three", id: "a1" });
		await settle(300);
		expect(posts).toHaveLength(2);
		screen.unmount();
	});

	it("a Stop then an immediate send also waits for the refresh", async () => {
		const { screen, type } = await mount();
		const release = holdRefresh(screen);
		let end: () => void = () => {};
		respond = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						end = () => controller.close();
						controller.enqueue(
							new TextEncoder().encode(JSON.stringify({ type: "stream", token: "partial" }) + "\n")
						);
					},
				}),
				{ headers: { "Content-Type": "application/jsonl" } }
			);
		type("two");
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		const stop = await vi.waitFor(() => {
			const button = screen.container.querySelector(".stop-generating-btn");
			if (!button) throw new Error("no stop button yet");
			return button as HTMLButtonElement;
		});
		stop.click();
		end();
		await vi.waitFor(() => expect(appNavigation().invalidate).toHaveBeenCalled(), {
			timeout: 8000,
		});
		respond = () => streamOf("ok");
		type("three");
		await settle();
		expect(posts).toHaveLength(1);
		release();
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1].id).toBe("a1");
		screen.unmount();
	});

	it("a Retry clicked in the gap retries the message it was clicked on", async () => {
		const { screen, type } = await mount();
		const release = holdRefresh(screen);
		type("two");
		await vi.waitFor(() => expect(appNavigation().invalidate).toHaveBeenCalled());
		const retries = screen.container.querySelectorAll('[data-testid="msg-action-retry"]');
		(retries[retries.length - 1] as HTMLButtonElement).click();
		await settle();
		expect(posts).toHaveLength(1);
		release();
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1]).toMatchObject({ is_retry: true, id: "a1" });
		screen.unmount();
	});

	it("re-sends exactly once after a 409", async () => {
		const { screen, type } = await mount();
		let first = true;
		respond = () => {
			if (first) {
				first = false;
				return Response.json({ message: PARENT_NOT_FOUND_MESSAGE }, { status: 409 });
			}
			return streamOf("ok");
		};
		type("two");
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1].inputs).toBe("two");
		await settle(300);
		expect(posts).toHaveLength(2);
		screen.unmount();
	});

	it("shows the error and keeps the draft when the re-send is refused too", async () => {
		const { screen, type, box } = await mount();
		respond = () => Response.json({ message: PARENT_NOT_FOUND_MESSAGE }, { status: 409 });
		type("two");
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		await vi.waitFor(() => expect(box().value).toBe("two"));
		await settle(300);
		expect(posts).toHaveLength(2);
		screen.unmount();
	});
});

/** The tree the server holds after "two", stored under exactly the ids the tab proposed. */
const treeWithProposed = (userId: string, assistantId: string) => [
	msg("u0", "user", "one", [], ["a0"]),
	msg("a0", "assistant", "first answer", ["u0"], [userId]),
	msg(userId, "user", "two", ["u0", "a0"], [assistantId]),
	msg(assistantId, "assistant", "ok", ["u0", "a0", userId], []),
];

describe("client-proposed message ids (C156)", () => {
	it("sends the ids it minted, and the next send needs no swap after the refresh", async () => {
		const { screen, type } = await mount();
		let proposed: { user: string; assistant: string } | undefined;
		appNavigation().invalidate.mockImplementation(async () => {
			proposed = {
				user: posts[0].userMessageId ?? "",
				assistant: posts[0].assistantMessageId ?? "",
			};
			await screen.rerender({
				data: dataFor(treeWithProposed(proposed.user, proposed.assistant)),
			} as never);
			return undefined;
		});
		type("two");
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		expect(posts[0].userMessageId).toMatch(v4);
		expect(posts[0].assistantMessageId).toMatch(v4);
		expect(posts[0].userMessageId).not.toBe(posts[0].assistantMessageId);
		await vi.waitFor(() => expect(proposed).toBeDefined());
		await settle();
		type("three");
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		// The parent is the id held before the refresh and after it: the same one.
		expect(posts[1]).toMatchObject({ inputs: "three", id: proposed?.assistant });
		await settle(300);
		expect(posts).toHaveLength(2);
		screen.unmount();
	});

	it("a Retry right after a reply names the same assistant id and proposes a new one", async () => {
		const { screen, type } = await mount();
		appNavigation().invalidate.mockImplementation(async () => {
			await screen.rerender({
				data: dataFor(
					treeWithProposed(posts[0].userMessageId ?? "", posts[0].assistantMessageId ?? "")
				),
			} as never);
			return undefined;
		});
		type("two");
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		await settle();
		const retries = screen.container.querySelectorAll('[data-testid="msg-action-retry"]');
		(retries[retries.length - 1] as HTMLButtonElement).click();
		await vi.waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1]).toMatchObject({ is_retry: true, id: posts[0].assistantMessageId });
		expect(posts[1].assistantMessageId).toBeDefined();
		expect(posts[1].assistantMessageId).not.toBe(posts[0].assistantMessageId);
		expect(posts[1].userMessageId).toBeUndefined();
		await settle(300);
		expect(posts).toHaveLength(2);
		screen.unmount();
	});
});
