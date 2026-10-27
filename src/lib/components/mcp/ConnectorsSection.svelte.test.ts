/**
 * The MCP overlay's two connector lists, and what each row may do (ADR 0064).
 *
 * Deployment connectors — somebody else's decision, offered to everybody —
 * sit in their own section, and their rows carry no Remove button whoever is
 * looking. The server refuses such a delete too (`mcp-connector-delete`),
 * but the button not being there is what stops the mistake rather than an
 * error after it; an administrator removes deployment connectors from the
 * admin screen, whose Remove names `?scope=deployment`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { page } from "@vitest/browser/context";

import ConnectorsSection from "./ConnectorsSection.svelte";
import type { McpConnectorView } from "$lib/types/McpConnector";
import { connectors } from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import type { MCPServer } from "$lib/types/Tool";
import { renderWithApp } from "../__tests__/renderWithApp";

// The client setup mocks `$app/*` but not `$env/dynamic/*`: the store behind
// this component reads a deployment name off the environment at module scope,
// and the bare name is all a test needs.
vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

function connector(overrides: Partial<McpConnectorView> & { id: string }): McpConnectorView {
	return {
		key: `connector:${overrides.id}`,
		enabled: true,
		name: `Server ${overrides.id}`,
		url: `https://${overrides.id}.test/mcp`,
		auth: "none",
		scope: "user",
		manageable: true,
		connected: true,
		canAuthorize: false,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

const MINE = () => connector({ id: "c-mine", name: "Mine" });
const SHARED = (manageable: boolean) =>
	connector({
		id: "c-shared",
		name: "Shared",
		auth: "oauth",
		scope: "deployment",
		manageable,
		connected: false,
		canAuthorize: true,
	});

/** Serve the connector list this render should see, and record anything else. */
function stubApi(
	list: McpConnectorView[],
	seen: { method: string; url: string; body?: unknown }[] = [],
	switchStatus = 200
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.includes("/api/v2/mcp/connectors") && method === "GET") {
				return Response.json({ data: list });
			}
			seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url.includes("/api/v2/mcp/switches")) {
				return Response.json(
					switchStatus === 200 ? {} : { message: "Your administrator keeps this on." },
					{ status: switchStatus }
				);
			}
			return Response.json({});
		})
	);
}

/** The buttons inside one section, named by their text. */
function sectionButtons(baseElement: HTMLElement, heading: string): (string | undefined)[] {
	const head = [...baseElement.querySelectorAll("h3")].find(
		(element) => element.textContent === heading
	);
	expect(head, `section “${heading}”`).not.toBeUndefined();
	// The heading sits directly in its section's wrapper, beside its grid.
	const section = head?.closest("div") as HTMLElement;
	return [...section.querySelectorAll("button")].map((button) => button.textContent?.trim());
}

/** One mount. The `as never` is `renderWithApp`'s generic failing to see a
 * runes component's props — the shape is right, the inference is not. */
function mount() {
	return renderWithApp(ConnectorsSection, { onclose: () => {} } as never);
}

