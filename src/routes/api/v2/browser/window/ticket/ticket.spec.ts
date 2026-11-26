/** The ticket for the window browser socket: who may mint one, and what it is bound to. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/server/browser/settings", async (orig) => ({
	...(await orig<typeof import("$lib/server/browser/settings")>()),
	browserEnabled: () => state.enabled,
}));

import { _resetTicketLimitsForTests, redeemWindowTicket } from "$lib/server/browser/windowTickets";
import { windowGrantKey } from "$lib/server/browser/windowRegistry";
import { config } from "$lib/server/config";
import { POST } from "./+server";

const WID = "d".repeat(32);
const user = { _id: new ObjectId() };
const post = (
	body: unknown,
	locals: Record<string, unknown>,
	secret: string | undefined = "sess-secret"
) =>
	POST({
		locals,
		cookies: { get: (name: string) => (name === config.COOKIE_NAME ? secret : undefined) },
		request: new Request("https://x.invalid/api/v2/browser/window/ticket", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	} as never);
const status = async (p: Promise<Response> | Response) => {
	try {
		return (await p).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
};

beforeEach(() => {
	state.enabled = true;
	_resetTicketLimitsForTests();
});

describe("POST /api/v2/browser/window/ticket", () => {
	it("mints a single-use ticket bound to the user, the session and the window id", async () => {
		const res = await post({ windowId: WID }, { user, sessionId: "sess-1" });
		const body = (await res.json()) as { ticket: string };
		const { ticket } = body;
		// no cookie name, no key: the page learns only the ticket
		expect(Object.keys(body)).toEqual(["ticket"]);
		expect(ticket.length).toBeGreaterThan(30);
		expect(redeemWindowTicket(ticket)).toEqual({
			userId: user._id.toString(),
			sessionId: "sess-1",
			windowId: WID,
			// derived from the session cookie's value, never sent to the page
			key: windowGrantKey("sess-secret", WID),
		});
		expect(redeemWindowTicket(ticket)).toBeNull();
	});

	it("allows ten tickets a minute per user, then answers 429", async () => {
		for (let i = 0; i < 10; i++)
			expect(await status(post({ windowId: WID }, { user, sessionId: "rate" }))).toBe(200);
		expect(await status(post({ windowId: WID }, { user, sessionId: "rate" }))).toBe(429);
		// a second session of the same user shares the budget
		expect(await status(post({ windowId: WID }, { user, sessionId: "other" }))).toBe(429);
		// another user is not affected
		const other = { ...user, _id: new ObjectId() };
		expect(await status(post({ windowId: WID }, { user: other, sessionId: "o" }))).toBe(200);
	});

	it("needs the session cookie: the key is derived from it", async () => {
		expect(await status(post({ windowId: WID }, { user, sessionId: "s" }, ""))).toBe(401);
	});

	it("never puts the key or the secret in the answer", async () => {
		const text = await (await post({ windowId: WID }, { user, sessionId: "s" })).text();
		expect(text).not.toContain("sess-secret");
		expect(text).not.toContain(windowGrantKey("sess-secret", WID).toString("base64url"));
	});

	it("is refused without a signed-in user, and absent when browser use is off", async () => {
		expect(await status(post({ windowId: WID }, { sessionId: "anon-session" }))).toBe(401);
		state.enabled = false;
		expect(await status(post({ windowId: WID }, { user, sessionId: "s" }))).toBe(404);
	});

	it("refuses a window id that is not an id, or a body that is not JSON", async () => {
		for (const body of [
			{},
			{ windowId: "short" },
			{ windowId: `${WID}/../x` },
			{ windowId: 5 },
			"nope",
		]) {
			expect(await status(post(body, { user, sessionId: "s" }))).toBe(400);
		}
	});
});
