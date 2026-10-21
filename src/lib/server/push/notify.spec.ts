import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	MAX_PUSHES_PER_WINDOW,
	_resetPushRateLimit,
	allowPush,
	buildPayload,
	notifyUser,
	sendTestNotification,
} from "./notify";
import { saveSubscription } from "./store";
import { decryptPayload, fakeBrowser, must, withVapid } from "./testSupport";

let restore: () => void;
beforeAll(async () => {
	await ready;
}, 30000);
beforeEach(async () => {
	restore = withVapid();
	_resetPushRateLimit();
	await collections.pushSubscriptions.deleteMany({});
	await collections.settings.deleteMany({});
});
afterEach(() => restore());

const message = { title: "An agent needs you", body: "Waiting.", path: "/code?device=d&agent=s" };

describe("buildPayload", () => {
	it("carries a title, a line, the app path under the base, and nothing else of substance", () => {
		const payload = buildPayload("permission", { ...message, tag: "ask-1" }, "/chat", "chatui");
		expect(payload).toEqual({
			v: 1,
			title: "An agent needs you",
			body: "Waiting.",
			url: "/chat/code?device=d&agent=s",
			icon: "/chat/chatui/icon-192x192.png",
			tag: "ask-1",
			event: "permission",
		});
	});

	it("clips long text, flattens whitespace, and never lets a click leave the app", () => {
		const p = buildPayload(
			"agentTurn",
			{ title: "t".repeat(500), body: "a\n\n  b " + "x".repeat(500), path: "//evil.example/x" },
			"/chat",
			"chatui"
		);
		expect(p.title.length).toBeLessThanOrEqual(80);
		expect(p.body.length).toBeLessThanOrEqual(140);
		expect(p.body.startsWith("a b ")).toBe(true);
		expect(p.url).toBe("/chat/");
		expect(buildPayload("test", { ...message, path: "https://evil.example" }, "", "x").url).toBe(
			"/"
		);
	});
});

describe("allowPush", () => {
	it("allows MAX_PUSHES_PER_WINDOW per person per window, then refuses, then recovers", () => {
		const me = new ObjectId();
		const other = new ObjectId();
		for (let i = 0; i < MAX_PUSHES_PER_WINDOW; i++) expect(allowPush(me, 1000)).toBe(true);
		expect(allowPush(me, 1000)).toBe(false);
		expect(allowPush(other, 1000)).toBe(true);
		expect(allowPush(me, 1000 + 5 * 60_000 + 1)).toBe(true);
	});
});

