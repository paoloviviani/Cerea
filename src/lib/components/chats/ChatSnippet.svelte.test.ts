import { describe, expect, it, vi } from "vitest";
import ChatSnippet from "./ChatSnippet.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

describe("ChatSnippet", () => {
	it("marks the matched spans and names who said it", () => {
		renderWithApp(ChatSnippet, {
			snippet: { text: "… the Codice Fiscale is here", spans: [[6, 20]], from: "user" },
		});
		const marks = [...document.body.querySelectorAll("mark")].map((el) => el.textContent);
		expect(marks).toEqual(["Codice Fiscale"]);
		const line = document.body.querySelector('[data-testid="chats-snippet"]') as Element;
		expect(line.textContent).toContain("You:");
		expect(line.textContent).toContain("is here");
	});

	it("ignores spans that do not fit the text", () => {
		renderWithApp(ChatSnippet, {
			snippet: { text: "short", spans: [[2, 99]], from: "assistant" },
		});
		expect(document.body.querySelectorAll("mark")).toHaveLength(0);
		expect(document.body.textContent).toContain("Assistant:");
	});
});