describe("ConnectorsSection", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		// The store is module state and survives the mount: without this, a
		// heading the previous render left behind satisfies the next test's
		// retrying assertion while the list it reads is still the old one.
		connectors.set([]);
		allMcpServers.set([]);
	});

	it("lists an administrator's connectors apart from the person's own", async () => {
		stubApi([MINE(), SHARED(false)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByText("Built-in connectors (1)", { exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Mine", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Shared", { exact: true })).toBeInTheDocument();
	});

	it("offers Remove on the person's own row and nowhere else", async () => {
		stubApi([MINE(), SHARED(false)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();

		const removes = [...screen.baseElement.querySelectorAll("button")].filter((button) =>
			button.textContent?.includes("Remove")
		);
		// Exactly the one: the deployment row is not anybody's to delete from here.
		expect(removes).toHaveLength(1);
		const card = removes[0].closest("div.rounded-lg");
		expect(card?.textContent).toContain("Mine");
	});

	it("removes the person's own connector with the overlay's plain delete", async () => {
		const seen: { method: string; url: string }[] = [];
		stubApi([MINE()], seen);
		vi.stubGlobal("confirm", () => true);
		const screen = mount();

		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();
		const remove = [...screen.baseElement.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Remove")
		);
		expect(remove).not.toBeUndefined();
		remove?.click();

		await vi.waitFor(() => expect(seen.some((call) => call.method === "DELETE")).toBe(true));
		// The overlay's delete names the connector and nothing else. Naming
		// the `deployment` scope is the admin screen's sentence, and without
		// it the server refuses a deployment row whoever sends it.
		expect(seen.map((call) => call.url)).toEqual(["/api/v2/mcp/connectors/c-mine"]);
	});

	it("still lets an administrator change a deployment connector here, but not remove it", async () => {
		stubApi([MINE(), SHARED(true)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Built-in connectors (1)", { exact: true }))
			.toBeInTheDocument();
		const names = sectionButtons(screen.baseElement, "Built-in connectors (1)");
		// Manageable stays: editing and re-checking somebody else's deployment
		// connector is still an administrator's job. Removal left for the
		// admin screen, which is the only place that confirms "for everyone".
		expect(names).toContain("Edit");
		expect(names).toContain("Check");
		expect(names.some((name) => name?.includes("Remove"))).toBe(false);
	});

	it("hides the changing buttons from a deployment row its reader may only use", async () => {
		stubApi([SHARED(false)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Built-in connectors (1)", { exact: true }))
			.toBeInTheDocument();
		const names = sectionButtons(screen.baseElement, "Built-in connectors (1)");
		// These were buttons whose requests the server was already refusing;
		// `manageable` is the server saying so, and the row finally listens.
		expect(names).not.toContain("Edit");
		expect(names).not.toContain("Check");
		// Using it is still theirs: the switch and the sign-in stay.
		expect(names).toContain("Sign in");
		expect(names.some((name) => name?.includes("Remove"))).toBe(false);
	});
});

describe("ConnectorsSection: adding a token to a connector the probe could not work out", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		connectors.set([]);
	});

	it("offers a token field on a no-auth connector and sends what is typed", async () => {
		// What auto mode leaves behind for a server that answered a bare 401:
		// no sign-in, and a row error telling the person to add a token.
		const jmcp = connector({
			id: "c-jmcp",
			name: "jmcp",
			auth: "none",
			lastError: "it asks for authentication but offers no OAuth sign-in",
		});
		const updates: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const method = init?.method ?? "GET";
				if (String(input).includes("/api/v2/mcp/connectors") && method === "GET") {
					return Response.json({ data: [jmcp] });
				}
				updates.push(JSON.parse(String(init?.body ?? "{}")));
				return Response.json({});
			})
		);
		const screen = mount();

		await expect.element(screen.getByText("jmcp", { exact: true })).toBeInTheDocument();
		const edit = [...screen.baseElement.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Edit"
		);
		edit?.click();

		const token = await vi.waitFor(() => {
			const field = screen.baseElement.querySelector<HTMLInputElement>('input[type="password"]');
			expect(field).not.toBeNull();
			return field as HTMLInputElement;
		});
		// Nothing stored yet, so there is nothing to remove.
		expect(screen.baseElement.textContent).not.toContain("Remove the saved access key");

		token.value = "secret-token";
		token.dispatchEvent(new Event("input", { bubbles: true }));
		const save = [...screen.baseElement.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Save changes"
		);
		save?.click();

		await vi.waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0]).toMatchObject({ action: "update", token: "secret-token" });
	});
});

