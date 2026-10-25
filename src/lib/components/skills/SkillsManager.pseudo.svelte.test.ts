/** Skills, in the pseudo-locale: the person's list, the admin list, and a create form. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import SkillsManager from "./SkillsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const skill = (id: string, name: string, files: string[] = []) => ({
	id,
	name,
	description: `${name} does a thing.`,
	enabled: true,
	updatedAt: "2026-01-01T00:00:00.000Z",
	files,
});

function stub() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				data: {
					user: [skill("1".repeat(24), "my-skill", ["scripts/run.py"])],
					admin: [skill("2".repeat(24), "csv-shaping")],
				},
			})
		)
	);
}

const ALLOWED = [
	"my-skill",
	"csv-shaping",
	"does a thing.",
	// The placeholder is a SKILL.md sample, in the file format's own keywords.
	"SKILL.md",
];

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Skills, in the pseudo-locale", () => {
	it("renders the person's list from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(SkillsManager, {});
		await expect.element(page.getByText("my-skill", { exact: true })).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders the administrator's list from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(SkillsManager, { admin: true });
		await expect.element(page.getByText("csv-shaping", { exact: true })).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders the create form from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(SkillsManager, {});
		await expect.element(page.getByText("my-skill", { exact: true })).toBeVisible();
		const create = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes(m["skills.manager.new_skill"]({}, { locale: "en-XA" }))
		);
		create?.click();
		await expect
			.element(page.getByText(m["skills.manager.form.admin_saved"]({}, { locale: "en-XA" })))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByText(m["skills.manager.back"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});
});
