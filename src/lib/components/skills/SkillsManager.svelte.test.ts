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
	files: [] as string[],
};

const DEPLOYMENT_SKILL = {
	id: "692222222222222222222222",
	name: "csv-shaping",
	description: "Reshape CSV data.",
	enabled: true,
	updatedAt: new Date().toISOString(),
	files: [] as string[],
};

let userSkills = [USER_SKILL];
let deploymentSkills = [DEPLOYMENT_SKILL];
let calls: { url: string; method: string; body?: unknown }[] = [];
let fileContents: Record<string, string> = {};

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string | FormData }) => {
			const method = init?.method ?? "GET";
			const isForm = init?.body instanceof FormData;
			calls.push({
				url,
				method,
				body: init?.body
					? isForm
						? init.body
						: (JSON.parse(init.body as string) as unknown)
					: undefined,
			});
			if (url.endsWith("/api/v2/skills")) {
				if (method === "POST" && isForm) {
					const form = init?.body as FormData;
					const scope = form.get("scope") === "deployment" ? "deployment" : "user";
					const created = {
						id: "694444444444444444444444",
						name: "imported-skill",
						description: "Imported from a zip.",
						enabled: true,
						updatedAt: new Date().toISOString(),
						files: ["scripts/helper.py", "references/notes.md"],
					};
					(scope === "deployment" ? deploymentSkills : userSkills).push(created as never);
					return Response.json({ data: created }, { status: 201 });
				}
				if (method === "POST") {
					const parsed = JSON.parse(init?.body as string) as {
						content?: string;
						scope?: string;
					};
					const created = {
						id: "693333333333333333333333",
						name: "new-skill",
						description: "A new procedure.",
						enabled: true,
						updatedAt: new Date().toISOString(),
						files: [] as string[],
					};
					(parsed.scope === "deployment" ? deploymentSkills : userSkills).push(created as never);
					return Response.json({ data: created }, { status: 201 });
				}
				return Response.json({ data: { user: userSkills, admin: deploymentSkills } });
			}
			const fileMatch = url.match(/\/api\/v2\/skills\/([0-9a-f]{24})\/files\/(.+)$/);
			if (fileMatch) {
				const [, id, path] = fileMatch;
				const all = [...userSkills, ...deploymentSkills];
				const skill = all.find((entry) => entry.id === id);
				if (!skill) return new Response("null", { status: 404 });
				if (method === "DELETE") {
					skill.files = skill.files.filter((entry) => entry !== path);
					return Response.json({ data: skill });
				}
				return Response.json({ data: { path, content: fileContents[path as string] ?? "" } });
			}
			const match = url.match(/\/api\/v2\/skills\/([0-9a-f]{24})$/);
			if (match) {
				const all = [...userSkills, ...deploymentSkills];
				const skill = all.find((entry) => entry.id === match[1]);
				if (!skill) return new Response("null", { status: 404 });
				if (method === "PATCH") {
					const parsed = JSON.parse(init?.body as string) as { enabled?: boolean };
					if (typeof parsed.enabled === "boolean") skill.enabled = parsed.enabled;
					return Response.json({ data: skill });
				}
				if (method === "DELETE") {
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
		userSkills = [{ ...USER_SKILL, files: [] }];
		deploymentSkills = [{ ...DEPLOYMENT_SKILL, files: [] }];
		calls = [];
		fileContents = {};
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

	it("imports a skill from a zip, posting multipart form data", async () => {
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "Import zip" }).click();
		await vi.waitFor(() => expect(document.querySelector("#skill-zip")).not.toBeNull());
		const input = document.querySelector("#skill-zip") as HTMLInputElement;
		const file = new File(["zip bytes"], "skill.zip", { type: "application/zip" });
		Object.defineProperty(input, "files", { value: [file] });
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await page.getByRole("button", { name: "Import skill" }).click();
		await vi.waitFor(() => expect(page.getByText("imported-skill").elements()).not.toHaveLength(0));
		const importCall = calls.find(
			(call) => call.method === "POST" && call.body instanceof FormData
		);
		expect(importCall).toBeDefined();
		expect((importCall?.body as FormData).get("file")).toBeInstanceOf(File);
	});

	it("lists a skill's bundled files and shows one's content on View", async () => {
		(userSkills[0] ?? USER_SKILL).files = ["scripts/helper.py"];
		fileContents["scripts/helper.py"] = "def run():\n    return 42\n";
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "View" }).first().click();
		await vi.waitFor(() =>
			expect(page.getByText("Bundled files (1)").elements()).not.toHaveLength(0)
		);
		expect(page.getByText("scripts/helper.py").elements()).not.toHaveLength(0);
		await page.getByRole("button", { name: "View" }).last().click();
		await vi.waitFor(() => expect(page.getByText("def run():").elements()).not.toHaveLength(0));
	});

	it("removes a bundled file through the API", async () => {
		(userSkills[0] ?? USER_SKILL).files = ["scripts/helper.py"];
		await vi.waitFor(() => expect(page.getByText("my-skill").elements()).not.toHaveLength(0));
		await page.getByRole("button", { name: "View" }).first().click();
		await vi.waitFor(() =>
			expect(page.getByText("Bundled files (1)").elements()).not.toHaveLength(0)
		);
		await page.getByRole("button", { name: "Remove" }).click();
		await vi.waitFor(() => expect(page.getByText("scripts/helper.py").elements()).toHaveLength(0));
		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" &&
					call.url.endsWith(`/api/v2/skills/${USER_SKILL.id}/files/scripts/helper.py`)
			)
		).toBe(true);
	});
});

describe("SkillsManager in admin mode", () => {
	beforeEach(() => {
		userSkills = [{ ...USER_SKILL, files: [] }];
		deploymentSkills = [{ ...DEPLOYMENT_SKILL, files: [] }];
		calls = [];
		fileContents = {};
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

	it("disables a built-in skill through the API — a toggle, not a delete", async () => {
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
		await page.getByRole("button", { name: "New built-in skill" }).first().click();
		await vi.waitFor(() => expect(document.querySelector("#skill-content")).not.toBeNull());
		const box = document.querySelector("#skill-content") as HTMLTextAreaElement;
		box.value = `---\nname: new-skill\ndescription: A new procedure.\n---\n\nBody.`;
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Create built-in skill" }).click();
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
