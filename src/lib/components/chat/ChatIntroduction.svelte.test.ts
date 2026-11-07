import ChatIntroduction from "./ChatIntroduction.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, it, expect, vi } from "vitest";
import type { Model } from "$lib/types/Model";

/**
 * The rotating phrase that takes the app name's place on the new-chat
 * screen: the name itself leads the rotation (it is one of the things the
 * logo says), one pick per load, nothing but the name when the deployment
 * set "false" — and no pick on the server, where a random pick would
 * hydration-mismatch against a different client pick.
 */

const model = { id: "m", displayName: "Model", name: "model" } as unknown as Model;

const PHRASES = ["Com'è?", "Va bin", "Facciamo che iniziare?", "Fuma c'anduma"];
const ROTATION = ["chat-ui", ...PHRASES];

describe("ChatIntroduction", () => {
	it("prints one of the rotation — the name included — in the name's place", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: `"${PHRASES.join(",")}"` } }
		);
		// The pick happens in onMount (post-hydration), so wait for the
		// rendered text to settle on exactly one rotation entry.
		await vi.waitFor(() => {
			const printed = ROTATION.filter((phrase) => screen.baseElement.textContent?.includes(phrase));
			expect(printed).toHaveLength(1);
		});
	});

	it("explains a built-in greeting on hover and on tap", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "Va bin" } }
		);
		const phrase = await vi.waitFor(() => {
			const el = screen.baseElement.querySelector('[data-testid="intro-phrase"]');
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		expect(phrase.getAttribute("title")).toBe("All good");
		phrase.click();
		await vi.waitFor(() =>
			expect(
				screen.baseElement.querySelector('[data-testid="intro-gloss"]')?.textContent
			).toContain("All good")
		);
	});

	it("prints an operator's own phrase plain, with no gloss", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "Ciao" } }
		);
		await vi.waitFor(() => {
			expect(screen.baseElement.textContent).toMatch(/Ciao|chat-ui/);
		});
		expect(screen.baseElement.querySelector('[data-testid="intro-phrase"]')).toBeNull();
	});

	it('prints only the name when the deployment sets "false"', async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "false" } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		for (const phrase of PHRASES) {
			expect(screen.baseElement.textContent).not.toContain(phrase);
		}
	});

	it("prints only the name when the variable is empty", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "" } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		for (const phrase of PHRASES) {
			expect(screen.baseElement.textContent).not.toContain(phrase);
		}
	});

	it("ignores an invalid JSON array rather than guessing (misconfiguration degrades to the plain name)", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: '["Com\'è?",' } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		expect(screen.baseElement.textContent).not.toContain("Com'è?");
	});

	it("strips one pair of wrapping quotes a compose environment entry would carry literally", async () => {
		// dotenv strips them on the .env.local path; a direct environment:
		// entry does not, and the first/last phrase would otherwise carry a
		// stray quote into the logo slot.
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: `"${PHRASES.join(",")}"` } }
		);
		await vi.waitFor(() => {
			const printed = ROTATION.filter(
				(phrase) =>
					screen.baseElement.textContent?.includes(phrase) &&
					!screen.baseElement.textContent?.includes(`"${phrase}`)
			);
			expect(printed.length).toBeGreaterThanOrEqual(1);
		});
	});

	it("shows the ridge mark through two theme variants, sized by height", async () => {
		// The mark is 402×120 — a square box would stretch it. Each variant
		// must be height-constrained with a free width, and the dark variant
		// must arrive WITHOUT an invert filter (invert would land it at
		// #e1e1e1, not the white it was drawn in).
		const screen = renderWithApp(ChatIntroduction, { currentModel: model });
		const imgs = screen.baseElement.querySelectorAll('img[alt$=" logo"], img[alt=""]');
		expect(imgs).toHaveLength(2);
		const classes = Array.from(imgs).map((img) => img.getAttribute("class") ?? "");
		expect(classes.some((c) => c.includes("dark:hidden"))).toBe(true);
		expect(classes.some((c) => c.includes("hidden") && c.includes("dark:block"))).toBe(true);
		for (const c of classes) {
			expect(c).not.toContain("invert");
			expect(c).toContain("w-auto");
		}
	});

	it("adds a plain line under the greeting, by first name when known", async () => {
		const plain = renderWithApp(ChatIntroduction, { currentModel: model });
		expect(plain.getByTestId("intro-subline").element().textContent?.trim()).toBe(
			"What can I help you with today?"
		);
		plain.unmount();
		const named = renderWithApp(ChatIntroduction, { currentModel: model, firstName: "Ada" });
		expect(named.getByTestId("intro-subline").element().textContent?.trim()).toBe(
			"What can I help you with today, Ada?"
		);
	});

	it("shows no starters unless the administrator switched them on", () => {
		const screen = renderWithApp(ChatIntroduction, { currentModel: model });
		expect(screen.getByTestId("starter-draft").elements()).toHaveLength(0);
	});

	it("offers four starters: three beginnings for the composer, one question to send", async () => {
		const picked: Array<[string, boolean]> = [];
		const screen = renderWithApp(ChatIntroduction, {
			currentModel: model,
			showStarters: true,
			onstarter: (text: string, send: boolean) => picked.push([text, send]),
		});
		for (const id of ["draft", "analyse", "plan", "cerea"]) {
			(screen.getByTestId(`starter-${id}`).element() as HTMLButtonElement).click();
		}
		expect(picked.map(([, send]) => send)).toEqual([false, false, false, true]);
		expect(picked[2]?.[0]).toBe("Help me plan ");
		expect(picked[3]?.[0]).toContain("Cerea");
	});
});
