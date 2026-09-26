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

import { describe, expect, it, vi, beforeEach } from "vitest";

import ConnectorsSection from "./ConnectorsSection.svelte";
import type { McpConnectorView } from "$lib/types/McpConnector";
import { connectors } from "$lib/stores/mcpConnectors";
import { renderWithApp } from "../__tests__/renderWithApp";

// The client setup mocks `$app/*` but not `$env/dynamic/*`: the store behind
// this component reads a deployment name off the environment at module scope,
// and the bare name is all a test needs.
vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

function connector(overrides: Partial<McpConnectorView> & { id: string }): McpConnectorView {
	return {
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
function stubApi(list: McpConnectorView[], seen: { method: string; url: string }[] = []) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.includes("/api/v2/mcp/connectors") && method === "GET") {
				return Response.json({ data: list });
			}
			seen.push({ method, url });
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
	});

	it("lists an administrator's connectors apart from the person's own", async () => {
		stubApi([MINE(), SHARED(false)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Your connectors (1)", { exact: true }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByText("Provided by your administrator (1)", { exact: true }))
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
			.element(screen.getByText("Provided by your administrator (1)", { exact: true }))
			.toBeInTheDocument();
		const names = sectionButtons(screen.baseElement, "Provided by your administrator (1)");
		// Manageable stays: editing and re-checking somebody else's deployment
		// connector is still an administrator's job. Removal left for the
		// admin screen, which is the only place that confirms "for everyone".
		expect(names).toContain("Edit");
		expect(names).toContain("Re-check");
		expect(names.some((name) => name?.includes("Remove"))).toBe(false);
	});

	it("hides the changing buttons from a deployment row its reader may only use", async () => {
		stubApi([SHARED(false)]);
		const screen = mount();

		await expect
			.element(screen.getByText("Provided by your administrator (1)", { exact: true }))
			.toBeInTheDocument();
		const names = sectionButtons(screen.baseElement, "Provided by your administrator (1)");
		// These were buttons whose requests the server was already refusing;
		// `manageable` is the server saying so, and the row finally listens.
		expect(names).not.toContain("Edit");
		expect(names).not.toContain("Re-check");
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
		// no auth, and a row error telling the person to add a token.
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
		expect(screen.baseElement.textContent).not.toContain("Remove the stored token");

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
