import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import NotificationSettings from "./NotificationSettings.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const client = vi.hoisted(() => ({
	support: { ok: true } as { ok: true } | { ok: false; reason: string; message: string },
	subscription: null as null | { endpoint: string; unsubscribe: () => Promise<boolean> },
	enable: vi.fn(async (_key: string) => {}),
}));

vi.mock("$lib/utils/pushClient", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/utils/pushClient")>()),
	pushSupport: () => client.support,
	currentSubscription: async () => client.subscription,
	fingerprintOf: async (endpoint: string) => `fp-${endpoint}`,
	enableThisDevice: client.enable,
}));

interface Device {
	id: string;
	label: string;
	fingerprint: string;
	createdAt: string;
	lastPushAt: string | null;
}

const state = {
	configured: true,
	publicKey: "BPUBLICKEY",
	events: {
		permission: true,
		agentTurn: true,
		scheduleRun: true,
		backgroundTask: true,
		chatTurn: false,
	},
	devices: [] as Device[],
};
const calls: Array<{ method: string; url: string; body?: unknown }> = [];

function stubFetch(overrides: { configured?: boolean } = {}) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, url, body });
			if (method === "GET") {
				return Response.json({
					data: { ...state, configured: overrides.configured ?? state.configured },
				});
			}
			if (method === "POST" && url.endsWith("/test"))
				return Response.json({ data: { accepted: 1 } });
			return Response.json({ data: { ok: true } });
		})
	);
}

const device = (over: Partial<Device> = {}): Device => ({
	id: "d1",
	label: "Chrome on Linux",
	fingerprint: "fp-https://push.example/me",
	createdAt: "2026-10-01T10:00:00Z",
	lastPushAt: null,
	...over,
});

beforeEach(() => {
	calls.length = 0;
	client.support = { ok: true };
	client.subscription = null;
	client.enable.mockClear();
	state.devices = [];
	state.events = {
		permission: true,
		agentTurn: true,
		scheduleRun: true,
		backgroundTask: true,
		chatTurn: false,
	};
});
afterEach(() => vi.unstubAllGlobals());

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected an element");
	return value;
}
const switches = (container: HTMLElement) => [
	...container.querySelectorAll<HTMLElement>('[role="switch"]'),
];
const button = (container: HTMLElement, text: string) =>
	[...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as
		HTMLButtonElement | undefined;

describe("NotificationSettings", () => {
	it("says so when the deployment has no keys, and offers nothing", async () => {
		stubFetch({ configured: false });
		const { container } = renderWithApp(NotificationSettings);
		await expect
			.poll(() => container.querySelector('[data-testid="push-not-configured"]'))
			.not.toBeNull();
		expect(container.textContent).toContain("./configure");
		expect(button(container, "Turn on")).toBeUndefined();
		expect(switches(container)).toHaveLength(0);
	});

	it("asks the browser for permission only when Turn on is clicked", async () => {
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => button(container, "Turn on")).toBeDefined();
		expect(client.enable).not.toHaveBeenCalled();
		must(button(container, "Turn on")).click();
		await expect.poll(() => client.enable.mock.calls.length).toBe(1);
		expect(client.enable).toHaveBeenCalledWith("BPUBLICKEY");
	});

	it("explains the iPhone limitation instead of offering a button that cannot work", async () => {
		client.support = {
			ok: false,
			reason: "ios-install",
			message:
				"On an iPhone or iPad, notifications work only once the app is added to the Home Screen",
		};
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => container.textContent).toContain("Home Screen");
		expect(button(container, "Turn on")).toBeUndefined();
	});

	it("shows a blocked permission as a message", async () => {
		client.support = {
			ok: false,
			reason: "denied",
			message: "Notifications are blocked for this site",
		};
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => container.textContent).toContain("blocked for this site");
	});

	it("lists the five events with their stored state, and saves a toggle as a one-event patch", async () => {
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => switches(container).length).toBe(5);
		expect(container.textContent).toContain("An agent needs you");
		expect(container.textContent).toContain("A scheduled run finishes");
		expect(switches(container).map((s) => s.getAttribute("aria-checked"))).toEqual([
			"true",
			"true",
			"true",
			"true",
			"false",
		]);
		must(switches(container)[4]).click();
		await expect
			.poll(() => calls.find((c) => c.method === "PATCH"))
			.toMatchObject({ body: { events: { chatTurn: true } } });
	});

	it("lists devices, marks this one, and removes one", async () => {
		state.devices = [device(), device({ id: "d2", label: "Safari on iOS", fingerprint: "other" })];
		client.subscription = {
			endpoint: "https://push.example/me",
			unsubscribe: vi.fn(async () => true),
		};
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect
			.poll(() => container.querySelectorAll('[data-testid="push-device"]').length)
			.toBe(2);
		expect(container.querySelector('[data-testid="device-status"]')?.textContent).toContain("on");
		expect(container.textContent).toContain("This device");
		expect(button(container, "Turn on")).toBeUndefined();

		const removeOther = must(
			[...container.querySelectorAll("button")].filter((b) => b.textContent === "Remove")[1]
		);
		removeOther.click();
		await expect
			.poll(() => calls.find((c) => c.method === "DELETE")?.url)
			.toContain("/api/v2/push/d2");
		expect(client.subscription.unsubscribe).not.toHaveBeenCalled();
	});

	it("turning off this device also drops the browser's own subscription", async () => {
		state.devices = [device()];
		const unsubscribe = vi.fn(async () => true);
		client.subscription = { endpoint: "https://push.example/me", unsubscribe };
		stubFetch();
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => button(container, "Turn off")).toBeDefined();
		must(button(container, "Turn off")).click();
		await expect.poll(() => unsubscribe.mock.calls.length).toBe(1);
		expect(calls.find((c) => c.method === "DELETE")?.url).toContain("/api/v2/push/d1");
	});

	it("sends a test, enabled only with a device", async () => {
		stubFetch();
		const none = renderWithApp(NotificationSettings);
		await expect.poll(() => button(none.container, "Send a test notification")).toBeDefined();
		expect(must(button(none.container, "Send a test notification")).disabled).toBe(true);
		none.unmount();

		state.devices = [device()];
		const { container } = renderWithApp(NotificationSettings);
		await expect.poll(() => button(container, "Send a test notification")?.disabled).toBe(false);
		must(button(container, "Send a test notification")).click();
		await expect.poll(() => container.textContent).toContain("Sent to 1 device");
		expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/v2/push/test"))).toBe(
			true
		);
	});
});
