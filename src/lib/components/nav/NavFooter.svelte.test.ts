import NavFooter from "./NavFooter.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import superjson from "superjson";
import { appReload } from "$lib/utils/appReload";
import type { UsageReport } from "$lib/types/UsageReport";

/**
 * The foot of the sidebar is the user row and its menu. These checks pin what
 * the menu holds (and what it hides), the quota summary's states, and the
 * three things it always did: flip the theme, reload, sign out with a form post.
 */
describe("NavFooter user menu", () => {
	let host: HTMLElement;
	let usage: UsageReport | "fail" = { sections: [] };
	let usageCalls = 0;

	beforeEach(() => {
		usage = { sections: [] };
		usageCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input).includes("/api/v2/usage")) {
					usageCalls++;
					return usage === "fail"
						? new Response("nope", { status: 500 })
						: new Response(superjson.stringify(usage), { status: 200 });
				}
				return Response.json({});
			})
		);
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
		host = document.createElement("div");
		host.id = "app";
		// The menu opens upward from the row, so give it room above, as the real
		// sidebar has: a menu above the top of the page cannot be clicked.
		host.style.paddingTop = "420px";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		host.remove();
		// The flip wrote a preference; leave the page as this file found it, so
		// the files after this one do not inherit a dark theme.
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
	});

	function mount(
		user: object | null,
		data: Record<string, unknown> = {},
		props: Record<string, unknown> = {}
	) {
		return renderWithApp(NavFooter, { user, ...props } as never, {
			baseElement: host,
			page: { data },
		});
	}

	const menu = () => host.querySelector('[data-testid="user-menu"]');
	async function open(screen: ReturnType<typeof mount>) {
		await screen.getByTestId("user-menu-button").click();
		await vi.waitFor(() => expect(menu()).not.toBeNull());
	}

	it("shows the person's tag and name, with the menu closed", () => {
		const screen = mount({ username: "ada.lovelace" });

		expect(screen.getByText("ada.lovelace")).toBeInTheDocument();
		// The initials chip: two letters from the name.
		expect(screen.getByText("AL")).toBeInTheDocument();
		expect(menu()).toBeNull();
		expect(host.querySelector("[aria-haspopup='menu']")).not.toBeNull();
		expect(host.querySelector("form")).toBeNull();
	});

	it("opens on the name, closes on Escape and on a click outside", async () => {
		const screen = mount({ username: "ada" });
		await open(screen);
		expect(
			host.querySelector('[data-testid="user-menu-button"]')?.getAttribute("aria-expanded")
		).toBe("true");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await vi.waitFor(() => expect(menu()).toBeNull());

		await open(screen);
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await vi.waitFor(() => expect(menu()).toBeNull());
	});

	it("holds Settings, the theme switch, Reload and Sign out for everyone, in that order", async () => {
		const screen = mount({ username: "ada" });
		await open(screen);
		const items = [...(menu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((el) =>
			(el.textContent ?? "").trim()
		);
		expect(items).toEqual(["Settings", "Dark theme", "Reload", "Sign out"]);
		expect(menu()?.querySelector('a[href="/settings/application"]')).not.toBeNull();
	});

	it("shows Admin only for an administrator", async () => {
		const plain = mount({ username: "ada" }, {}, { gatewayIsAdmin: false });
		await open(plain);
		expect(menu()?.querySelector('a[href="/admin"]')).toBeNull();
		plain.unmount();

		const admin = mount({ username: "ada" }, {}, { gatewayIsAdmin: true });
		await open(admin);
		expect(menu()?.querySelector('a[href="/admin"]')).not.toBeNull();
	});

	it("shows the Console link only when the deployment has a console this user may open", async () => {
		const without = mount({ username: "ada" }, { consoleEnabled: false });
		await open(without);
		expect(menu()?.querySelector('[data-testid="user-menu-console"]')).toBeNull();
		without.unmount();

		const withConsole = mount({ username: "ada" }, { consoleEnabled: true });
		await open(withConsole);
		const link = menu()?.querySelector('[data-testid="user-menu-console"]');
		// The same address the Admin page's Console button uses: same origin, not under the app base.
		expect(link?.getAttribute("href")).toBe("/console");
		expect(link?.textContent?.trim()).toBe("Console");
	});

	describe("quota summary", () => {
		const quota = () => menu()?.querySelector('[data-testid="user-menu-quota"]');

		it("is absent, and asks nothing, when usage is off in this deployment", async () => {
			const screen = mount({ username: "ada" }, { usageEnabled: false });
			await open(screen);
			expect(quota()).toBeNull();
			expect(usageCalls).toBe(0);
		});

		it("shows spend against the limit with a thin bar, the period, and a link to Usage", async () => {
			usage = {
				sections: [
					{
						title: "Quotas",
						entries: [
							{
								label: "Spend",
								used: 12,
								limit: 50,
								unit: "EUR",
								period: "per month",
								scope: "user",
							},
						],
					},
				],
			};
			const screen = mount({ username: "ada" }, { usageEnabled: true });
			await open(screen);
			await vi.waitFor(() => expect(quota()).not.toBeNull());
			expect(quota()?.getAttribute("href")).toBe("/settings/usage");
			expect(quota()?.textContent).toContain("€12.00 of €50.00");
			expect(quota()?.textContent).toContain("per month");
			const bar = quota()?.querySelector('[role="progressbar"]');
			expect(bar?.getAttribute("aria-valuenow")).toBe("12");
			expect(bar?.getAttribute("data-near")).toBe("false");
			expect(bar?.querySelector(".bg-blue-600")).not.toBeNull();
		});

		it("turns the bar amber near the limit", async () => {
			usage = {
				sections: [
					{
						title: "Quotas",
						entries: [{ label: "Spend", used: 45, limit: 50, unit: "EUR", scope: "user" }],
					},
				],
			};
			const screen = mount({ username: "ada" }, { usageEnabled: true });
			await open(screen);
			await vi.waitFor(() => expect(quota()).not.toBeNull());
			const bar = quota()?.querySelector('[role="progressbar"]');
			expect(bar?.getAttribute("data-near")).toBe("true");
			expect(bar?.querySelector(".bg-amber-500")).not.toBeNull();
		});

		it("shows the spend alone, with no bar, when there is no limit", async () => {
			usage = {
				sections: [
					{
						title: "Spend",
						entries: [{ label: "Spend", used: 3.5, unit: "EUR", period: "this month" }],
					},
				],
			};
			const screen = mount({ username: "ada" }, { usageEnabled: true });
			await open(screen);
			await vi.waitFor(() => expect(quota()).not.toBeNull());
			expect(quota()?.textContent).toContain("€3.50 spent");
			expect(quota()?.querySelector('[role="progressbar"]')).toBeNull();
		});

		it("is absent when the report has nothing to show or cannot be read", async () => {
			usage = {
				sections: [
					{
						title: "Shared",
						entries: [{ label: "Team", unit: "EUR", limit: 10, noFigures: true }],
					},
				],
			};
			const screen = mount({ username: "ada" }, { usageEnabled: true });
			await open(screen);
			await vi.waitFor(() => expect(usageCalls).toBe(1));
			expect(quota()).toBeNull();
			screen.unmount();

			usage = "fail";
			const failing = mount({ username: "ada" }, { usageEnabled: true });
			await open(failing);
			await vi.waitFor(() => expect(usageCalls).toBe(2));
			expect(quota()).toBeNull();
			expect(menu()?.querySelector('a[href="/settings/application"]')).not.toBeNull();
		});
	});

	it("signs out with a form post to /logout, not a link", async () => {
		const screen = mount({ email: "ada@example.com" });
		await open(screen);

		// A `<form method="POST">`, because `POST /logout` deletes the session
		// server-side — a GET would make signing somebody out something a
		// prefetch could do to them.
		const form = host.querySelector("form");
		expect(form).not.toBeNull();
		expect(form?.getAttribute("method")).toBe("POST");
		expect(form?.getAttribute("action")).toBe("/logout");
		expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
	});

	it("the theme switch flips dark and back", async () => {
		const screen = mount({ username: "ada" });
		await open(screen);

		await screen.getByRole("menuitem", { name: "Dark theme" }).click();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		await screen.getByRole("menuitem", { name: "Light theme" }).click();
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("has a Reload item that reloads the page (a PWA has no other way)", async () => {
		const spy = vi.spyOn(appReload, "reload").mockImplementation(() => {});
		const screen = mount({ username: "ada" });
		await open(screen);
		await screen.getByRole("menuitem", { name: "Reload" }).click();
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});
