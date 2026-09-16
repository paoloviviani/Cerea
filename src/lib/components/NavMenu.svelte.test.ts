import NavMenu from "./NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// NavMenu mounts ProjectsManager, whose MCP-defaults checklist reads the
// connector stores: those read a deployment name off the environment at
// module scope, and the bare name is all a test needs (same mock as the
// ConnectorsSection suite).
vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

/**
 * The sidebar's foot, after the managers moved into the workspace and the
 * profile menu became a static footer: Workspace, Settings and (for
 * administrators) Admin are rows; the footer names the person and carries the
 * theme switch and the sign-out form inline. Models, Knowledge and MCP Servers
 * are no longer rows here at all.
 */
describe("NavMenu's foot", () => {
	let host: HTMLElement;

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ conversations: [] }))
		);
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		host.remove();
	});

	function mount(user: object | null, gatewayIsAdmin = false) {
		return renderWithApp(NavMenu, { conversations: [], user, gatewayIsAdmin } as never, {
			page: { data: { models: [] } },
			baseElement: host,
		});
	}

	it("rows point at the workspace and the settings, and no manager rows remain", () => {
		mount({ username: "ada" });

		expect(host.querySelector('a[href="/workspace"]')).not.toBeNull();
		expect(host.querySelector('a[href="/settings/application"]')).not.toBeNull();
		// Strip the tags: a row's label may be followed by other nodes.
		const text = (host.textContent ?? "").replace(/\s+/g, " ");
		expect(text).not.toContain("Knowledge");
		expect(text).not.toContain("MCP Servers");
		expect(host.querySelector("[aria-haspopup]")).toBeNull();
	});

	it("the Admin row renders only for an administrator", () => {
		const notAdmin = mount({ username: "ada" }, false);
		expect((host.textContent ?? "").includes("Admin")).toBe(false);
		notAdmin.unmount();

		mount({ username: "ada" }, true);
		expect(host.querySelector('a[href="/admin"]')).not.toBeNull();
	});

	it("the signed-out panel keeps the rows and has no footer", () => {
		mount(null);

		expect(host.querySelector('a[href="/workspace"]')).not.toBeNull();
		expect(host.querySelector('a[href="/settings/application"]')).not.toBeNull();
		expect(host.querySelector("form")).toBeNull();
	});

	it("the footer names the person and posts the sign-out", () => {
		const screen = mount({ username: "ada" });

		expect(screen.getByText("ada")).toBeInTheDocument();
		const form = host.querySelector('form[action="/logout"]');
		expect(form).not.toBeNull();
		expect(form?.getAttribute("method")).toBe("POST");
	});
});
