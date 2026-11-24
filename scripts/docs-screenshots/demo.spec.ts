/**
 * The README animation: three short clips recorded with Playwright's video, from the same hermetic
 * stack and fake data as the screenshots (user Ada, example.org, a fake machine). Nothing is
 * published from here: the clips land in $DEMO_OUT with a clips.json of trim offsets, and
 * make-demo.py joins them into docs/assets/cerea-demo.mp4 and .webp. How to re-record:
 * docs/dev/ui-screenshots.md.
 *
 *   a. desktop: a question, the answer streaming in, the artifact it made.
 *   b. desktop: a coding agent asks to edit a file; the approval card; Allow once; the result.
 *   c. phone:   the same kind of card, approved from an iPhone-sized screen.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "playwright/test";
import { test, expect, E2E_APP_BASE, stubCodeStatus } from "../../tests/fixtures.ts";
import type { FakeMachine } from "../../tests/fake-machine.ts";
import type { Transcript } from "../../src/lib/types/machineProtocol.ts";
import {
	TITLES,
	QUOTA_DOC,
	signInAda,
	useModel,
	retitle,
	openShop,
	openWaiting,
} from "./common.ts";

const OUT = process.env.DEMO_OUT ?? "/var/tmp/readme-tmp/demo";
mkdirSync(OUT, { recursive: true });

test.use({ timezoneId: "Europe/Rome", locale: "en-GB" });
test.describe.configure({ mode: "serial" });

const offsets: Record<string, number> = {};

/** A recording context in Ada's session; `mark(name)` notes when the scripted part starts. */
async function recorder(
	browser: Browser,
	page: Page,
	name: string,
	options: Record<string, unknown>
) {
	const state = await page.context().storageState();
	const t0 = Date.now();
	const context = await browser.newContext({
		storageState: state,
		timezoneId: "Europe/Rome",
		locale: "en-GB",
		colorScheme: "light",
		...options,
		recordVideo: {
			dir: `${OUT}/raw-${name}`,
			size: options.viewport as { width: number; height: number },
		},
	});
	const view = await context.newPage();
	await stubCodeStatus(view);
	return {
		view,
		mark: () => {
			offsets[name] = (Date.now() - t0) / 1000;
		},
		async finish() {
			const video = view.video();
			await context.close();
			await video?.saveAs(`${OUT}/clip-${name}.webm`);
			writeFileSync(`${OUT}/clips.json`, JSON.stringify(offsets, null, 2));
		},
	};
}

async function type(page: Page, placeholder: string, text: string) {
	const box = page.getByPlaceholder(placeholder);
	await box.click();
	await box.pressSequentially(text, { delay: 20 });
}

/** The fake machine answers an approval: the edit lands, the tests run, the session goes idle. */
function answerApprovals(fake: FakeMachine) {
	fake.onOp<{ sessionId: string; requestId: string }>("permission.reply", (args) => {
		const { sessionId, requestId } = args;
		const messageId = "m_a";
		const part = (id: string, tool: string, input: object, output?: string) => ({
			id: `p_${id}`,
			messageId,
			role: "assistant",
			type: "tool" as const,
			callId: id,
			tool,
			status: "completed" as const,
			input,
			...(output ? { output } : {}),
		});
		setTimeout(() => {
			const push = fake.pushEvent.bind(fake, sessionId);
			push({ kind: "permission.replied", requestId, decision: "once", by: "user" });
			push({
				kind: "part",
				part: part("c3", "edit", { filePath: "/home/ada/work/shop-api/cart.py" }),
			});
			setTimeout(() => {
				push({
					kind: "part",
					part: part(
						"c4",
						"bash",
						{ command: "python3 -m pytest" },
						"===== 12 passed in 0.41s ====="
					),
				});
				push({
					kind: "part",
					part: {
						id: "p_done",
						messageId,
						role: "assistant",
						type: "text",
						text: "Fixed: SAVE10 now takes 10 percent off the total instead of 10 euro. All 12 tests pass.",
					},
				});
				push({ kind: "status", status: "idle" });
			}, 1800);
		}, 600);
		return {};
	});
}

