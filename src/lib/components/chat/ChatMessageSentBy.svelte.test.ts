import { describe, it, expect } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessage from "./ChatMessage.svelte";
import { CODE_SESSION_LINKS } from "$lib/utils/codeSessionLinks";

const links = {
	href: (id: string) => `/code?device=d1&ws=w1&agent=${id}`,
	title: () => undefined,
};

const mount = (message: Record<string, unknown>, context?: Map<unknown, unknown>) =>
	renderWithApp(
		ChatMessage,
		{ message: { id: "m1", children: [], ...message }, isAuthor: true, readOnly: false } as never,
		{ context }
	);

const sentBy = { sessionId: "ses_a", title: "Docs agent", hop: 1 };

describe("a user message another session wrote", () => {
	it("reads From agent ‹title›, links to the sender, and is not the person's plain bubble", async () => {
		const view = mount(
			{ from: "user", content: "please review the diff", sentBy },
			new Map([[CODE_SESSION_LINKS, links]])
		);
		const card = view.getByTestId("sent-by-agent");
		await expect.element(card).toHaveTextContent("From agent");
		await expect.element(card).toHaveTextContent("Docs agent");
		await expect.element(card).toHaveTextContent("please review the diff");
		const link = view.baseElement.querySelector<HTMLAnchorElement>("[data-testid='sent-by-link']");
		expect(link?.getAttribute("href")).toBe("/code?device=d1&ws=w1&agent=ses_a");
	});

	it("names the sender without a link where no agent view provides one", async () => {
		const view = mount({ from: "user", content: "hello", sentBy });
		await expect.element(view.getByTestId("sent-by-agent")).toHaveTextContent("Docs agent");
		expect(view.baseElement.querySelector("[data-testid='sent-by-link']")).toBeNull();
	});

	it("leaves the person's own message exactly as it was", async () => {
		const view = mount({ from: "user", content: "just me" });
		expect(view.baseElement.querySelector("[data-testid='sent-by-agent']")).toBeNull();
		await expect.element(view.getByText("just me")).toBeVisible();
	});
});
