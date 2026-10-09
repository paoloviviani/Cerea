/**
 * Opening a long agent session (the owner's orchestrator: 1,220 messages,
 * ~4,600 parts) must show a loading state while the transcript snapshot
 * folds, then land at the NEWEST message — never render progressively from
 * the top, and never strand the reader up there because they scrolled while
 * waiting. Hermetic: a `FakeMachine` (the terminal spec's setup) whose
 * seeded transcript holds ~300 messages, so what runs is the real path —
 * `session.sync` → the SSE bridge → `consumeAgentUpdates` → the column —
 * at a size a person feels.
 *
 * The renderer is CPU-throttled through CDP (chromium) to stand in for the
 * phone this was reported on: unthrottled, a desktop folds the snapshot
 * faster than a person can react, and main's stick-to-bottom happens to
 * catch up at the end. Throttled, the fold takes seconds — long enough that
 * a scroll attempt lands mid-load, which is exactly the reflex this fix has
 * to absorb: on the fixed build the skeleton leaves nothing to scroll, so
 * the landing is untouched; without it the scroll detaches the pin mid-fold
 * and the view is stranded where the person left it.
 */
import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";
import type { Part, Transcript } from "../src/lib/types/machineProtocol";

/** The fake machine's `session.sync` is stalled this long, so the loading
 * state has a window a headless run cannot miss. */
const SYNC_DELAY_MS = 400;
/** CDP CPU throttling rate (1 = off): the fold of a long snapshot on a
 * phone-shaped budget. */
const CPU_THROTTLE = 4;
const TURNS = 150; // 300 messages

async function connectFakeMachine(sub: string, name: string): Promise<FakeMachine> {
	const res = await fetch(`${MOCK_OIDC_ISSUER}/__control/mint`, {
		method: "POST",
		body: JSON.stringify({ sub }),
	});
	const { access_token: token } = (await res.json()) as { access_token: string };
	const fake = new FakeMachine(
		`${E2E_APP_URL.replace(/^http/, "ws")}/api/v2/code/machine`,
		{
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": randomUUID(),
			"x-pystino-machine-name": name,
		},
		{ policy: { workspaceRoots: [], allowFreeModels: false } }
	);
	await fake.hello();
	return fake;
}