describe("ConnectorsSection: servers on the person's own machines (ADR 0102)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		connectors.set([]);
	});

	function local(
		server: string,
		state: NonNullable<McpConnectorView["local"]>["state"],
		extra: Partial<NonNullable<McpConnectorView["local"]>> = {}
	): McpConnectorView {
		return connector({
			id: `local:dev1:${server}`,
			name: `${server} · on laptop`,
			url: "",
			connected: state === "ready",
			canAuthorize: state === "needs-login" && (extra.transport ?? "stdio") === "http",
			auth: state === "needs-login" ? "oauth" : "none",
			manageable: false,
			local: {
				deviceId: "dev1",
				machineName: "laptop",
				server,
				transport: "stdio",
				state,
				...extra,
			},
		});
	}

	const pills = (screen: ReturnType<typeof mount>) =>
		[...screen.baseElement.querySelectorAll('[data-testid="local-pill"]')].map((el) =>
			el.textContent?.trim()
		);

	it("lists them in their own section, named for the server, with the machine on a second line, with a green 'on' pill while ready", async () => {
		stubApi([MINE(), local("notes", "ready", { description: "My notes folder" })]);
		const screen = mount();

		await expect
			.element(screen.getByText("On your machines (1)", { exact: false }))
			.toBeInTheDocument();
		// Not among the person's own, which still counts one.
		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("notes", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("My notes folder")).toBeInTheDocument();
		expect(pills(screen)).toEqual(["on"]);
		const pill = screen.baseElement.querySelector('[data-testid="local-pill"]') as HTMLElement;
		expect(pill.className).toContain("bg-green-100");
	});

	it("says why a server is not on: offline, needs login (with the command), disabled, invalid (with the detail)", async () => {
		stubApi([
			local("a", "offline", { detail: "laptop is not connected. Start galopin there to use it." }),
			local("b", "needs-login", {
				transport: "sse",
				detail: "Run `galopin connectors login b` on this machine.",
			}),
			local("c", "disabled"),
			local("d", "invalid", { detail: "${API_KEY} is not set" }),
		]);
		const screen = mount();
		await expect
			.element(screen.getByText("On your machines (4)", { exact: false }))
			.toBeInTheDocument();
		expect(pills(screen)).toEqual(["Offline", "Needs sign-in", "Disabled", "Invalid"]);
		const body = screen.baseElement.textContent ?? "";
		expect(body).toContain("Start galopin there to use it.");
		expect(body).toContain("galopin connectors login b");
		expect(body).toContain("${API_KEY} is not set");
		// Nothing to switch on while it is unavailable, and nothing a machine's file defines is editable here.
		const buttons = [...screen.baseElement.querySelectorAll("button")].map((b) =>
			b.textContent?.trim()
		);
		for (const forbidden of ["Edit", "Check", "Remove", "Sign in"]) {
			expect(
				buttons.some((b) => b === forbidden || b?.includes(forbidden)),
				forbidden
			).toBe(false);
		}
	});

	it("shows nothing for a person with no local connectors", async () => {
		stubApi([MINE()]);
		const screen = mount();
		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();
		expect(screen.baseElement.querySelector('[data-testid="local-section"]')).toBeNull();
	});

	it("starts a chat-side sign-in for a local http server that needs one, and returns to this page", async () => {
		const seen: { url: string; body: Record<string, unknown> }[] = [];
		const landing = `${window.location.href.split("#")[0]}#local-signin`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/v2/mcp/connectors") && (init?.method ?? "GET") === "GET") {
					return Response.json({ data: [local("crm", "needs-login", { transport: "http" })] });
				}
				seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
				// A same-page address, so following it does not leave the test.
				return Response.json({ authorizeUrl: landing });
			})
		);
		const screen = mount();
		await expect.element(screen.getByText("crm", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Sign in" }).click();

		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].url).toContain("/api/v2/local-connectors/oauth/start");
		expect(seen[0].body.connectorId).toBe("local:dev1:crm");
		expect(typeof seen[0].body.next).toBe("string");
		expect(window.location.hash).toBe("#local-signin");
		window.location.hash = "";
	});

	it("shows a clear error when the machine cannot be signed in to (offline)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/v2/mcp/connectors") && (init?.method ?? "GET") === "GET") {
					return Response.json({ data: [local("crm", "needs-login", { transport: "http" })] });
				}
				return Response.json(
					{ message: "laptop is offline. Start galopin there first." },
					{ status: 409 }
				);
			})
		);
		const screen = mount();
		await expect.element(screen.getByText("crm", { exact: true })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Sign in" }).click();
		await expect
			.element(screen.getByText("laptop is offline. Start galopin there first."))
			.toBeInTheDocument();
	});
});

