import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShareArtifactDialog from "./ShareArtifactDialog.svelte";
import SharedLinksSettings from "./SharedLinksSettings.svelte";
import SharedLinksAdmin from "./SharedLinksAdmin.svelte";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

interface Call {
	url: string;
	init?: RequestInit;
}
const calls: Call[] = [];

const link = (extra: Record<string, unknown> = {}) => ({
	id: "a".repeat(24),
	title: "Plan",
	type: "markdown",
	kind: "text",
	artifactId: "plan",
	version: 1,
	conversationId: "b".repeat(24),
	conversationTitle: "Planning chat",
	audience: "signed_in",
	expiresAt: null,
	status: "active",
	views: 3,
	createdAt: "2026-11-10T10:00:00.000Z",
	updatedAt: "2026-11-10T10:00:00.000Z",
	ownerId: "c".repeat(24),
	ownerName: "Ada",
	...extra,
});

/** A fetch that answers by method and path from a table of handlers. */
function stub(answer: (call: Call) => unknown) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const call = { url: String(input), init };
			calls.push(call);
			return Response.json(answer(call));
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const artifact = {
	kind: "text" as const,
	identifier: "plan",
	title: "Plan",
	type: "markdown",
	version: 1,
	latestVersion: 2,
	content: "# The plan\n\nDo the thing.",
};

describe("Share link dialog", () => {
	it("shows a preview and says plainly who will see it, for each audience", async () => {
		stub(() => ({ enabled: true, onAppOrigin: false, data: [] }));
		renderWithApp(ShareArtifactDialog, { conversationId: "b".repeat(24), artifact });
		await expect.element(page.getByTestId("share-preview")).toBeVisible();
		await expect.element(page.getByTestId("share-preview")).toHaveTextContent("The plan");
		await expect
			.element(page.getByTestId("share-notice"))
			.toHaveTextContent(
				"Any signed-in user of this deployment with the link sees exactly this content."
			);
		await page.getByLabelText("Anyone with the link").click();
		await expect
			.element(page.getByTestId("share-notice"))
			.toHaveTextContent("Anyone with the link sees exactly this content.");
	});

	it("creates a link with the audience and expiry chosen, and shows it to copy", async () => {
		stub((call) =>
			call.init?.method === "POST"
				? {
						id: "a".repeat(24),
						url: "https://share.example.org/TOKEN",
						share: link({ audience: "anyone" }),
					}
				: { enabled: true, onAppOrigin: false, data: [] }
		);
		renderWithApp(ShareArtifactDialog, { conversationId: "b".repeat(24), artifact });
		await page.getByLabelText("Anyone with the link").click();
		await page.getByLabelText("Expires").selectOptions("7");
		await page.getByRole("button", { name: "Create link" }).click();
		await expect.poll(() => calls.some((c) => c.init?.method === "POST")).toBe(true);
		const post = calls.find((c) => c.init?.method === "POST");
		expect(JSON.parse(String(post?.init?.body))).toEqual({
			conversationId: "b".repeat(24),
			audience: "anyone",
			expiryDays: 7,
			kind: "text",
			identifier: "plan",
			version: 1,
		});
		await expect
			.element(page.getByLabelText("Link", { exact: true }))
			.toHaveValue("https://share.example.org/TOKEN");
		await expect.element(page.getByTestId("share-copy")).toBeVisible();
	});

	it("manages an existing link: update to latest, replace, revoke", async () => {
		stub((call) => {
			const method = call.init?.method ?? "GET";
			if (method === "GET") return { enabled: true, onAppOrigin: false, data: [link()] };
			if (method === "DELETE") return { ok: true };
			const body = JSON.parse(String(call.init?.body));
			return body.rotate
				? { share: link(), url: "https://share.example.org/NEW" }
				: { share: link({ version: 2 }) };
		});
		renderWithApp(ShareArtifactDialog, { conversationId: "b".repeat(24), artifact });
		await expect.element(page.getByRole("button", { name: "Revoke" })).toBeVisible();

		await page.getByRole("button", { name: "Update to latest version" }).click();
		await expect
			.poll(() =>
				calls.some((c) => c.init?.method === "PATCH" && String(c.init.body).includes("toLatest"))
			)
			.toBe(true);
		await expect.element(page.getByText("The link now shows the latest version.")).toBeVisible();

		await page.getByRole("button", { name: "Replace link" }).click();
		await expect
			.element(page.getByLabelText("Link", { exact: true }))
			.toHaveValue("https://share.example.org/NEW");

		await page.getByRole("button", { name: "Revoke" }).click();
		await expect.poll(() => calls.some((c) => c.init?.method === "DELETE")).toBe(true);
		await expect.element(page.getByRole("button", { name: "Create link" })).toBeVisible();
	});

	it("shows the real error when the server refuses", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method === "POST"
					? Response.json({ message: "This artifact already has a link." }, { status: 409 })
					: Response.json({ enabled: true, onAppOrigin: false, data: [] })
			)
		);
		renderWithApp(ShareArtifactDialog, { conversationId: "b".repeat(24), artifact });
		await page.getByRole("button", { name: "Create link" }).click();
		await expect.element(page.getByRole("alert")).toHaveTextContent("already has a link");
	});
});

