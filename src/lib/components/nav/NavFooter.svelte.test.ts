import NavFooter from "./NavFooter.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

/**
 * The footer is static by design — it replaced `UserMenu`, whose every
 * affordance opened a popup. These checks pin the three things it must do:
 * name the person, flip the theme, sign out with a form post.
 */
describe("NavFooter", () => {
	let host: HTMLElement;

	beforeEach(() => {
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		host.remove();
		// The flip wrote a preference; leave the page as this file found it, so
		// the files after this one do not inherit a dark theme.
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
	});

	function mount(user: object | null) {
		return renderWithApp(NavFooter, { user } as never, { baseElement: host });
	}

	it("shows the person's tag and name, and opens no menu", () => {
		const screen = mount({ username: "ada.lovelace" });

		expect(screen.getByText("ada.lovelace")).toBeInTheDocument();
		// The initials chip: two letters from the name.
		expect(screen.getByText("AL")).toBeInTheDocument();
		expect(host.querySelector("[aria-haspopup]")).toBeNull();
	});

	it("signs out with a form post to /logout, not a link", () => {
		mount({ email: "ada@example.com" });

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

		const toggle = screen.getByRole("button", { name: "Switch to dark theme" });
		await toggle.click();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		await screen.getByRole("button", { name: "Switch to light theme" }).click();
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});
});
