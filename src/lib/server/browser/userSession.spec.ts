import { afterEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { FakeBrowserRuntime } from "./fakeRuntime";
import { memoryLeaseStore } from "./lease";
import { liveTaskFor } from "./liveView";
import { closeUserBrowser, openUserBrowser, type UserBrowserDeps } from "./userSession";

const user = { id: new ObjectId() };
const pages = [{ id: "p", url: "https://a.test/", title: "A", elements: [] }];

function deps(over: Partial<UserBrowserDeps> = {}) {
	const runtime = new FakeBrowserRuntime(pages);
	const leases = memoryLeaseStore();
	return {
		runtime,
		deps: {
			leases,
			runtimeFor: () => runtime,
			device: async (_u: ObjectId, id: string) => (id === "dev1" ? { name: "Desk" } : null),
			...over,
		} satisfies UserBrowserDeps,
	};
}
let open: string[] = [];
afterEach(async () => {
	for (const id of open) await closeUserBrowser(user.id.toString(), id);
	open = [];
});
const must = <T>(v: T | undefined | null): T => {
	if (v === undefined || v === null) throw new Error("expected a value");
	return v;
};

describe("a browser the user opens on their computer", () => {
	it("opens with input from the start and says what it is and where it runs", async () => {
		const { deps: d, runtime } = deps();
		const r = await openUserBrowser(user, { deviceId: "dev1", url: "https://a.test/" }, d);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		open.push(r.id);
		expect(r.info).toMatchObject({
			machineId: "dev1",
			machineName: "Desk",
			kind: "agent_machine",
			userOwned: true,
			controller: "user",
		});
		const task = must(liveTaskFor(r.id, user.id.toString()));
		expect(await task.input({ events: [{ type: "text", text: "hi" }] })).toEqual({
			ok: true,
			sent: 1,
		});
		expect(runtime.userInput).toEqual([{ type: "text", text: "hi" }]);
		// Nothing to hand back.
		expect(await task.handBack()).toMatchObject({ ok: false, status: 409 });
		expect(await task.takeover()).toMatchObject({ ok: true, controller: "user" });
	});

	it("is the owner's alone, one per computer, and closes on request", async () => {
		const { deps: d } = deps();
		const a = await openUserBrowser(user, { deviceId: "dev1" }, d);
		if (!a.ok) throw new Error("open");
		expect(liveTaskFor(a.id, new ObjectId().toString())).toBeUndefined();
		expect(await openUserBrowser(user, { deviceId: "dev1" }, d)).toMatchObject({
			ok: false,
			status: 409,
		});
		expect(await closeUserBrowser(new ObjectId().toString(), a.id)).toBe(false);
		expect(await closeUserBrowser(user.id.toString(), a.id)).toBe(true);
		expect(liveTaskFor(a.id, user.id.toString())).toBeUndefined();
		// The computer is free again.
		const b = await openUserBrowser(user, { deviceId: "dev1" }, d);
		expect(b.ok).toBe(true);
		if (b.ok) open.push(b.id);
	});

	it("refuses a computer that is not theirs, a bad address, and a runtime too old", async () => {
		const { deps: d } = deps();
		expect(await openUserBrowser(user, { deviceId: "other" }, d)).toMatchObject({
			ok: false,
			status: 404,
		});
		expect(
			await openUserBrowser(user, { deviceId: "dev1", url: "file:///etc/passwd" }, d)
		).toMatchObject({ ok: false, status: 400 });
		const old = deps({
			runtimeFor: () =>
				Object.assign(Object.create(new FakeBrowserRuntime(pages)), {
					control: undefined,
				}) as never,
		});
		expect(await openUserBrowser(user, { deviceId: "dev1" }, old.deps)).toMatchObject({
			ok: false,
			status: 501,
		});
	});

	it("closes itself when nobody watches for a while", async () => {
		const { deps: d } = deps({ idleMs: 30 });
		const r = await openUserBrowser(user, { deviceId: "dev1" }, d);
		if (!r.ok) throw new Error("open");
		await new Promise((x) => setTimeout(x, 120));
		expect(liveTaskFor(r.id, user.id.toString())).toBeUndefined();
	});
});
