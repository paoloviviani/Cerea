import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ContextMeter from "./ContextMeter.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const gatewayUsage = vi.hoisted(() => vi.fn());
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	getAgentGatewayUsage: gatewayUsage,
}));

const totals = (cost: string) => ({
	requests: 4,
	promptTokens: 12_000,
	completionTokens: 2_100,
	cachedPromptTokens: 9_000,
	cost,
});

function mount(props: { usage?: object | null; supported?: boolean; running?: boolean } = {}) {
	return renderWithApp(ContextMeter, {
		deviceId: "d1",
		agentId: "ses_1",
		usage: props.usage ?? null,
		lastCompaction: null,
		supported: props.supported ?? true,
		running: props.running ?? false,
	});
}

beforeEach(() => {
	gatewayUsage.mockReset();
});

describe("ContextMeter gateway usage", () => {
	it("falls back to the gateway's token count when the engine reports no context", async () => {
		gatewayUsage.mockResolvedValue({
			available: true,
			currency: "EUR",
			session: totals("0.0420"),
			window: null,
		});
		mount({ usage: null, supported: false });
		await expect.element(browserPage.getByText("14.1k")).toBeInTheDocument();
	});

	it("keeps the engine's percentage and shows the cost as metered by the gateway", async () => {
		gatewayUsage.mockResolvedValue({
			available: true,
			currency: "EUR",
			session: totals("0.0420"),
			window: totals("0.0100"),
		});
		mount({ usage: { used: 50_000, max: 200_000, input: 40_000, output: 10_000 } });
		await expect.element(browserPage.getByText("25%")).toBeInTheDocument();
		await browserPage.getByTitle("Context usage").click();
		await expect.element(browserPage.getByTestId("gateway-session")).toHaveTextContent("€0.042");
		await expect.element(browserPage.getByTestId("gateway-turn")).toHaveTextContent("€0.01");
		await expect.element(browserPage.getByText(/As metered by the gateway/)).toBeInTheDocument();
	});

	it("shows nothing without any figures from either side", async () => {
		gatewayUsage.mockResolvedValue({ available: false });
		mount({ usage: null });
		await new Promise((r) => setTimeout(r, 50));
		expect(browserPage.getByTitle("Context usage").elements()).toHaveLength(0);
	});
});