describe("ConnectorsSection: cards on a phone, and the detail sheet", () => {
	const LONG = ["kdrive-personal", "kdrive-photos"];

	function localOf(
		server: string,
		extra: Partial<NonNullable<McpConnectorView["local"]>> = {}
	): McpConnectorView {
		return connector({
			id: `local:dev1:${server}`,
			name: `${server} · on laptop`,
			url: "",
			connected: (extra.state ?? "ready") === "ready",
			manageable: false,
			local: {
				deviceId: "dev1",
				machineName: "laptop",
				server,
				transport: "stdio",
				state: "ready",
				description: `kDrive (${server}) — a deliberately long description that cannot fit on one line of a phone card, so it has to be clamped to two lines at most and never push the switch out of view`,
				...extra,
			},
		});
	}

	/** List endpoint plus the local tools route, answering by connector id. */
	function stub(
		list: McpConnectorView[],
		tools: (id: string) => Response = () => Response.json({ tools: [] })
	) {
		const asked: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes("/api/v2/local-connectors/tools")) {
					const id = new URL(url, "http://x").searchParams.get("id") ?? "";
					asked.push(id);
					return tools(id);
				}
				if (url.includes("/api/v2/mcp/connectors")) return Response.json({ data: list });
				return Response.json({});
			})
		);
		return asked;
	}

	beforeEach(async () => {
		connectors.set([]);
		await page.viewport(390, 800);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		connectors.set([]);
	});

	it("keeps each server name whole at 390px and puts the switch in a footer row", async () => {
		stub([...LONG.map((name) => localOf(name)), localOf("calendar")]);
		const screen = mount();
		await expect
			.element(screen.getByText("On your machines (3)", { exact: false }))
			.toBeInTheDocument();

		const names = [
			...screen.baseElement.querySelectorAll('[data-testid="card-name"]'),
		] as HTMLElement[];
		expect(names.map((n) => n.textContent?.trim())).toEqual([...LONG, "calendar"]);
		for (const name of names) {
			// Not an ellipsis: nothing hides part of the name, so two servers never look alike.
			expect(getComputedStyle(name).textOverflow).not.toBe("ellipsis");
			expect(name.scrollWidth).toBeLessThanOrEqual(name.clientWidth);
			expect(name.getBoundingClientRect().width).toBeGreaterThan(200);
		}
		// The machine is its own small line, and the description is clamped.
		const card = screen.baseElement.querySelector('[data-testid="local-connector"]') as HTMLElement;
		expect(card.textContent).toContain("on laptop");
		const description = card.querySelector('[data-testid="card-description"]') as HTMLElement;
		expect(getComputedStyle(description).textOverflow).toBe("ellipsis");
		expect(description.getAttribute("title")).toBe(description.textContent?.trim());

		// The footer row: the short label, then the switch, below the pills.
		const footers = [
			...(card.parentElement as HTMLElement).querySelectorAll('[data-testid="card-footer"]'),
		];
		expect(footers).toHaveLength(3);
		const footer = card.querySelector('[data-testid="card-footer"]') as HTMLElement;
		const shortLabel = [...footer.querySelectorAll("span")].find(
			(el) => el.textContent === "Use in chats"
		) as HTMLElement;
		expect(getComputedStyle(shortLabel).display).not.toBe("none");
		const pill = card.querySelector('[data-testid="local-pill"]') as HTMLElement;
		expect(footer.getBoundingClientRect().top).toBeGreaterThan(
			pill.getBoundingClientRect().bottom - 1
		);
		expect(footer.querySelector('[role="switch"]')).not.toBeNull();
	});

	it("opens the detail sheet from the card with the full name, machine, state, transport, allowed tools and the tool names", async () => {
		const asked = stub(
			[
				localOf("kdrive-personal", {
					allowedTools: ["search", "read"],
					description: "The full description of the server, in every word.",
				}),
			],
			() =>
				Response.json({
					tools: [{ name: "search", description: "Search files" }, { name: "read" }],
				})
		);
		const screen = mount();
		await expect.element(screen.getByText("kdrive-personal", { exact: true })).toBeInTheDocument();
		expect(document.querySelector('[data-testid="connector-detail"]')).toBeNull();

		// A click on the card body, not on its name button.
		(screen.baseElement.querySelector('[data-testid="card-description"]') as HTMLElement).click();
		const sheet = page.getByTestId("connector-detail");
		await expect.element(sheet).toBeVisible();
		await expect.element(sheet).toHaveTextContent("kdrive-personal");
		await expect.element(sheet).toHaveTextContent("on laptop");
		await expect
			.element(sheet)
			.toHaveTextContent("The full description of the server, in every word.");
		await expect.element(sheet).toHaveTextContent("On");
		await expect.element(sheet).toHaveTextContent("stdio");
		await expect.element(sheet).toHaveTextContent("search, read");
		await expect.element(sheet).toHaveTextContent("Search files");
		expect(asked).toEqual(["local:dev1:kdrive-personal"]);
		await expect.element(page.getByRole("dialog")).toBeInTheDocument();
	});

	it("opens from the keyboard through the name, and not from the switch", async () => {
		stub([localOf("notes")]);
		const screen = mount();
		await expect.element(screen.getByText("notes", { exact: true })).toBeInTheDocument();

		(screen.baseElement.querySelector('[role="switch"]') as HTMLElement).click();
		expect(document.querySelector('[data-testid="connector-detail"]')).toBeNull();

		await screen.getByRole("button", { name: "notes" }).click();
		await expect.element(page.getByTestId("connector-detail")).toBeVisible();
	});

	it("says why the tools could not be listed", async () => {
		stub([localOf("notes")], () => Response.json({ error: "laptop is offline" }));
		const screen = mount();
		await screen.getByRole("button", { name: "notes" }).click();
		await expect
			.element(page.getByTestId("connector-detail"))
			.toHaveTextContent("Couldn't load the tools: laptop is offline");
	});

	it("does not ask for tools of a server that is not on, and says so", async () => {
		const asked = stub([
			localOf("notes", { state: "offline", detail: "laptop is not connected." }),
		]);
		const screen = mount();
		await screen.getByRole("button", { name: "notes" }).click();
		const sheet = page.getByTestId("connector-detail");
		await expect.element(sheet).toHaveTextContent("Offline");
		await expect.element(sheet).toHaveTextContent("laptop is not connected.");
		expect(asked).toEqual([]);
	});

	it("shows a remote connector's last-checked tools", async () => {
		stub([
			connector({
				id: "c1",
				name: "Remote one",
				tools: [{ name: "lookup", description: "Look it up" }],
			}),
		]);
		const screen = mount();
		await screen.getByRole("button", { name: "Remote one" }).click();
		await expect.element(page.getByTestId("connector-detail")).toHaveTextContent("lookup");
	});

	it("groups the .env servers and the administrator's connectors in one list, by name", async () => {
		const env = (name: string): MCPServer => ({
			id: `base-${name}`,
			name,
			url: `https://${name}.test/mcp`,
			type: "base",
		});
		allMcpServers.set([env("osm"), env("search")]);
		stubApi([MINE(), SHARED(true)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Built-in connectors (3)", { exact: true }))
			.toBeInTheDocument();
		// No separate "Base Servers" group any more.
		expect(screen.baseElement.textContent).not.toContain("Base Servers");
		const section = screen.baseElement.querySelector('[data-testid="provided-section"]');
		const names = [...(section?.querySelectorAll('[data-testid="card-name"]') ?? [])].map((el) =>
			el.textContent?.trim()
		);
		expect(names).toEqual(["osm", "search", "Shared"]);
		// Alike: every card leads with an icon, one verb for the probe, the URL on one line.
		const cards = [...(section?.querySelectorAll('[data-testid="card-name"]') ?? [])].map(
			(el) => el.closest("div.rounded-lg") as HTMLElement
		);
		// One look: a connected connector and a built-in base server are not tinted differently.
		expect(
			new Set(cards.map((card) => card.className.replace("cursor-pointer", "").trim())).size
		).toBe(1);
		for (const card of cards) {
			expect(card.querySelector("h4 img"), card.textContent ?? "").not.toBeNull();
			expect(
				[...card.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Check")
			).toBe(true);
			const url = card.querySelector('[data-testid="card-description"]') as HTMLElement;
			expect(getComputedStyle(url).textOverflow).toBe("ellipsis");
			expect(url.getAttribute("title")).toMatch(/^https?:\/\//);
		}
		// The person's own connector stays out of the group.
		expect(section?.textContent).not.toContain("Mine");
	});
});

describe("ConnectorsSection: switching connectors on and off (ADR 0104)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		connectors.set([]);
		allMcpServers.set([]);
	});
	afterEach(() => vi.unstubAllGlobals());

	const provided = (extra: Partial<McpConnectorView> & { id: string }) =>
		connector({ scope: "deployment", manageable: false, auth: "none", mode: "on", ...extra });

	const theSwitch = (root: HTMLElement) =>
		root.querySelector<HTMLElement>('[role="switch"]') as HTMLElement;

	it("gives a connector the deployment has on a switch, and keeps the choice on the server", async () => {
		const seen: { method: string; url: string; body?: unknown }[] = [];
		stubApi([provided({ id: "maps", name: "Maps" })], seen);
		const screen = mount();
		await expect.element(screen.getByText("Maps", { exact: true })).toBeInTheDocument();
		expect(theSwitch(screen.baseElement).getAttribute("aria-checked")).toBe("true");

		theSwitch(screen.baseElement).click();

		await vi.waitFor(() =>
			expect(seen).toContainEqual(
				expect.objectContaining({
					method: "PUT",
					body: { key: "connector:maps", enabled: false },
				})
			)
		);
		await vi.waitFor(() =>
			expect(theSwitch(screen.baseElement).getAttribute("aria-checked")).toBe("false")
		);
	});

	it("shows a locked connector as on, with a lock and no switch", async () => {
		stubApi([provided({ id: "maps", name: "Maps", mode: "locked" })]);
		const screen = mount();
		await expect.element(screen.getByText("Maps", { exact: true })).toBeInTheDocument();
		await expect.element(page.getByTestId("card-locked")).toHaveTextContent("Always on");
		expect(
			screen.baseElement.querySelector('[role="switch"][name="use-connector-maps"]')
		).toBeNull();
	});

	it("puts a switch back and says so when the server refuses it", async () => {
		stubApi([connector({ id: "mine", name: "Mine" })], [], 409);
		const screen = mount();
		await expect.element(screen.getByText("Mine", { exact: true })).toBeInTheDocument();
		expect(theSwitch(screen.baseElement).getAttribute("aria-checked")).toBe("true");

		theSwitch(screen.baseElement).click();

		await expect.element(page.getByTestId("switch-error")).toBeInTheDocument();
		await vi.waitFor(() =>
			expect(theSwitch(screen.baseElement).getAttribute("aria-checked")).toBe("true")
		);
	});
});
