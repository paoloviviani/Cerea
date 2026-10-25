import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LocalConnectors from "./LocalConnectors.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { unbracketedText } from "../__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const machines = [
	{
		id: "m1",
		name: "laptop",
		status: "paired",
		mode: "connectors",
		online: true,
		createdAt: new Date().toISOString(),
		servers: [
			{ id: "s1", name: "notes", transport: "stdio", state: "ready" },
			{ id: "s2", name: "crm", transport: "http", state: "needs-login" },
		],
	},
	{
		id: "m2",
		name: "desk",
		status: "pending",
		mode: "connectors",
		online: true,
		createdAt: new Date().toISOString(),
		servers: [],
	},
];

function mount(list: unknown[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ machines: list }))
	);
	return renderWithApp(LocalConnectors, {} as never, {
		page: {
			url: "http://localhost:3000/workspace?tab=local",
			data: { codeOidcIssuerUrl: "https://auth.example.org", codeOidcClientId: "x" },
		},
	});
}

// Commands and file contents the person copies, and the machines' own names, are data.
const DATA = [
	/^Cop(ied|y to clipboard)$/,
	/^(~\/|--|"|\$)/,
	/^(curl|galopin|npx|systemctl|mkdir|loginctl|\{|\}|"|\[|#|ExecStart|Restart|Environment|After|Wants|WantedBy|Description)/,
	/^\d\.?$/,
	/laptop|desk|notes|crm/,
];

beforeEach(() => {
	vi.unstubAllGlobals();
	overwriteGetLocale(() => "en-XA");
});
afterEach(() => overwriteGetLocale(() => "en"));

describe("Local connectors, in the pseudo-locale", () => {
	it("owns every word of the how-to", async () => {
		const screen = mount([]);
		await expect
			.element(screen.getByText(m["workspace.local.howto.title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText(document.body, DATA)).toEqual([]);
	});

	it("owns every word of the machine list", async () => {
		const screen = mount(machines);
		await expect.element(screen.getByTestId("local-machine")).toBeVisible();
		await expect
			.element(screen.getByText(m["workspace.local.state.ready"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText(document.body, [...DATA, /^stdio$|^http$/])).toEqual([]);
	});
});