describe("Settings → Shared links", () => {
	it("lists the user's links and revokes one", async () => {
		stub((call) =>
			call.init?.method === "DELETE"
				? { ok: true }
				: {
						enabled: true,
						onAppOrigin: false,
						data: [
							link(),
							link({ id: "d".repeat(24), title: "Chart", audience: "anyone", views: 12 }),
						],
					}
		);
		renderWithApp(SharedLinksSettings, {});
		const rows = page.getByTestId("shared-link-row");
		await expect.element(rows.first()).toBeVisible();
		await expect.element(page.getByText("Plan", { exact: true })).toBeVisible();
		await expect.element(page.getByText("Planning chat").first()).toBeVisible();
		await expect.element(page.getByText("Signed-in users")).toBeVisible();
		await expect.element(page.getByText("Anyone", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Revoke the link to Plan" }).click();
		await expect
			.poll(() => calls.some((c) => c.init?.method === "DELETE" && c.url.endsWith("a".repeat(24))))
			.toBe(true);
		await expect.element(page.getByText("Revoked")).toBeVisible();
	});

	it("says so when there is nothing, and when sharing is off", async () => {
		stub(() => ({ enabled: false, onAppOrigin: false, data: [] }));
		renderWithApp(SharedLinksSettings, {});
		await expect.element(page.getByText("You have not shared anything.")).toBeVisible();
		await expect.element(page.getByText(/Sharing is turned off for this deployment/)).toBeVisible();
	});
});

describe("Administration → Shared links", () => {
	it("lists every link with its owner, and revokes any", async () => {
		stub((call) =>
			call.init?.method === "DELETE"
				? { ok: true }
				: { enabled: true, envDefault: true, onAppOrigin: false, data: [link()] }
		);
		renderWithApp(SharedLinksAdmin, {});
		await expect.element(page.getByText("Ada")).toBeVisible();
		await page.getByRole("button", { name: "Revoke the link to Plan" }).click();
		await expect
			.poll(() =>
				calls.some((c) => c.init?.method === "DELETE" && c.url.includes("/api/v2/admin/shares/"))
			)
			.toBe(true);
	});

	it("toggles sharing for the whole deployment and says what the environment default is", async () => {
		stub((call) =>
			call.init?.method === "PATCH"
				? { enabled: false }
				: { enabled: true, envDefault: true, onAppOrigin: false, data: [] }
		);
		renderWithApp(SharedLinksAdmin, {});
		const toggle = page.getByRole("switch", { name: "Allow artifact share links" });
		await expect.element(toggle).toBeChecked();
		await expect
			.element(page.getByText("Until you set this, the server's setting applies: on."))
			.toBeVisible();
		await toggle.click();
		await expect.poll(() => calls.some((c) => c.init?.method === "PATCH")).toBe(true);
		expect(JSON.parse(String(calls.find((c) => c.init?.method === "PATCH")?.init?.body))).toEqual({
			enabled: false,
		});
		await expect.element(toggle).not.toBeChecked();
	});

	it("warns when links share the app's origin", async () => {
		stub(() => ({ enabled: true, envDefault: true, onAppOrigin: true, data: [] }));
		renderWithApp(SharedLinksAdmin, {});
		await expect.element(page.getByText(/isolated only by the browser sandbox/)).toBeVisible();
	});
});
