import { describe, it, expect, vi } from "vitest";
import { markdownPoolReady } from "$lib/utils/markdownWorkerPool";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessageColumnTestHost from "./ChatMessageColumnTestHost.svelte";
import type { Message } from "$lib/types/Message";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

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

// A cold or busy markdown worker answers late (CI's does). Every render result
// arrives this long after it was asked for, so the column is exercised the way
// a slow worker would show it, whatever the machine running the test. The mock
// also records which render each client is still waiting for, so a test can wait
// for the real event (every message holds its rendered blocks) instead of a
// guessed pause.
const waiting = vi.hoisted(() => new Map<number, number>());
vi.mock("$lib/utils/markdownWorkerPool", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/utils/markdownWorkerPool")>();
	return {
		...actual,
		renderMarkdownBlocks: (...args: Parameters<typeof actual.renderMarkdownBlocks>) => {
			const [clientId, content, sources, streaming, onResult] = args;
			const requestId = actual.renderMarkdownBlocks(
				clientId,
				content,
				sources,
				streaming,
				(blocks, id) => {
					setTimeout(() => {
						onResult(blocks, id);
						if (waiting.get(clientId) === id) waiting.delete(clientId);
					}, 150);
				}
			);
			waiting.set(clientId, requestId);
			return requestId;
		},
		cancelMarkdownClient: (clientId: number) => {
			waiting.delete(clientId);
			actual.cancelMarkdownClient(clientId);
		},
	};
});

/** Resolves once the markdown worker is up and every message on screen has its
 * rendered blocks (no render still outstanding), then lets the layout settle
 * for a couple of frames. A cold worker takes the better part of a second to
 * boot, so the first renders land long after a fixed pause would have ended. */
async function rested(el: HTMLElement): Promise<void> {
	await markdownPoolReady();
	await vi.waitFor(() => expect(waiting.size).toBe(0), { timeout: 20_000 });
	let last = -1;
	for (let still = 0; still < 3;) {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		if (el.scrollHeight === last) still += 1;
		else {
			last = el.scrollHeight;
			still = 0;
		}
	}
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
		// Measure only once the initial messages have their rendered markdown:
		// the swap from the fallback adds ~10px below the anchor, and a swap
		// landing between the "before" and "after" measurements (a cold worker
		// finishing booting) reads as the position not following the height.
		await rested(el);

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
		// Tag the existing messages' nodes: a prepend must insert new DOM above
		// and leave these components alone (no remount, so no flash back to the
		// light markdown and no height swap below the reader).
		const tagged = ["u2", "a2"].map((id) => {
			const node = view.container.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
			(node as HTMLElement & { __tag?: string }).__tag = id;
			return node;
		});
		host.prependPage();
		// At rest: the prepended messages' own markdown swap lands over the
		// following frames, and a check taken between a swap and the column's
		// same-frame correction would see the transient, not the outcome.
		await rested(el);
		for (const node of tagged) {
			const id = (node as HTMLElement & { __tag?: string }).__tag as string;
			expect(view.container.querySelector(`[data-message-id="${id}"]`)).toBe(node);
		}

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

	it("keeps holding the visible message when a prepended message grows after the heights first rested", async () => {
		const view = renderWithApp(ChatMessageColumnTestHost, {
			initial: [user("u2", long("second prompt")), assistant("a2", long("second answer"))],
			page: [user("u1", long("first prompt")), assistant("a1", long("first answer"))],
			onNearTop: () => {},
		});
		const el = scroller(view.container);
		await rested(el);
		const anchor = view.container.querySelector('[data-message-id="u2"]');
		if (!(anchor instanceof HTMLElement)) throw new Error("no anchor message");
		el.dispatchEvent(new WheelEvent("wheel", { deltaY: -500, bubbles: true, cancelable: true }));
		el.scrollTop = 200;
		await settled();
		const before = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top;
		const host = view.component as unknown as { prependPage(): void };
		host.prependPage();
		await settled();

		// A prepended message's rendered markdown lands late and taller than
		// its fallback. Observers run in creation order within a frame, so one
		// registered here sees the column's own correction already applied:
		// the anchor must not have moved by the time the frame can paint.
		const first = view.container.querySelector('[data-message-id="u1"]');
		const anchorNow = view.container.querySelector('[data-message-id="u2"]');
		const content = first_wrapper(el);
		if (!(first instanceof HTMLElement) || !(anchorNow instanceof HTMLElement) || !content) {
			throw new Error("no messages");
		}
		let painted = Number.NaN;
		const probe = new ResizeObserver(() => {
			painted = anchorNow.getBoundingClientRect().top - el.getBoundingClientRect().top;
		});
		probe.observe(content);
		// Past the point where heights first came to rest (a cold worker can
		// answer well after that).
		await new Promise((r) => setTimeout(r, 900));
		// Native scroll anchoring absorbs growth only in part in real
		// browsers; switch it off so the column's own hold is what is measured.
		el.style.overflowAnchor = "none";
		first.style.paddingBottom = "37px";
		await new Promise((r) => setTimeout(r, 100));
		probe.disconnect();
		expect(Number.isNaN(painted)).toBe(false);
		expect(Math.abs(painted - before)).toBeLessThan(2);
	});
});

describe("the column's failed-turn banners", () => {
	it("starts only the most recent failed turn's banner expanded", async () => {
		const failed = (id: string, reason: string): Message => ({
			id,
			from: "assistant",
			content: "",
			children: [],
			updates: [{ type: MessageUpdateType.TurnState, state: "failed", serverNow: 0, reason }],
		});
		const view = renderWithApp(ChatMessageColumnTestHost, {
			initial: [
				user("u1", "first prompt"),
				failed("a1", "first failure: the provider's credits ran out"),
				user("u2", "again"),
				failed("a2", "second failure: still exhausted"),
			],
			page: [],
		});
		await settled();

		const banners = view.container.querySelectorAll('[data-testid="turn-failed-reason"]');
		expect(banners).toHaveLength(2);
		const expanded = [...banners].filter(
			(b) =>
				b.querySelector('[data-testid="turn-failed-toggle"]')?.getAttribute("aria-expanded") ===
				"true"
		);
		expect(expanded).toHaveLength(1);
		// The open one is the newest failure; the older one keeps its whole
		// reason in the collapsed line's tooltip.
		expect(expanded[0]?.querySelector("span")?.getAttribute("title")).toBe(
			"second failure: still exhausted"
		);
		const older = view.container.querySelector('[data-testid="turn-failed-reason"]');
		expect(older?.querySelector("span")?.getAttribute("title")).toBe(
			"first failure: the provider's credits ran out"
		);
		expect(
			older?.querySelector('[data-testid="turn-failed-toggle"]')?.getAttribute("aria-expanded")
		).toBe("false");
	});
});

/** The element wrapping every turn: the one whose height follows the transcript's. */
function first_wrapper(scrollEl: HTMLElement): HTMLElement | null {
	const msg = scrollEl.querySelector("[data-message-id]");
	for (let n = msg?.parentElement; n && n !== scrollEl; n = n.parentElement) {
		if (n.parentElement === scrollEl || n.parentElement?.parentElement === scrollEl) return n;
	}
	return null;
}
