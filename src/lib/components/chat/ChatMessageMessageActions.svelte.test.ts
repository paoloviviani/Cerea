/**
 * The assistant footer's per-message actions: chat itself passes neither
 * `messageActions` nor its visibility rule, so its footer is exactly what it
 * always was; the /code panel passes both and decides from its own facts
 * (`AgentView`'s forkable messages). Without the rule, the footer falls back
 * to the message's own turn state — the reading the footer always used.
 */
import ChatMessage from "./ChatMessage.svelte";
import { render } from "vitest-browser-svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it } from "vitest";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

const message = (state?: "running" | "done") => ({
	id: "m1",
	from: "assistant",
	content: "an answer",
	children: [],
	...(state ? { updates: [{ type: MessageUpdateType.TurnState, state, serverNow: 0 }] } : {}),
});

const forkSnippet = createRawSnippet(() => ({
	render: () => '<button aria-label="Fork from here" type="button">Fork</button>',
	setup: () => {},
}));

const mount = (props: Record<string, unknown>) =>
	render(ChatMessage, {
		message: message(),
		loading: false,
		isAuthor: true,
		readOnly: false,
		...props,
	} as never);

const forkButton = (view: { baseElement: HTMLElement }) =>
	view.baseElement.querySelector<HTMLButtonElement>('button[aria-label="Fork from here"]');

describe("ChatMessage's per-message actions", () => {
	it("chat passes no actions, and no action renders", async () => {
		const view = mount({ message: message("done") });
		expect(forkButton(view)).toBeNull();
	});

	it("without a visibility rule, the footer falls back to the message's own turn state", async () => {
		const done = mount({ messageActions: forkSnippet, message: message("done") });
		await expect.element(done.getByRole("button", { name: "Fork from here" })).toBeVisible();
		done.unmount();

		const running = mount({ messageActions: forkSnippet, message: message("running") });
		expect(forkButton(running)).toBeNull();
	});

	it("the visibility rule decides when the caller gives one", async () => {
		const refused = mount({
			messageActions: forkSnippet,
			messageActionsWhen: () => false,
			message: message("done"),
		});
		expect(forkButton(refused)).toBeNull();
		refused.unmount();

		const offered = mount({
			messageActions: forkSnippet,
			messageActionsWhen: () => true,
			message: message(),
		});
		await expect.element(offered.getByRole("button", { name: "Fork from here" })).toBeVisible();
	});
});
