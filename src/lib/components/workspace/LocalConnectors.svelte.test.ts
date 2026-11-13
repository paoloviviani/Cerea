/**
 * The Local connectors tab (ADR 0102): the complete how-to while there is no paired machine,
 * collapsed behind "Add a computer" once there is one; approval of a machine that checked in;
 * and each machine's servers with their states.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import LocalConnectors from "./LocalConnectors.svelte";
import type { LocalMachineView } from "$lib/types/LocalConnectors";
import { renderWithApp, unmountRendered } from "../__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

function machine(overrides: Partial<LocalMachineView> & { id: string }): LocalMachineView {
	return {
		name: "laptop",
		status: "paired",
		mode: "connectors",
		online: true,
		createdAt: new Date().toISOString(),
		servers: [],
		...overrides,
	};
}

interface Seen {
	method: string;
	url: string;
	body?: string;
}

function stubApi(
	list: () => LocalMachineView[],
	seen: Seen[] = [],
	answer: (call: Seen) => Response | undefined = () => undefined
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const call = {
				method: init?.method ?? "GET",
				url: String(input),
				body: init?.body as string,
			};
			if (call.method === "GET") return Response.json({ machines: list() });
			seen.push(call);
			return answer(call) ?? Response.json({});
		})
	);
}

function mount(extraData: Record<string, unknown> = {}) {
	return renderWithApp(LocalConnectors, {} as never, {
		page: {
			url: "http://localhost:3000/workspace?tab=local",
			data: {
				codeOidcIssuerUrl: "https://auth.example.org",
				codeOidcClientId: "opencode-enrollment",
				...extraData,
			},
		},
	});
}

const text = (screen: ReturnType<typeof mount>) => screen.baseElement.textContent ?? "";

describe("LocalConnectors", () => {
	afterEach(() => {
		unmountRendered();
		vi.unstubAllGlobals();
	});

	it("says the administrator has not enabled it, instead of the how-to, without the capability", async () => {
		stubApi(() => []);
		const screen = mount({ localConnectorsDenied: "not_granted" });

		await expect
			.element(
				screen.getByText("Your administrator has not enabled local connectors for your groups.")
			)
			.toBeInTheDocument();
		expect(screen.baseElement.querySelector('[data-testid="local-howto"]')).toBeNull();
		expect(text(screen)).not.toContain("Connect a computer");
	});

	it("shows the browser card, with this deployment's commands, only when browser use is on", async () => {
		stubApi(() => [machine({ id: "m1", browser: "ready" }), machine({ id: "m2", name: "desk" })]);
		const off = mount();
		await expect.element(off.getByText("laptop").first()).toBeInTheDocument();
		expect(off.baseElement.querySelector('[data-testid="local-browser-card"]')).toBeNull();
		await off.unmount();

		stubApi(() => [machine({ id: "m1", browser: "ready" }), machine({ id: "m2", name: "desk" })]);
		const on = mount({ browserUseEnabled: true });
		await expect
			.element(on.getByRole("heading", { name: "Use the browser on your computer" }))
			.toBeInTheDocument();
		const byId = (id: string) =>
			on.baseElement.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
		// Status stays visible; the setup steps are folded away until asked for.
		expect(byId("local-browser-states")).toContain("Browser ready");
		expect(on.baseElement.querySelector('[data-testid="local-browser-setup-steps"]')).toBeNull();
		expect(on.baseElement.querySelector('[data-testid="local-browser-install"]')).toBeNull();
		expect(text(on)).not.toContain("Node.js 22.18");
		await on.getByRole("button", { name: "Set up a browser" }).click();
		expect(
			on.baseElement.querySelector('[data-testid="local-browser-toggle"]')?.textContent
		).toContain("Hide");
		expect(byId("local-browser-install")).toContain("http://localhost:3000/galopin/install.sh");
		expect(byId("local-browser-enroll")).toContain("--connectors-only");
		// Short by default: this Cerea tells the binary its issuer; the long form is one click away.
		expect(byId("local-browser-enroll")).not.toContain("--issuer");
		expect(byId("local-browser-enroll")).toContain("--cerea 'http://localhost:3000'");
		expect(byId("local-browser-explicit")).toContain("--issuer 'https://auth.example.org'");
		expect(text(on)).toContain("Using an older galopin?");
		expect(byId("local-browser-setup")).toBe(
			"~/.local/bin/galopin browser setup\n~/.local/bin/galopin browser enable"
		);
		expect(byId("local-browser-run")).toBe("~/.local/bin/galopin run");
		expect(text(on)).toContain("Node.js 22.18");
		expect(byId("local-browser-states")).toContain("Browser ready");
		expect(byId("local-browser-states")).toContain("No browser registered yet");
	});

	it("shows the machine's browser instead of saying it lists no servers", async () => {
		stubApi(() => [
			machine({ id: "m1", browser: "ready" }),
			machine({ id: "m2", name: "desk", browser: "problem" }),
			machine({ id: "m3", name: "bare" }),
		]);
		const screen = mount();
		await expect.element(screen.getByText("Browser: ready")).toBeInTheDocument();
		await expect.element(screen.getByText("Browser: not responding")).toBeInTheDocument();
		// Only the machine with neither server nor browser says it lists none.
		expect(text(screen).match(/It lists no servers yet/g)?.length).toBe(1);
	});

	it("hides the browser card without local-connectors access", async () => {
		stubApi(() => []);
		const screen = mount({ browserUseEnabled: true, localConnectorsDenied: "not_granted" });
		await expect.element(screen.getByText(/has not enabled local connectors/)).toBeInTheDocument();
		expect(screen.baseElement.querySelector('[data-testid="local-browser-card"]')).toBeNull();
	});

	it("says the gateway is not configured for the chat when it reports neither capability", async () => {
		stubApi(() => []);
		const screen = mount({ localConnectorsDenied: "not_configured" });
		await expect.element(screen.getByText(/not configured for the chat/)).toBeInTheDocument();
		expect(screen.baseElement.querySelector('[data-testid="local-howto"]')).toBeNull();
	});

	it("shows the whole how-to, with this deployment's address, while no machine is paired", async () => {
		stubApi(() => []);
		const screen = mount();

		await expect
			.element(screen.getByRole("heading", { name: "Connect a computer" }))
			.toBeInTheDocument();
		const byId = (id: string) =>
			screen.baseElement.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
		expect(byId("local-install-command")).toBe(
			"curl -fsSL 'http://localhost:3000/galopin/install.sh' | sh"
		);
		const enroll = byId("local-enroll-command");
		expect(enroll).toContain("galopin enroll");
		expect(enroll).toContain("--connectors-only");
		expect(enroll).not.toContain("--issuer");
		expect(byId("local-explicit")).toContain("--issuer 'https://auth.example.org'");
		expect(enroll).toContain("--cerea 'http://localhost:3000'");
		// A connectors machine needs no gateway, and the default client id is not printed.
		expect(enroll).not.toContain("--gateway");
		expect(enroll).not.toContain("--client-id");
		expect(byId("local-run-command")).toBe("~/.local/bin/galopin run");
		// mcp.json: where it lives per OS, the Claude format, allowedTools, no restart, then approve.
		expect(text(screen)).toContain("~/.config/galopin/mcp.json");
		expect(text(screen)).toContain("~/Library/Application Support/galopin/mcp.json");
		expect(text(screen)).toContain("galopin run --mcp-config /path/to/claude_desktop_config.json");
		expect(byId("local-mcp-json")).toContain('"mcpServers"');
		expect(byId("local-mcp-json")).toContain('"command": "npx"');
		expect(byId("local-mcp-json")).toContain('"type": "http"');
		expect(text(screen)).toContain("allowedTools");
		expect(text(screen)).toContain("picked up without a restart");
		expect(text(screen)).toContain("Approve the computer below");
		expect(text(screen)).toContain("systemctl --user enable --now galopin");
		// Copy buttons beside the commands.
		expect(
			screen.baseElement.querySelectorAll("[data-testid^='local-'] + button").length
		).toBeGreaterThan(2);
	});

	it("collapses the how-to behind Add a machine once a connectors machine is paired", async () => {
		stubApi(() => [machine({ id: "m1" })]);
		const screen = mount();

		await expect.element(screen.getByText("Your computers (1)")).toBeInTheDocument();
		expect(screen.baseElement.querySelector('[data-testid="local-howto"]')).toBeNull();
		await screen.getByRole("button", { name: "Add a computer" }).click();
		await expect
			.element(screen.getByRole("heading", { name: "Connect a computer" }))
			.toBeInTheDocument();
	});

	it("lists a pending machine and approves it with a confirm", async () => {
		const seen: Seen[] = [];
		let approved = false;
		stubApi(
			() => [machine({ id: "m1", status: approved ? "paired" : "pending" })],
			seen,
			(call) => {
				if (call.method === "PATCH") approved = true;
				return undefined;
			}
		);
		const screen = mount();

		await expect.element(screen.getByText("Waiting for approval (1)")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Approve" }).click();
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].method).toBe("PATCH");
		expect(seen[0].url).toContain("/api/v2/local-connectors/machines/m1");
		expect(JSON.parse(seen[0].body as string)).toEqual({ action: "confirm" });
		await expect.element(screen.getByText("Your computers (1)")).toBeInTheDocument();
	});

	it("asks for a fresh sign-in when approval is refused for an old one", async () => {
		stubApi(
			() => [machine({ id: "m1", status: "pending" })],
			[],
			(call) =>
				call.method === "PATCH"
					? Response.json({ code: "reauth_required", message: "old" }, { status: 401 })
					: undefined
		);
		const screen = mount();
		await screen.getByRole("button", { name: "Approve" }).click();
		await expect
			.element(screen.getByText("Sign in again to approve a computer."))
			.toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Sign in again" });
		await expect.element(link).toHaveAttribute("href", expect.stringContaining("reauth=1"));
	});

	it("rejects a pending machine with the revoking delete", async () => {
		const seen: Seen[] = [];
		stubApi(() => [machine({ id: "m1", status: "pending" })], seen);
		const screen = mount();
		await screen.getByRole("button", { name: "Reject" }).click();
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].method).toBe("DELETE");
	});

	it("shows each server with its state, the reason when it is not ready, and offline machines as offline", async () => {
		stubApi(() => [
			machine({
				id: "m1",
				servers: [
					{ id: "local:m1:notes", name: "notes", transport: "stdio", state: "ready" },
					{
						id: "local:m1:crm",
						name: "crm",
						transport: "http",
						state: "needs-login",
						detail: "Run `galopin connectors login crm` on this machine.",
					},
					{ id: "local:m1:old", name: "old", transport: "sse", state: "disabled" },
					{
						id: "local:m1:broken",
						name: "broken",
						transport: "stdio",
						state: "invalid",
						detail: "${API_KEY} is not set",
					},
				],
			}),
			machine({
				id: "m2",
				name: "server",
				online: false,
				servers: [{ id: "local:m2:notes", name: "notes", transport: "stdio", state: "offline" }],
			}),
		]);
		const screen = mount();
		await expect.element(screen.getByText("Your computers (2)")).toBeInTheDocument();
		const body = text(screen);
		for (const word of ["Ready", "Needs sign-in", "Disabled", "Invalid", "Offline", "Connected"]) {
			expect(body, word).toContain(word);
		}
		expect(body).toContain("Needs a sign-in");
		expect(body).toContain("galopin connectors login crm");
		expect(body).toContain("${API_KEY} is not set");
	});

	it("revokes only after a confirmation, and never offers it for an agent machine", async () => {
		const seen: Seen[] = [];
		vi.stubGlobal("confirm", () => true);
		stubApi(
			() => [machine({ id: "m1" }), machine({ id: "m2", name: "coder", mode: "agent" })],
			seen
		);
		const screen = mount();
		await expect.element(screen.getByText("Your computers (2)")).toBeInTheDocument();
		const revokes = screen.getByRole("button", { name: "Revoke" });
		await expect.element(revokes).toBeInTheDocument();
		expect(screen.baseElement.querySelectorAll("button").length).toBeGreaterThan(0);
		await revokes.click();
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0]).toMatchObject({ method: "DELETE" });
		expect(seen[0].url).toContain("/machines/m1");
		expect(text(screen)).toContain("Managed in the Agents panel");
	});

	describe("browser actions on a computer's card", () => {
		const openButton = (screen: ReturnType<typeof mount>) =>
			screen.baseElement.querySelector<HTMLButtonElement>(
				'[data-testid="local-machine-open-browser"]'
			);
		const defaultBox = (screen: ReturnType<typeof mount>) =>
			screen.baseElement.querySelector<HTMLInputElement>(
				'[data-testid="local-machine-browser-default"]'
			);

		it("shows Open browser and the default toggle beside 'Browser: ready', only when browser use is on", async () => {
			stubApi(() => [machine({ id: "m1", browser: "ready" })]);
			const off = mount();
			await expect.element(off.getByText("Browser: ready")).toBeInTheDocument();
			expect(openButton(off)).toBeNull();
			expect(defaultBox(off)).toBeNull();
			await off.unmount();

			stubApi(() => [machine({ id: "m1", browser: "ready" })]);
			const on = mount({ browserUseEnabled: true });
			await expect.element(on.getByText("Browser: ready")).toBeInTheDocument();
			expect(openButton(on)?.textContent).toContain("Open browser");
			expect(text(on)).toContain("Use for browsing by default");
		});

		it("has no Open browser for a computer that is offline or whose browser is not ready", async () => {
			stubApi(() => [
				machine({ id: "m1", name: "a", browser: "problem" }),
				machine({ id: "m2", name: "b", browser: "offline", online: false }),
			]);
			const screen = mount({ browserUseEnabled: true });
			await expect.element(screen.getByText("Browser: not responding")).toBeInTheDocument();
			expect(openButton(screen)).toBeNull();
		});

		it("opens a page tied to no chat, and says where", async () => {
			const seen: Seen[] = [];
			stubApi(
				() => [machine({ id: "m1", name: "Laptop", browser: "ready" })],
				seen,
				(call) =>
					call.url.endsWith("/api/v2/browser/open")
						? Response.json({ opened: true, computer: "Laptop", tied: false })
						: undefined
			);
			const screen = mount({ browserUseEnabled: true });
			await expect.element(screen.getByText("Browser: ready")).toBeInTheDocument();
			openButton(screen)?.click();
			await vi.waitFor(() => expect(seen).toHaveLength(1));
			expect(seen[0].method).toBe("POST");
			expect(seen[0].url).toContain("/api/v2/browser/open");
			// No conversation: nothing here ties the page to a chat.
			expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ deviceId: "m1" });
		});

		it("shows the server's reason when it cannot open (busy)", async () => {
			stubApi(
				() => [machine({ id: "m1", browser: "ready" })],
				[],
				(call) =>
					call.url.endsWith("/api/v2/browser/open")
						? Response.json(
								{ error: "busy", message: "The browser on laptop is busy with a task." },
								{ status: 409 }
							)
						: undefined
			);
			const screen = mount({ browserUseEnabled: true });
			await expect.element(screen.getByText("Browser: ready")).toBeInTheDocument();
			openButton(screen)?.click();
			await expect
				.element(screen.getByText("The browser on laptop is busy with a task."))
				.toBeInTheDocument();
		});

		it("sets and clears the default computer", async () => {
			const seen: Seen[] = [];
			stubApi(() => [machine({ id: "m1", browser: "ready" })], seen);
			const screen = mount({ browserUseEnabled: true });
			await expect.element(screen.getByText("Browser: ready")).toBeInTheDocument();
			expect(defaultBox(screen)?.checked).toBe(false);
			defaultBox(screen)?.click();
			await vi.waitFor(() => expect(seen).toHaveLength(1));
			expect(seen[0]).toMatchObject({ method: "PUT" });
			expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ deviceId: "m1" });
			await vi.waitFor(() => expect(defaultBox(screen)?.checked).toBe(true));
			defaultBox(screen)?.click();
			await vi.waitFor(() => expect(seen).toHaveLength(2));
			expect(JSON.parse(seen[1].body ?? "{}")).toEqual({ deviceId: null });
		});

		it("shows which computer is the default", async () => {
			stubApi(() => [
				machine({ id: "m1", name: "a", browser: "ready", browserDefault: true }),
				machine({ id: "m2", name: "b", browser: "ready" }),
			]);
			const screen = mount({ browserUseEnabled: true });
			await expect.element(screen.getByText("a").first()).toBeInTheDocument();
			const boxes = () => [
				...screen.baseElement.querySelectorAll<HTMLInputElement>(
					'[data-testid="local-machine-browser-default"]'
				),
			];
			await vi.waitFor(() => expect(boxes()).toHaveLength(2));
			expect(boxes().map((b) => b.checked)).toEqual([true, false]);
		});
	});
});
