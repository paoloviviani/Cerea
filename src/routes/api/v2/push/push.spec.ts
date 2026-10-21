import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { fakeBrowser, must, setVapid, withVapid } from "$lib/server/push/testSupport";
import { _resetPushRateLimit } from "$lib/server/push/notify";
import { GET, PATCH, POST } from "./+server";
import { DELETE } from "./[id]/+server";
import { POST as TEST } from "./test/+server";

const JSON_HEADERS = { "Content-Type": "application/json" };
let restore: () => void;

beforeAll(async () => {
	await ready;
}, 30000);
beforeEach(async () => {
	restore = withVapid();
	_resetPushRateLimit();
	await cleanupTestData();
	await collections.pushSubscriptions.deleteMany({});
}, 20000);
afterEach(() => restore());

const subscribeBody = (b = fakeBrowser()) =>
	JSON.stringify({
		endpoint: b.subscription.endpoint,
		keys: { p256dh: b.subscription.p256dh, auth: b.subscription.auth },
	});

async function subscribe(user: Awaited<ReturnType<typeof createTestUser>>) {
	const res = await testRequest(POST, {
		path: "/api/v2/push",
		method: "POST",
		locals: user.locals,
		headers: { ...JSON_HEADERS, "User-Agent": "Mozilla/5.0 (X11; Linux) Firefox/130.0" },
		body: subscribeBody(),
	});
	return res;
}

describe("/api/v2/push", () => {
	it("refuses an anonymous session", async () => {
		const res = await testRequest(GET, { path: "/api/v2/push" });
		expect(res.status).toBe(401);
	});

	it("reports off, with no key, when the deployment has none", async () => {
		const { locals } = await createTestUser();
		setVapid("PRIVATE_KEY", "");
		const res = await testRequest(GET, { path: "/api/v2/push", locals });
		const { data } = await res.json();
		expect(data).toMatchObject({ configured: false, publicKey: null, devices: [] });
		expect((await subscribe({ locals } as never)).status).toBe(404);
	});

	it("subscribes a device and lists it without its endpoint or keys", async () => {
		const me = await createTestUser();
		const created = await subscribe(me);
		expect(created.status).toBe(201);

		const res = await testRequest(GET, { path: "/api/v2/push", locals: me.locals });
		const text = await res.text();
		const { data } = JSON.parse(text);
		expect(data.configured).toBe(true);
		expect(data.publicKey).toMatch(/^B/);
		expect(data.devices).toHaveLength(1);
		expect(data.devices[0].label).toBe("Firefox on Linux");
		expect(text).not.toContain("push.example.net");
		// Every event resolved to its default.
		expect(data.events).toEqual({
			permission: true,
			agentTurn: true,
			scheduleRun: true,
			backgroundTask: true,
			chatTurn: false,
		});
	});

	it("refuses a subscription that is not one", async () => {
		const me = await createTestUser();
		for (const body of [
			"{}",
			JSON.stringify({ endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } }),
			"not json",
		]) {
			const res = await testRequest(POST, {
				path: "/api/v2/push",
				method: "POST",
				locals: me.locals,
				headers: JSON_HEADERS,
				body,
			});
			expect(res.status).toBe(400);
		}
		const res = await testRequest(POST, {
			path: "/api/v2/push",
			method: "POST",
			locals: me.locals,
			headers: { "Content-Type": "text/plain" },
			body: subscribeBody(),
		});
		// Refused either by the CSRF rule for form-like types (403) or by the route (400).
		expect([400, 403]).toContain(res.status);
	});

	it("saves per-event switches and changes only the named ones", async () => {
		const me = await createTestUser();
		const patch = (events: unknown) =>
			testRequest(PATCH, {
				path: "/api/v2/push",
				method: "PATCH",
				locals: me.locals,
				headers: JSON_HEADERS,
				body: JSON.stringify({ events }),
			});
		const first = await patch({ permission: false, chatTurn: true });
		expect((await first.json()).data.events).toMatchObject({
			permission: false,
			chatTurn: true,
			agentTurn: true,
		});
		const second = await patch({ agentTurn: false });
		expect((await second.json()).data.events).toMatchObject({
			permission: false,
			chatTurn: true,
			agentTurn: false,
		});
		expect((await patch({ bogus: true })).status).toBe(200); // unknown names are dropped
		expect((await patch({ permission: "yes" })).status).toBe(400);
		const stored = await collections.settings.findOne({ userId: me.user._id });
		expect(stored?.pushEvents).toEqual({ permission: false, chatTurn: true, agentTurn: false });
	});

	it("scopes everything to the signed-in person", async () => {
		const me = await createTestUser();
		const other = await createTestUser();
		await subscribe(me);
		await subscribe(other);
		const mine = must(await collections.pushSubscriptions.findOne({ userId: me.user._id }));
		const theirs = must(await collections.pushSubscriptions.findOne({ userId: other.user._id }));

		const listed = await (
			await testRequest(GET, { path: "/api/v2/push", locals: me.locals })
		).json();
		expect(listed.data.devices.map((d: { id: string }) => d.id)).toEqual([mine._id.toString()]);

		const denied = await testRequest(DELETE, {
			path: `/api/v2/push/${theirs._id}`,
			method: "DELETE",
			locals: me.locals,
			params: { id: theirs._id.toString() },
		});
		expect(denied.status).toBe(404);
		expect(await collections.pushSubscriptions.countDocuments({})).toBe(2);

		const removed = await testRequest(DELETE, {
			path: `/api/v2/push/${mine._id}`,
			method: "DELETE",
			locals: me.locals,
			params: { id: mine._id.toString() },
		});
		expect(removed.status).toBe(200);
		expect(await collections.pushSubscriptions.countDocuments({})).toBe(1);
	});

	it("sends a test to the caller's devices, and says so when there are none", async () => {
		const me = await createTestUser();
		const none = await testRequest(TEST, {
			path: "/api/v2/push/test",
			method: "POST",
			locals: me.locals,
		});
		expect(none.status).toBe(409);

		await subscribe(me);
		const fetchSpy = vi
			.spyOn(await import("$lib/server/push/guard"), "pushFetch")
			.mockResolvedValue(new Response(null, { status: 201 }));
		const res = await testRequest(TEST, {
			path: "/api/v2/push/test",
			method: "POST",
			locals: me.locals,
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.accepted).toBe(1);
		expect(fetchSpy).toHaveBeenCalledOnce();
		fetchSpy.mockRestore();
	});
});
