/**
 * The skills tab: the person's skills with enable/disable, and the
 * deployment rows beside them — read-only in the workspace, fully
 * manageable in `admin` mode.
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

const DEPLOYMENT_SKILL = {
	id: "692222222222222222222222",
	name: "csv-shaping",
	description: "Reshape CSV data.",
	enabled: true,
	updatedAt: new Date().toISOString(),
};

let userSkills = [USER_SKILL];
let deploymentSkills = [DEPLOYMENT_SKILL];
let calls: { url: string; method: string; body?: unknown }[] = [];

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
			});
			if (url.endsWith("/api/v2/skills")) {
				if ((init?.method ?? "GET") === "POST") {
					const parsed = JSON.parse(init?.body ?? "{}") as {
						content?: string;
						scope?: string;
					};
					const created = {
						id: "693333333333333333333333",
						name: "new-skill",
						description: "A new procedure.",
						enabled: true,
						updatedAt: new Date().toISOString(),
					};
					(parsed.scope === "deployment" ? deploymentSkills : userSkills).push(created as never);
					return Response.json({ data: created }, { status: 201 });
				}
				return Response.json({ data: { user: userSkills, admin: deploymentSkills } });
			}
			const match = url.match(/\/api\/v2\/skills\/([0-9a-f]{24})$/);
			if (match) {
				const all = [...userSkills, ...deploymentSkills];
				const skill = all.find((entry) => entry.id === match[1]);
				if (!skill) return new Response("null", { status: 404 });
				if ((init?.method ?? "GET") === "PATCH") {
					const parsed = JSON.parse(init?.body ?? "{}") as { enabled?: boolean };
					if (typeof parsed.enabled === "boolean") skill.enabled = parsed.enabled;
					return Response.json({ data: skill });
				}
				if ((init?.method ?? "GET") === "DELETE") {
					userSkills = userSkills.filter((entry) => entry.id !== skill.id);
					deploymentSkills = deploymentSkills.filter((entry) => entry.id !== skill.id);
					return new Response(null, { status: 204 });
				}
				return Response.json({
					data: { ...skill, content: `---\nname: ${skill.name}\ndescription: x\n---\n\nBody.` },
				});
			}
			return new Response("null", { status: 404 });
		})
	);
}

describe("SkillsManager", () => {
	beforeEach(() => {
		userSkills = [{ ...USER_SKILL }];
		deploymentSkills = [{ ...DEPLOYMENT_SKILL }];
		calls = [];
		installFetch();
		renderWithApp(SkillsManager, {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists the person's skill and the deployment row beside it, read-only", async () => {
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		expect(page.getByText("Does a useful thing.").elements()).not.toHaveLength(0);
		expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0);
		// The deployment row carries its marker; the user row does not.
		expect(page.getByText("Deployment", { exact: true }).elements()).toHaveLength(1);
	});

	it("disables a skill through the API and flips its pill", async () => {
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "Disable" }).first().click();
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

describe("SkillsManager in admin mode", () => {
	beforeEach(() => {
		userSkills = [{ ...USER_SKILL }];
		deploymentSkills = [{ ...DEPLOYMENT_SKILL }];
		calls = [];
		installFetch();
		vi.stubGlobal(
			"confirm",
			vi.fn(() => true)
		);
		renderWithApp(SkillsManager, { admin: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("manages the deployment rows: toggle, edit, and delete affordances", async () => {
		await vi.waitFor(() => expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0));
		// No personal section in admin mode; the deployment row is manageable.
		expect(page.getByText("my-skill").elements()).toHaveLength(0);
		expect(page.getByRole("button", { name: "Disable" }).elements()).not.toHaveLength(0);
		expect(page.getByRole("button", { name: "Edit" }).elements()).not.toHaveLength(0);
		expect(page.getByRole("button", { name: "Delete" }).elements()).not.toHaveLength(0);
	});

	it("disables a deployment skill through the API — a toggle, not a delete", async () => {
		await vi.waitFor(() => expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "Disable" }).click();
		await vi.waitFor(() =>
			expect(page.getByText("Off", { exact: true }).elements()).not.toHaveLength(0)
		);
		expect(
			calls.some(
				(call) =>
					call.method === "PATCH" &&
					call.url.endsWith(`/api/v2/skills/${DEPLOYMENT_SKILL.id}`) &&
					(call.body as { enabled?: boolean } | undefined)?.enabled === false
			)
		).toBe(true);
		// Still listed — disabling is not deleting.
		expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0);
	});

	it("deletes through the panel confirm idiom", async () => {
		await vi.waitFor(() => expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "Delete" }).click();
		expect(vi.mocked(window.confirm)).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(page.getByText("csv-shaping").elements()).toHaveLength(0));
		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" && call.url.endsWith(`/api/v2/skills/${DEPLOYMENT_SKILL.id}`)
			)
		).toBe(true);
	});

	it("creates with the deployment scope", async () => {
		await vi.waitFor(() => expect(page.getByText("csv-shaping").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "New deployment skill" }).first().click();
		await vi.waitFor(() => expect(document.querySelector("#skill-content")).not.toBeNull());
		const box = document.querySelector("#skill-content") as HTMLTextAreaElement;
		box.value = `---\nname: new-skill\ndescription: A new procedure.\n---\n\nBody.`;
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Create deployment skill" }).click();
		await vi.waitFor(() => expect(page.getByText("new-skill").elements()).not.toHaveLength(0));
		expect(
			calls.some(
				(call) =>
					call.method === "POST" &&
					(call.body as { scope?: string } | undefined)?.scope === "deployment"
			)
		).toBe(true);
	});
});
