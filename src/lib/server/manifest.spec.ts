import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWebAppManifest } from "./manifest";

describe("buildWebAppManifest", () => {
	it("derives every URL from the base path, and keeps the old app identity", () => {
		const manifest = buildWebAppManifest({
			appName: "Cerea",
			basePath: "/chat",
			assetDir: "chatui",
			agentsEnabled: true,
		});

		expect(manifest.id).toBe("/chat");
		expect(manifest.start_url).toBe("/chat/");
		expect(manifest.scope).toBe("/chat/");
		expect(manifest.icons.every((icon) => icon.src.startsWith("/chat/chatui/"))).toBe(true);
		expect(manifest.shortcuts.map((s) => s.url)).toEqual([
			"/chat/chats",
			"/chat/projects",
			"/chat/code",
		]);
	});

	it("serves a root deployment the same way, with origin-root addresses", () => {
		const manifest = buildWebAppManifest({
			appName: "Cerea",
			basePath: "",
			assetDir: "chatui",
			agentsEnabled: false,
		});

		expect(manifest.id).toBe("/");
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.icons[0].src).toBe("/chatui/icon-36x36.png");
		expect(manifest.shortcuts.map((s) => s.url)).toEqual(["/chats", "/projects"]);
	});

	it("carries the fields an install sheet and an analyzer score", () => {
		const manifest = buildWebAppManifest({
			appName: "Cerea",
			basePath: "/chat",
			assetDir: "chatui",
			agentsEnabled: true,
		});

		expect(manifest.name).toBe("Cerea");
		expect(manifest.short_name).toBe("Cerea");
		expect(manifest.description).toBeTruthy();
		expect(manifest.display).toBe("standalone");
		expect(manifest.display_override).toContain("standalone");
		expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/);
		expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
		expect(manifest.lang).toBe("en");
		expect(manifest.dir).toBe("ltr");
		expect(manifest.categories).toContain("productivity");

		const sizes = manifest.icons.map((icon) => icon.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
		expect(manifest.icons.filter((icon) => icon.purpose === "maskable")).toHaveLength(1);
	});

	it("lists the agents shortcut only when the deployment serves the panel", () => {
		const without = buildWebAppManifest({
			appName: "Cerea",
			basePath: "",
			assetDir: "chatui",
			agentsEnabled: false,
		});
		expect(without.shortcuts.map((s) => s.name)).toEqual(["Chats", "Projects"]);

		const withAgents = buildWebAppManifest({
			appName: "Cerea",
			basePath: "",
			assetDir: "chatui",
			agentsEnabled: true,
		});
		expect(withAgents.shortcuts.map((s) => s.name)).toEqual(["Chats", "Projects", "Agents"]);
	});

	it("references icon files that exist in the asset directory", () => {
		const manifest = buildWebAppManifest({
			appName: "Cerea",
			basePath: "",
			assetDir: "chatui",
			agentsEnabled: false,
		});

		for (const icon of manifest.icons) {
			const file = join("static", "chatui", icon.src.split("/").pop() ?? "");
			expect(() => readFileSync(file), `expected ${file} to exist`).not.toThrow();
		}
	});
});