test("record a, the chat", async ({ browser, page, db, session, mockOpenAI }) => {
	test.setTimeout(240_000);
	const userId = await signInAda(db, session, TITLES);

	// a. the chat
	await useModel(db, userId, "test-org/artifact-tool");
	const answer =
		"I've put the recommendation in a document titled **Quota policy recommendation**: a daily limit per user, a monthly cap per group, and an organisation-wide ceiling. Open it on the right.";
	await mockOpenAI.setDefaultScenario({
		toolCalls: [
			{
				id: "call_doc",
				name: "artifact",
				arguments: JSON.stringify({
					command: "create",
					identifier: "quota-policy",
					type: "markdown",
					title: "Quota policy recommendation",
					content: QUOTA_DOC,
				}),
			},
		],
		content: answer.split(/(?<= )/),
		chunkDelayMs: 70,
	});
	{
		const rec = await recorder(browser, page, "a", {
			viewport: { width: 1280, height: 800 },
			deviceScaleFactor: 1,
		});
		const view = rec.view;
		await view.goto(`${E2E_APP_BASE}/`);
		await expect(view.getByText("What can I help you with today, Ada?")).toBeVisible();
		await view.waitForTimeout(800);
		rec.mark();
		await view.waitForTimeout(800);
		await type(
			view,
			"Ask anything",
			"Recommend a quota policy for a 40-user team: per-user daily, per-group monthly, organisation-wide cap."
		);
		await view.waitForTimeout(700);
		await view.getByRole("button", { name: "Send message" }).click();
		await view.waitForURL(/\/conversation\/[a-f0-9]{24}/);
		await expect(
			view
				.getByLabel("File panel", { exact: true })
				.getByRole("heading", { name: "Recommendation", exact: true })
		).toBeVisible({ timeout: 30_000 });
		await expect(view.getByText("Open it on the right.")).toBeVisible({ timeout: 30_000 });
		await retitle(db, view, "Quota policy recommendation");
		await view.waitForTimeout(3000);
		await rec.finish();
	}
});

test("record b and c, the agents", async ({ browser, page, db, session }) => {
	test.setTimeout(240_000);
	const { fake, deviceId, waiting, model } = await openShop(page, db, session);
	try {
		answerApprovals(fake);
		// A second waiting session for the phone, so each clip approves its own card.
		const base = model.transcripts.get(waiting) as Transcript;
		const phoneId = "ses-cache";
		model.transcripts.set(phoneId, {
			...base,
			permissions: base.permissions.map((p) => ({ ...p, id: "perm-phone", sessionId: phoneId })),
		});
		{
			const rec = await recorder(browser, page, "b", {
				viewport: { width: 1280, height: 800 },
				deviceScaleFactor: 1,
			});
			const view = rec.view;
			await openWaiting(view, `${E2E_APP_BASE}/code?device=${deviceId}&agent=${waiting}`);
			await view.waitForTimeout(700);
			rec.mark();
			await view.waitForTimeout(2600);
			await view.getByRole("button", { name: "Allow once" }).first().click();
			await expect(view.getByText(/12 passed|All 12 tests pass/).first()).toBeVisible({
				timeout: 30_000,
			});
			await view.waitForTimeout(2600);
			await rec.finish();
		}
		{
			const rec = await recorder(browser, page, "c", {
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 2,
				isMobile: true,
				hasTouch: true,
			});
			const view = rec.view;
			await openWaiting(view, `${E2E_APP_BASE}/code?device=${deviceId}&agent=${phoneId}`);
			await view.waitForTimeout(700);
			rec.mark();
			await view.waitForTimeout(2400);
			await view.getByRole("button", { name: "Allow once" }).first().click();
			await expect(view.getByText(/12 passed|All 12 tests pass/).first()).toBeVisible({
				timeout: 30_000,
			});
			await view.waitForTimeout(2300);
			await rec.finish();
		}
	} finally {
		fake.close();
	}
});
