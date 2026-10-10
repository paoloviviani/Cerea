/**
 * Paging a long agent session (step B): the stream's snapshot carries only
 * the newest page, and scrolling to the top pages the older ones in —
 * the visible message staying where it was, a "Loading earlier messages…"
 * row while a page is in flight, and a quiet "Start of the session" marker
 * at the top. Hermetic: a `FakeMachine` advertising `historyPaging`, whose
 * `session.sync` trims to the newest 40 (the fake's own contract, mirroring
 * galopin) and whose scripted `session.history` pages the seeded 100-message
 * transcript below any cursor.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, E2E_APP_URL, MOCK_OIDC_ISSUER } from "./fixtures";
import { seedUser } from "./machineHarness";
import { FakeMachine } from "./fake-machine";
import type { Transcript } from "../src/lib/types/machineProtocol";

const TURNS = 50; // 100 messages: the newest 40 load, two pages page in

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
		{
			policy: { workspaceRoots: [], allowFreeModels: false },
			backends: [
				{
					id: "opencode",
					version: "9.9.9",
					capabilities: {
						diff: true,
						children: true,
						usage: true,
						compact: true,
						images: true,
						files: true,
						worktrees: false,
						questions: true,
						historyPaging: true,
					},
				},
			],
		}
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

/** A transcript of `turns` user/assistant exchanges, like the load spec's. */
function seededTranscript(turns: number): Transcript {
	const messages: Transcript["messages"] = [];
	const filler = (i: number) => `Message number ${i} of the paged session. `.repeat(4);
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
		messages.push({
			message: {
				id: `msg_a_${i}`,
				role: "assistant",
				createdAt: new Date(i * 1000 + 1).toISOString(),
			},
			parts: [
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
			],
		});
	}
	return { messages, permissions: [], status: "idle", usage: null, todos: [] };
}

/** The viewport-relative top of the first element containing `needle`
 * inside the scroll container, or null when it is outside the viewport. */
async function viewportOffset(page: Page, needle: string): Promise<number | null> {
	return page.evaluate(
		([text]) => {
			const scroller = document.querySelector('[aria-label="Conversation messages"]');
			if (!scroller) return null;
			const box = scroller.getBoundingClientRect();
			const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node) {
				if (node.textContent?.includes(text)) {
					const el = node.parentElement;
					if (!el) return null;
					const rect = el.getBoundingClientRect();
					if (rect.bottom > box.top && rect.top < box.bottom) return rect.top - box.top;
					return null;
				}
				node = walker.nextNode();
			}
			return null;
		},
		[needle]
	);
}

async function scrollToTop(page: Page): Promise<void> {
	await page.evaluate(() => {
		document.querySelector('[aria-label="Conversation messages"]')?.scrollTo({ top: 0 });
	});
}

test.describe("paging a long agent session", () => {
	let fake: FakeMachine | null = null;

	test.afterEach(async ({ page }) => {
		fake?.close();
		fake = null;
		await page.close().catch(() => {});
	});

	test("scrolls up through older pages without jumping, to the start of the session", async ({
		page,
		db,
		session,
	}) => {
		const sub = `e2e-${randomUUID()}`;
		await seedUser(db, session.sessionId, sub);
		const name = `paged-${randomUUID().slice(0, 6)}`;
		fake = await connectFakeMachine(sub, name);
		await pairAndStartSession(page, name);

		const machine = fake;
		if (!machine) throw new Error("the fake machine was closed early");
		const created = machine.model.sessions.at(-1);
		if (!created) throw new Error("the pair flow created no session");
		const sessionId = created.id;
		const all = seededTranscript(TURNS).messages;
		machine.model.transcripts.set(sessionId, {
			messages: all,
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		});
		// The older pages, served below any cursor like galopin serves
		// them — stalled behind a gate the test opens, so the loading row
		// and the pre-page position are observable, not raced.
		const gate: { release: (() => void) | null } = { release: null };
		machine.onOp("session.history", async (args: { before: string; limit: number }) => {
			await new Promise<void>((resolve) => (gate.release = resolve));
			gate.release = null;
			const idx = all.findIndex((entry) => entry.message.id === args.before);
			const older = idx < 0 ? [] : all.slice(0, idx);
			const kept = older.slice(-args.limit);
			return {
				messages: kept,
				hasMore: older.length > args.limit,
				...(kept.length ? { before: kept[0].message.id } : {}),
			};
		});

		await page.goto(`${E2E_APP_BASE}/code?device=${fake.deviceId}&agent=${sessionId}`);

		// The newest page loads, landed at the bottom: the first prompt is
		// above the fold, there is more behind it, and nothing pages yet.
		await expect(page.getByText(`answer ${TURNS}:`)).toBeVisible({ timeout: 30_000 });
		await expect.poll(() => viewportOffset(page, "prompt 1:"), { timeout: 15_000 }).toBe(null);
		await expect(page.getByText("Start of the session")).toHaveCount(0);
		await expect(page.getByText("Loading earlier messages…")).toHaveCount(0);

		// First page up: the loading row shows while the fetch is stalled,
		// the top message holds still, then the older page lands above it.
		// The row appears before the machine even receives the request, so
		// the gate is awaited too — releasing nothing deadlocks the page.
		await scrollToTop(page);
		await expect(page.getByText("Loading earlier messages…")).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => gate.release !== null, { timeout: 15_000 }).toBe(true);
		const held = await viewportOffset(page, "prompt 31:");
		expect(held, "the top message while the first page loads").not.toBe(null);
		gate.release?.();
		await expect(page.getByText("Loading earlier messages…")).toHaveCount(0, {
			timeout: 15_000,
		});
		await expect(page.getByText("prompt 11:")).toBeVisible({ timeout: 15_000 });
		const heldAfter = await viewportOffset(page, "prompt 31:");
		expect(heldAfter, "the top message after the first page lands").not.toBe(null);
		expect(Math.abs((heldAfter ?? 0) - (held ?? 0))).toBeLessThan(12);

		// Second page up: the rest of the transcript, then the start marker —
		// and scrolling past it fetches nothing more.
		await scrollToTop(page);
		await expect(page.getByText("Loading earlier messages…")).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => gate.release !== null, { timeout: 15_000 }).toBe(true);
		gate.release?.();
		await expect(page.getByText("prompt 1:")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText("Start of the session")).toBeVisible({ timeout: 15_000 });
		await scrollToTop(page);
		// Nothing more to fetch: no loading row, even given a moment.
		await page.waitForTimeout(500);
		await expect(page.getByText("Loading earlier messages…")).toHaveCount(0);
	});
});
