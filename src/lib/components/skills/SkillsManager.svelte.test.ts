/**
 * The skills tab: the person's skills with enable/disable, and the
 * read-only admin seeds beside them.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page } from "@vitest/browser/context";

import SkillsManager from "./SkillsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const USER_SKILL = {
	id: "691111111111111111111111",
	name: "my-skill",
	description: "Does a useful thing.",
	enabled: true,
	updatedAt: new Date().toISOString(),
};

const ADMIN_SEED = { name: "csv-shaping", description: "Reshape CSV data.", readOnly: true };

let userSkills = [USER_SKILL];
let calls: { url: string; method: string; body?: unknown }[] = [];

function mount() {
	renderWithApp(SkillsManager, {});
}

describe("SkillsManager", () => {
	beforeEach(() => {
		userSkills = [{ ...USER_SKILL }];
		calls = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				calls.push({
					url,
					method: init?.method ?? "GET",
					body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
				});
				if (url.endsWith("/api/v2/skills")) {
					return Response.json({ data: { user: userSkills, admin: [ADMIN_SEED] } });
				}
				const toggle = url.match(/\/api\/v2\/skills\/([0-9a-f]{24})$/);
				if (toggle && (init?.method ?? "GET") === "PATCH") {
					const skill = userSkills.find((entry) => entry.id === toggle[1]);
					if (!skill) return new Response("null", { status: 404 });
					const parsed = JSON.parse(init?.body ?? "{}") as { enabled?: boolean };
					if (typeof parsed.enabled === "boolean") skill.enabled = parsed.enabled;
					return Response.json({ data: skill });
				}
				return new Response("null", { status: 404 });
			})
		);
		mount();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists the person's skill and the read-only seed beside it", async () => {
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		expect(page.getByText("Does a useful thing.").elements()).not.toHaveLength(0);
		expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0);
		// The seed row carries its read-only marker; the user row does not.
		expect(page.getByText("Seed", { exact: true }).elements()).toHaveLength(1);
	});

	it("disables a skill through the API and flips its pill", async () => {
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "Disable" }).click();
		await vi.waitFor(() =>
			expect(page.getByText("Off", { exact: true }).elements()).not.toHaveLength(0)
		);
		expect(
			calls.some(
				(call) =>
					call.method === "PATCH" &&
					call.url.endsWith(`/api/v2/skills/${USER_SKILL.id}`) &&
					(call.body as { enabled?: boolean } | undefined)?.enabled === false
			)
		).toBe(true);
	});
});