describe("notifyUser", () => {
	const ok = () => vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

	it("sends an encrypted, minimal payload to each of the person's devices", async () => {
		const me = new ObjectId();
		const a = fakeBrowser();
		const b = fakeBrowser();
		await saveSubscription(me, a.subscription);
		await saveSubscription(me, b.subscription);
		const fetchImpl = ok();

		const result = await notifyUser(me, "permission", message, { fetch: fetchImpl });

		expect(result).toMatchObject({ accepted: 2, gone: 0, failed: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const call = must(fetchImpl.mock.calls.find((c) => c[0] === a.subscription.endpoint));
		const text = decryptPayload(Buffer.from(call[1].body), a.ecdh, a.auth).toString();
		expect(JSON.parse(text)).toMatchObject({
			v: 1,
			title: "An agent needs you",
			event: "permission",
		});
		expect(call[1].headers).toMatchObject({ Urgency: "high", TTL: String(24 * 3600) });
		const row = await collections.pushSubscriptions.findOne({ endpoint: a.subscription.endpoint });
		expect(row?.lastPushAt).toBeInstanceOf(Date);
	});

	it("sends nothing for a person with no devices, or when push is off", async () => {
		const fetchImpl = ok();
		expect(
			await notifyUser(new ObjectId(), "permission", message, { fetch: fetchImpl })
		).toMatchObject({ skipped: "no-devices" });
		restore();
		const me = new ObjectId();
		expect(await notifyUser(me, "permission", message, { fetch: fetchImpl })).toMatchObject({
			skipped: "off",
		});
		restore = withVapid();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("only notifies the person it is for", async () => {
		const me = new ObjectId();
		const other = new ObjectId();
		await saveSubscription(other, fakeBrowser().subscription);
		const fetchImpl = ok();
		await notifyUser(me, "permission", message, { fetch: fetchImpl });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("honours the per-event switches, with each event's default when unset", async () => {
		const me = new ObjectId();
		await saveSubscription(me, fakeBrowser().subscription);
		const fetchImpl = ok();

		// chatTurn defaults off, permission defaults on.
		expect(await notifyUser(me, "chatTurn", message, { fetch: fetchImpl })).toMatchObject({
			skipped: "event-disabled",
		});
		expect((await notifyUser(me, "permission", message, { fetch: fetchImpl })).accepted).toBe(1);

		await collections.settings.insertOne({
			userId: me,
			pushEvents: { permission: false, chatTurn: true },
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		fetchImpl.mockClear();
		expect(await notifyUser(me, "permission", message, { fetch: fetchImpl })).toMatchObject({
			skipped: "event-disabled",
		});
		expect((await notifyUser(me, "chatTurn", message, { fetch: fetchImpl })).accepted).toBe(1);
	});

	it.each([404, 410])("forgets a device the push service answers %i for", async (status) => {
		const me = new ObjectId();
		const gone = fakeBrowser();
		await saveSubscription(me, gone.subscription);
		await saveSubscription(me, fakeBrowser().subscription);
		const fetchImpl = vi.fn(
			async (url: string) =>
				new Response(null, { status: url === gone.subscription.endpoint ? status : 201 })
		);
		const result = await notifyUser(me, "permission", message, { fetch: fetchImpl });
		expect(result).toMatchObject({ accepted: 1, gone: 1 });
		expect(await collections.pushSubscriptions.countDocuments({ userId: me })).toBe(1);
		expect(
			await collections.pushSubscriptions.countDocuments({ endpoint: gone.subscription.endpoint })
		).toBe(0);
	});

	it.each([429, 500, 503])("keeps the device on %i and counts a failure", async (status) => {
		const me = new ObjectId();
		await saveSubscription(me, fakeBrowser().subscription);
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
		const result = await notifyUser(me, "permission", message, { fetch: fetchImpl });
		expect(result).toMatchObject({ accepted: 0, failed: 1 });
		expect(await collections.pushSubscriptions.countDocuments({ userId: me })).toBe(1);
	});

	it("rate-limits per person", async () => {
		const me = new ObjectId();
		await saveSubscription(me, fakeBrowser().subscription);
		const fetchImpl = ok();
		for (let i = 0; i < MAX_PUSHES_PER_WINDOW; i++) {
			await notifyUser(me, "permission", message, { fetch: fetchImpl });
		}
		expect(await notifyUser(me, "permission", message, { fetch: fetchImpl })).toMatchObject({
			skipped: "rate-limited",
		});
		expect(fetchImpl).toHaveBeenCalledTimes(MAX_PUSHES_PER_WINDOW);
	});

	it("never throws, and never logs the endpoint's path", async () => {
		const me = new ObjectId();
		const b = fakeBrowser("https://push.example.net/wpush/SECRET-TOKEN-123");
		await saveSubscription(me, b.subscription);
		const { logger } = await import("$lib/server/logger");
		const warn = vi.spyOn(logger, "warn");
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
		await expect(
			notifyUser(me, "permission", message, { fetch: fetchImpl })
		).resolves.toBeDefined();
		expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-TOKEN-123");
		expect(JSON.stringify(warn.mock.calls)).toContain("push.example.net");
		warn.mockRestore();
		// The fetch implementation throwing (the SSRF guard) is contained as well.
		const boom = vi.fn().mockRejectedValue(new Error("blocked"));
		await expect(notifyUser(me, "permission", message, { fetch: boom })).resolves.toBeDefined();
	});
});

describe("sendTestNotification", () => {
	it("ignores the per-event switches but not the rate limit", async () => {
		const me = new ObjectId();
		const b = fakeBrowser();
		await saveSubscription(me, b.subscription);
		await collections.settings.insertOne({
			userId: me,
			pushEvents: {
				permission: false,
				agentTurn: false,
				scheduleRun: false,
				backgroundTask: false,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
		expect((await sendTestNotification(me, { fetch: fetchImpl })).accepted).toBe(1);
		const sent = JSON.parse(
			decryptPayload(Buffer.from(must(fetchImpl.mock.calls[0])[1].body), b.ecdh, b.auth).toString()
		);
		expect(sent).toMatchObject({ event: "test", title: "Notifications are on" });

		for (let i = 0; i < MAX_PUSHES_PER_WINDOW; i++) allowPush(me);
		expect(await sendTestNotification(me, { fetch: fetchImpl })).toMatchObject({
			skipped: "rate-limited",
		});
	});
});
