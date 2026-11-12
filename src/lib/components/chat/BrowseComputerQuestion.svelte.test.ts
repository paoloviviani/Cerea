/**
 * The "Which computer?" card (ADR 0116, C109): the chat's own question card (`ElicitationForm`),
 * fed the request `computerAsk.ts` raises: a select of the ready computers and a "Remember as
 * default" box that is ticked by default. Nothing is preselected for the user.
 */
import ElicitationForm from "./ElicitationForm.svelte";
import { render } from "vitest-browser-svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";

let sent: Array<Record<string, unknown>>;
beforeEach(() => {
	sent = [];
	vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
		sent.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({ ok: true, resume: false }), { status: 200 });
	});
});
afterEach(() => vi.unstubAllGlobals());

const request: ElicitationRequestPayload = {
	elicitationId: "33333333-3333-4333-8333-333333333333",
	server: "browse_computer",
	mode: "form",
	message: "Which computer should Cerea use for browsing?",
	fields: [
		{
			kind: "select",
			name: "computer",
			title: "Which computer?",
			required: true,
			multiple: false,
			options: [
				{ value: "d1", label: "Laptop" },
				{ value: "d2", label: "Desk" },
			],
		},
		{
			kind: "boolean",
			name: "remember",
			title: "Remember as default",
			required: false,
			default: true,
		},
	],
};

const send = () =>
	[...document.body.querySelectorAll("button")].find((b) =>
		/send|submit/i.test(b.textContent ?? "")
	);

describe("the Which computer? card", () => {
	it("lists the ready computers and ticks Remember as default", async () => {
		const { baseElement } = render(ElicitationForm, { conversationId: "abc", request });
		expect(baseElement.textContent).toContain("Which computer?");
		expect(baseElement.textContent).toContain("Laptop");
		expect(baseElement.textContent).toContain("Desk");
		expect(baseElement.textContent).toContain("Remember as default");
		const box = baseElement.querySelector<HTMLInputElement>('input[type="checkbox"]');
		expect(box?.checked).toBe(true);
	});

	it("sends the chosen computer, with Remember as default on", async () => {
		const { baseElement } = render(ElicitationForm, { conversationId: "abc", request });
		const desk = [
			...baseElement.querySelectorAll<HTMLElement>("label, button, [role=radio], option"),
		].find((el) => el.textContent?.trim() === "Desk");
		desk?.click();
		const select = baseElement.querySelector<HTMLSelectElement>("select");
		if (select) {
			select.value = "d2";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}
		send()?.click();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({
			elicitationId: request.elicitationId,
			action: "accept",
			content: { computer: "d2", remember: true },
		});
	});

	it("sends Remember as default off when the user clears it", async () => {
		const { baseElement } = render(ElicitationForm, { conversationId: "abc", request });
		baseElement.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
		const select = baseElement.querySelector<HTMLSelectElement>("select");
		const radio = baseElement.querySelector<HTMLInputElement>('input[type="radio"][value="d1"]');
		if (select) {
			select.value = "d1";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		} else radio?.click();
		send()?.click();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ content: { computer: "d1", remember: false } });
	});
});