async function pairAndStartSession(page: Page, name: string) {
	await page.goto(`${E2E_APP_BASE}/code`);
	await page.getByRole("button", { name: "Agents", exact: true }).click();
	await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
	await page.getByRole("button", { name: "Confirm this machine" }).click();
	await page.getByRole("button", { name: "Add a workspace to this device" }).click();
	await page.getByLabel("Directory on the machine").fill("/repo");
	await page.getByLabel("Title (optional)").fill("repo");
	await page.getByRole("dialog").getByRole("button", { name: "Add workspace" }).click();
	await expect(page.getByText("repo", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Start a coding session in this workspace" }).click();
	await page.getByRole("button", { name: "Build" }).click();
	await page.getByRole("button", { name: "Create agent" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** A transcript of `turns` user/assistant exchanges: a prompt, then an
 * answer with a completed tool call — the shape and the frames-per-message
 * ratio of a real coding session (the reported one: ~3.8 parts/message). */
function seededTranscript(turns: number): Transcript {
	const messages: Transcript["messages"] = [];
	const filler = (i: number) => `Message number ${i} of the long session. `.repeat(6);
	for (let i = 1; i <= turns; i += 1) {
		messages.push({
			message: {
				id: `msg_u_${i}`,
				role: "user",
				createdAt: new Date(i * 1000).toISOString(),
				clientMessageId: `c_${i}`,
			},
			parts: [
				{
					id: `part_u_${i}`,
					messageId: `msg_u_${i}`,
					role: "user",
					type: "text",
					text: `prompt ${i}: ${filler(i)}`,
				},
			],
		});
		const parts: Part[] = [
			{
				id: `part_a_${i}`,
				messageId: `msg_a_${i}`,
				role: "assistant",
				type: "text",
				text: `answer ${i}: ${filler(i)}`,
			},
			{
				id: `part_t_${i}`,
				messageId: `msg_a_${i}`,
				role: "assistant",
				type: "tool",
				callId: `call_${i}`,
				tool: "bash",
				status: "completed",
				input: { command: "ls" },
				output: "a.txt",
			},
		];
		messages.push({
			message: {
				id: `msg_a_${i}`,
				role: "assistant",
				createdAt: new Date(i * 1000 + 1).toISOString(),
			},
			parts,
		});
	}
	return { messages, permissions: [], status: "idle", usage: null, todos: [] };
}

/** Whether any text node carrying `needle` sits inside the scroll
 * container's viewport, wherever markdown split the runs. */
async function textInViewport(page: Page, needle: string): Promise<boolean> {
	return page.evaluate(
		([text]) => {
			const scroller = document.querySelector('[aria-label="Conversation messages"]');
			if (!scroller) return false;
			const box = scroller.getBoundingClientRect();
			const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node) {
				if (node.textContent?.includes(text)) {
					const el = node.parentElement;
					if (!el) return false;
					const rect = el.getBoundingClientRect();
					if (rect.bottom > box.top && rect.top < box.bottom) return true;
				}
				node = walker.nextNode();
			}
			return false;
		},
		[needle]
	);
}

test.describe("opening a long agent session", () => {
	let fake: FakeMachine | null = null;
	let cdp: CDPSession | null = null;

	test.afterEach(async ({ page }) => {
		// The throttle outlives the navigation unless reset; the context is
		// torn down anyway, but an explicit reset keeps a retry honest.
		if (cdp) {
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
		}
		fake?.close();
		fake = null;
		cdp = null;
		await page.close().catch(() => {});
	});

	test("shows a loading state, then lands at the newest message, not the top", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `long-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		// The session the tree just created, seeded with a long transcript
		// and a stalled `session.sync` (the machine reads its log).
		const machine = fake;
		if (!machine) throw new Error("the fake machine was closed early");
		const created = machine.model.sessions.at(-1);
		if (!created) throw new Error("the pair flow created no session");
		const sessionId = created.id;
		const snapshot = seededTranscript(TURNS);
		machine.model.transcripts.set(sessionId, snapshot);
		const empty: Transcript = {
			messages: [],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		};
		machine.onOp("session.sync", async (args: { sessionId: string }) => {
			if (args.sessionId !== sessionId) {
				return {
					epoch: machine.model.epoch,
					seq: machine.model.seq.get(args.sessionId) ?? 0,
					snapshot: empty,
				};
			}
			await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
			return {
				epoch: machine.model.epoch,
				seq: machine.model.seq.get(sessionId) ?? 0,
				snapshot,
			};
		});

		// Phone-shaped renderer, from here on (the pairing flow ran at full
		// speed). WebKit has no CDP; there the test simply runs unthrottled.
		try {
			cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
		} catch {
			cdp = null;
		}

		await page.goto(`${E2E_APP_BASE}/code?device=${fake.deviceId}&agent=${sessionId}`);

		// Whichever comes first: the loading state (the fix), or — without
		// it — the transcript's first message rendering in from the top
		// mid-fold. Either way the person has something on screen, and this
		// is the moment their reflex fires.
		await expect(
			page.getByTestId("transcript-loading").or(page.getByText("prompt 1:"))
		).toBeVisible({ timeout: 30_000 });
		// The load must say so: while the snapshot folds, the pane shows the
		// loading state, not a half-built transcript or an empty-session
		// introduction.
		await expect(page.getByTestId("transcript-loading")).toBeVisible({ timeout: 5_000 });
		// The reflex: scroll while the load is still going. On the fixed
		// build this is a no-op (the skeleton cannot scroll); without the
		// fix it detaches the pin mid-fold and strands the view.
		await page.mouse.wheel(0, -600);

		// The transcript lands: the newest message on screen, the first one
		// above the fold — opened at the bottom, not the top.
		await expect(page.getByText("answer 150:")).toBeVisible({ timeout: 45_000 });
		await expect(page.getByTestId("transcript-loading")).toHaveCount(0);
		await expect.poll(() => textInViewport(page, "prompt 1:"), { timeout: 15_000 }).toBe(false);
		await expect.poll(() => textInViewport(page, "answer 150:"), { timeout: 15_000 }).toBe(true);
	});
});
