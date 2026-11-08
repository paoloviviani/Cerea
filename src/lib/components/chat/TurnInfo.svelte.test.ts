import { describe, expect, it } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessage from "./ChatMessage.svelte";
import TurnInfo from "./TurnInfo.svelte";
import type { Message } from "$lib/types/Message";
import type { TurnStats } from "$lib/types/TurnStats";

const STATS: TurnStats = {
	model: "Test model",
	inputTokens: 1200,
	outputTokens: 340,
	reasoningTokens: 50,
	firstTokenMs: 420,
	tokensPerSecond: 61.5,
	cost: "0.0042 USD",
	at: new Date("2026-11-08T10:00:00Z").getTime(),
};

const REDACTION = {
	applied: true,
	blocked: false,
	entities: [
		{
			type: "PERSON",
			count: 2,
			mode: "restore",
			rule: { name: "Cloud providers", owner: "admin" as const },
			sources: ["user"],
		},
	],
};

const msg = (stats?: TurnStats): Message => ({
	id: "11111111-1111-4111-8111-111111111111",
	from: "assistant",
	content: "Answer",
	stats,
});

describe("the info dot", () => {
	it("is neutral for a plain turn and for one with no stats at all", async () => {
		for (const stats of [STATS, undefined]) {
			const screen = renderWithApp(TurnInfo, { message: msg(stats) });
			const dot = screen.getByTestId("turn-info-dot");
			await expect.element(dot).toHaveAttribute("data-state", "neutral");
			await expect.element(dot).toHaveAttribute("aria-label", "Turn details");
			await screen.unmount();
		}
	});

	it("is yellow, and says so, when values were hidden", async () => {
		const screen = renderWithApp(TurnInfo, { message: msg({ ...STATS, redaction: REDACTION }) });
		const dot = screen.getByTestId("turn-info-dot");
		await expect.element(dot).toHaveAttribute("data-state", "applied");
		await expect
			.element(dot)
			.toHaveAttribute("aria-label", "Turn details: values were hidden from the model");
		await expect.element(dot.getByTestId("turn-info-glyph")).toHaveClass(/bg-yellow/);
		await dot.click();
		await expect.element(screen.getByTestId("turn-info-state")).toHaveTextContent("Values hidden");
	});

	it("is red, and says so, when the request was refused", async () => {
		const screen = renderWithApp(TurnInfo, {
			message: msg({ ...STATS, redaction: { ...REDACTION, blocked: true } }),
		});
		const dot = screen.getByTestId("turn-info-dot");
		await expect.element(dot).toHaveAttribute("data-state", "blocked");
		await expect
			.element(dot)
			.toHaveAttribute("aria-label", "Turn details: the request was refused");
		await expect.element(dot.getByTestId("turn-info-glyph")).toHaveClass(/bg-red/);
		await dot.click();
		await expect
			.element(screen.getByTestId("turn-info-state"))
			.toHaveTextContent("Request refused");
	});
});

describe("the overlay", () => {
	it("lists the numbers, with a dash for every gap", async () => {
		const screen = renderWithApp(TurnInfo, { message: msg(STATS) });
		await screen.getByTestId("turn-info-dot").click();
		const panel = screen.getByTestId("turn-info-panel");
		await expect.element(panel).toHaveTextContent("Test model");
		await expect.element(panel).toHaveTextContent("1,200");
		await expect.element(panel).toHaveTextContent("340");
		await expect.element(panel).toHaveTextContent("Reasoning tokens");
		await expect.element(panel).toHaveTextContent("420 ms");
		await expect.element(panel).toHaveTextContent("61.5 tokens/s");
		await expect.element(panel).toHaveTextContent("0.0042 USD");
		await expect.element(screen.getByTestId("turn-info-redaction")).not.toBeInTheDocument();
	});

	it("shows dashes, not an error, for a turn with no stats", async () => {
		const screen = renderWithApp(TurnInfo, { message: msg(undefined) });
		await screen.getByTestId("turn-info-dot").click();
		const panel = screen.getByTestId("turn-info-panel");
		await expect.element(panel).toHaveTextContent("Time to first token");
		expect(panel.element().textContent).toContain("—");
		await expect.element(screen.getByTestId("turn-info-model")).toHaveTextContent("—");
	});

	it("summarises the redaction, with mode and source, and no values by default", async () => {
		const screen = renderWithApp(TurnInfo, { message: msg({ ...STATS, redaction: REDACTION }) });
		await screen.getByTestId("turn-info-dot").click();
		await expect
			.element(screen.getByTestId("turn-info-summary"))
			.toHaveTextContent("Hidden from the model: 2 names (admin rule “Cloud providers”).");
		const section = screen.getByTestId("turn-info-redaction");
		await expect.element(section).toHaveTextContent("restored in the answer");
		await expect.element(section).toHaveTextContent("from your message");
		await expect.element(screen.getByTestId("turn-info-values")).not.toBeInTheDocument();
	});

	it("lists the values as text when they are present, never as markup", async () => {
		const screen = renderWithApp(TurnInfo, {
			message: msg({
				...STATS,
				redaction: {
					...REDACTION,
					values: [{ type: "PERSON", original: "<b>Mario</b> <img src=x onerror=alert(1)>" }],
				},
			}),
		});
		await screen.getByTestId("turn-info-dot").click();
		const list = screen.getByTestId("turn-info-values");
		await expect
			.element(list)
			.toHaveTextContent("<b>Mario</b> <img src=x onerror=alert(1)> → name");
		expect(list.element().querySelector("b, img")).toBeNull();
	});

	it("says nothing was hidden when redaction ran and hid nothing", async () => {
		const screen = renderWithApp(TurnInfo, {
			message: msg({ ...STATS, redaction: { applied: false, blocked: false, entities: [] } }),
		});
		const dot = screen.getByTestId("turn-info-dot");
		await expect.element(dot).toHaveAttribute("data-state", "neutral");
		await dot.click();
		await expect
			.element(screen.getByTestId("turn-info-redaction"))
			.toHaveTextContent("Nothing was hidden in this turn.");
	});

	it("links to the console's redactions page only where there is a console", async () => {
		const withStats = msg({ ...STATS, redaction: REDACTION });
		const without = renderWithApp(TurnInfo, { message: withStats });
		await without.getByTestId("turn-info-dot").click();
		await expect.element(without.getByTestId("turn-info-console-link")).not.toBeInTheDocument();
		await without.unmount();

		const withConsole = renderWithApp(
			TurnInfo,
			{ message: withStats },
			{ page: { data: { consoleEnabled: true } } }
		);
		await withConsole.getByTestId("turn-info-dot").click();
		const link = withConsole.getByTestId("turn-info-console-link");
		await expect.element(link).toHaveAttribute("href", "/console/redactions");
		await expect.element(link).toHaveTextContent("See all redactions");
	});

	it("closes on Escape", async () => {
		const screen = renderWithApp(TurnInfo, { message: msg(STATS) });
		await screen.getByTestId("turn-info-dot").click();
		await expect.element(screen.getByTestId("turn-info-panel")).toBeInTheDocument();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		await expect.element(screen.getByTestId("turn-info-panel")).not.toBeInTheDocument();
	});
});

describe("under an answer", () => {
	it("sits in ChatMessage's action row for an assistant answer", async () => {
		const screen = renderWithApp(ChatMessage, { message: msg(STATS) });
		await expect.element(screen.getByTestId("turn-info-dot")).toBeInTheDocument();
	});
});
