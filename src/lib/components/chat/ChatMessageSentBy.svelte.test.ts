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

	it("draws the person's own words at full text contrast, not the dimmed tone", async () => {
		const view = mount({ from: "user", content: "just me" });
		const bubble = view.baseElement
			.querySelector('[data-message-type="user"]')
			?.querySelector("p.whitespace-break-spaces");
		expect(bubble?.className).toContain("text-gray-800");
		expect(bubble?.className).toContain("dark:text-gray-100");
		expect(bubble?.className).not.toContain("text-gray-500");
		// Right-aligned in the tinted bubble, so a fast scroll tells it from a reply.
		expect(bubble?.parentElement?.className).toContain("bg-blue-50");
		expect(bubble?.parentElement?.parentElement?.className).toContain("items-end");
	});
});
