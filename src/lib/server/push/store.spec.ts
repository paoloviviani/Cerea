import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	MAX_DEVICES_PER_USER,
	SubscriptionError,
	deviceLabel,
	deviceView,
	listSubscriptions,
	removeByEndpoint,
	removeSubscription,
	saveSubscription,
} from "./store";
import { fakeBrowser } from "./testSupport";

beforeAll(async () => {
	await ready;
}, 30000);
beforeEach(async () => {
	await collections.pushSubscriptions.deleteMany({});
});

describe("saveSubscription", () => {
	it("stores a device for its owner, with a label from the user agent", async () => {
		const me = new ObjectId();
		const row = await saveSubscription(me, fakeBrowser().subscription);
		expect(row.userId.equals(me)).toBe(true);
		expect(row.label).toBe("Chrome on Linux");
		expect(await listSubscriptions(me)).toHaveLength(1);
	});

	it("is one row per browser: subscribing again updates it", async () => {
		const me = new ObjectId();
		const b = fakeBrowser();
		await saveSubscription(me, b.subscription);
		await saveSubscription(me, b.subscription);
		expect(await collections.pushSubscriptions.countDocuments({})).toBe(1);
	});

	it("moves a browser to whoever subscribes on it now, so it never notifies two people", async () => {
		const first = new ObjectId();
		const second = new ObjectId();
		const b = fakeBrowser();
		await saveSubscription(first, b.subscription);
		await saveSubscription(second, b.subscription);
		expect(await listSubscriptions(first)).toHaveLength(0);
		expect(await listSubscriptions(second)).toHaveLength(1);
	});

	it("refuses an address that is not https, or points inside the network", async () => {
		const me = new ObjectId();
		for (const endpoint of [
			"http://push.example.net/x",
			"https://127.0.0.1/x",
			"https://169.254.169.254/x",
			"https://localhost/x",
			"not a url",
		]) {
			await expect(
				saveSubscription(me, { ...fakeBrowser().subscription, endpoint })
			).rejects.toBeInstanceOf(SubscriptionError);
		}
		expect(await collections.pushSubscriptions.countDocuments({})).toBe(0);
	});

	it("refuses keys of the wrong shape", async () => {
		const me = new ObjectId();
		const good = fakeBrowser().subscription;
		await expect(saveSubscription(me, { ...good, p256dh: "AAAA" })).rejects.toBeInstanceOf(
			SubscriptionError
		);
		await expect(saveSubscription(me, { ...good, auth: "AAAA" })).rejects.toBeInstanceOf(
			SubscriptionError
		);
	});

	it("keeps at most MAX_DEVICES_PER_USER, dropping the oldest", async () => {
		const me = new ObjectId();
		const first = fakeBrowser();
		await saveSubscription(me, first.subscription);
		for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
			await saveSubscription(me, fakeBrowser().subscription);
		}
		const rows = await listSubscriptions(me);
		expect(rows).toHaveLength(MAX_DEVICES_PER_USER);
		expect(rows.some((r) => r.endpoint === first.subscription.endpoint)).toBe(false);
	});
});

describe("owner scoping", () => {
	it("lists and removes only the caller's own devices", async () => {
		const me = new ObjectId();
		const other = new ObjectId();
		const mine = await saveSubscription(me, fakeBrowser().subscription);
		const theirs = await saveSubscription(other, fakeBrowser().subscription);

		expect(await removeSubscription(me, theirs._id.toString())).toBe(false);
		expect(await collections.pushSubscriptions.countDocuments({})).toBe(2);
		expect(await removeSubscription(me, "not-an-id")).toBe(false);
		expect(await removeSubscription(me, mine._id.toString())).toBe(true);
		expect((await listSubscriptions(other)).map((r) => r._id.toString())).toEqual([
			theirs._id.toString(),
		]);
	});

	it("removeByEndpoint forgets a browser the push service dropped", async () => {
		const me = new ObjectId();
		const b = fakeBrowser();
		await saveSubscription(me, b.subscription);
		await removeByEndpoint(b.subscription.endpoint);
		expect(await listSubscriptions(me)).toHaveLength(0);
	});
});

describe("deviceView", () => {
	it("never carries the endpoint or the keys", async () => {
		const row = await saveSubscription(new ObjectId(), fakeBrowser().subscription);
		const view = JSON.stringify(deviceView(row));
		expect(view).not.toContain(row.endpoint);
		expect(view).not.toContain(row.p256dh);
		expect(view).not.toContain(row.auth);
		expect(deviceView(row).fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("deviceLabel", () => {
	it.each([
		["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", "Safari on iOS"],
		["Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36", "Chrome on Android"],
		["Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0", "Edge on Windows"],
		["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Linux"],
		["", "Browser"],
	])("%s", (ua, label) => expect(deviceLabel(ua)).toBe(label));
});
