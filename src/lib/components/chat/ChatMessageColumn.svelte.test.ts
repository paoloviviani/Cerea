import { describe, it, expect, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessageColumnTestHost from "./ChatMessageColumnTestHost.svelte";
import type { Message } from "$lib/types/Message";

const user = (id: string, text: string): Message => ({
	id,
	from: "user",
	content: text,
	children: [],
});
const assistant = (id: string, text: string): Message => ({
	id,
	from: "assistant",
	content: text,
	children: [],
});

/** Long enough that a 320px column scrolls several screens. */
const long = (label: string) =>
	Array.from({ length: 40 }, (_, i) => `${label} line ${i + 1}`).join("\n");

function scroller(container: HTMLElement): HTMLElement {
	const el = container.querySelector('[aria-label="Conversation messages"]');
	if (!(el instanceof HTMLElement)) throw new Error("no scroll container");
	return el;
}

async function settled(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("the column's history-paging surface", () => {
	it("fires onScrollNearTop when the reader reaches the top, and not halfway down", async () => {
		const onNearTop = vi.fn();
		const view = renderWithApp(ChatMessageColumnTestHost, {
			initial: [user("u1", long("first prompt")), assistant("a1", long("first answer"))],
			page: [],
			onNearTop,
		});
		const el = scroller(view.container);
		await settled();

		el.scrollTop = el.scrollHeight;
		el.dispatchEvent(new Event("scroll"));
		await settled();
		expect(onNearTop).not.toHaveBeenCalled();

		el.scrollTop = 0;
		el.dispatchEvent(new Event("scroll"));
		await settled();
		expect(onNearTop).toHaveBeenCalled();
	});

	it("prepends the page above the transcript and holds the visible message where it was", async () => {
		const view = renderWithApp(ChatMessageColumnTestHost, {
			initial: [user("u2", long("second prompt")), assistant("a2", long("second answer"))],
			page: [user("u1", long("first prompt")), assistant("a1", long("first answer"))],
			onNearTop: () => {},
		});
		const el = scroller(view.container);
		await settled();

		// Mid-transcript, on the second prompt: the position the prepend
		// must preserve. Scrolled with a wheel gesture behind it, as a
		// reader would: the scroll controller undoes a gesture-less jump
		// as a browser clamp while the fresh DOM is still "active".
		const anchor = view.container.querySelector('[data-message-id="u2"]');
		if (!(anchor instanceof HTMLElement)) throw new Error("no anchor message");
		el.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true, cancelable: true }));
		el.scrollTop = 200;
		await settled();
		const before = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
		const topBefore = el.scrollTop;
		const heightBefore = el.scrollHeight;

		const host = view.component as unknown as {
			prependPage(): void;
			messageCount(): number;
		};
		host.prependPage();
		await settled();

		expect(host.messageCount()).toBe(4);
		// The page's own messages landed above.
		expect(view.container.querySelector('[data-message-id="u1"]')).not.toBeNull();
		// The visible message did not move… (re-queried: the turn
		// regrouping recreates message nodes across the boundary.)
		const anchorAfter = view.container.querySelector('[data-message-id="u2"]');
		if (!(anchorAfter instanceof HTMLElement)) throw new Error("anchor message lost");
		const after = anchorAfter.getBoundingClientRect().top - el.getBoundingClientRect().top;
		expect(Math.abs(after - before)).toBeLessThan(2);
		// …because the scroll position grew by the height added (up to the
		// settle follower's pixel rounding).
		expect(Math.abs(el.scrollTop - topBefore - (el.scrollHeight - heightBefore))).toBeLessThan(2);
	});
});
