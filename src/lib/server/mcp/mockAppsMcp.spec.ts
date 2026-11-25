/** The MCP Apps fixture (tests/mock-apps-mcp.ts) speaks the extension's wire shape. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
	APP_MIME,
	PROBES_MUST_FAIL,
	PROBE_URI,
	TIME_URI,
	startMockAppsMcp,
	type MockAppsMcp,
} from "../../../../tests/mock-apps-mcp";

let mock: MockAppsMcp;
let client: Client;

beforeAll(async () => {
	mock = await startMockAppsMcp(0);
	client = new Client({ name: "spec", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(mock.url)));
});

afterAll(async () => {
	await client.close();
	await mock.close();
});

describe("mock apps MCP server", () => {
	it("links tools to ui:// resources through _meta.ui.resourceUri", async () => {
		const { tools } = await client.listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));
		expect(byName.get("show_time")?._meta?.ui).toEqual({ resourceUri: TIME_URI });
		expect(byName.get("show_probe")?._meta?.ui).toEqual({ resourceUri: PROBE_URI });
		expect((byName.get("echo_app")?._meta?.ui as { visibility?: string[] }).visibility).toEqual([
			"app",
		]);
		expect(byName.get("plain")?._meta?.ui).toBeUndefined();
	});

	it("serves the pages as text/html;profile=mcp-app", async () => {
		const time = await client.readResource({ uri: TIME_URI });
		expect(time.contents[0].mimeType).toBe(APP_MIME);
		expect((time.contents[0] as { text: string }).text).toContain("Get Time App");

		const probe = await client.readResource({ uri: PROBE_URI });
		const content = probe.contents[0] as { text: string; mimeType: string };
		expect(content.mimeType).toBe(APP_MIME);
		for (const name of PROBES_MUST_FAIL) expect(content.text).toContain(`"${name}"`);
		expect(content.text).toContain(`"${mock.origin}" + "/__control/escape-ping"`);
		expect(mock.reads()).toContain(PROBE_URI);
	});

	it("lists the resources", async () => {
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri).sort()).toEqual([PROBE_URI, TIME_URI].sort());
	});

	it("records tool calls and counts escape pings", async () => {
		await client.callTool({ name: "echo_app", arguments: { text: "x" } });
		expect(mock.calls().map((c) => c.name)).toEqual(["echo_app"]);
		expect(mock.escapePings()).toBe(0);
		await fetch(`${mock.origin}/__control/escape-ping`);
		expect(mock.escapePings()).toBe(1);
		mock.reset();
		expect(mock.escapePings()).toBe(0);
	});
});
