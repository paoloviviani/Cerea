import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	applyCereaProfile,
	CEREA_ACCENT_ARGB,
	isBlankUrl,
	profileIsRunning,
	startPageHtml,
	START_URL,
	THEME_PREFS,
} from "../src/profile.ts";
import { rig, type Rig } from "./helpers.ts";

const tmp = () => mkdtemp(join(tmpdir(), "cerea-profile-test-"));
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("the profile's theme colour and name", () => {
	it("creates the preferences in a fresh profile", async () => {
		const dir = await tmp();
		assert.deepEqual(await applyCereaProfile(dir), { written: true });
		const prefs = await readJson(join(dir, "Default", "Preferences"));
		assert.equal(prefs.browser.theme.user_color2, CEREA_ACCENT_ARGB);
		assert.equal(prefs.browser.theme.is_grayscale2, false);
		assert.equal(prefs.profile.name, "Cerea");
		const state = await readJson(join(dir, "Local State"));
		assert.equal(state.profile.info_cache.Default.name, "Cerea");
		assert.deepEqual(
			(await readdir(join(dir, "Default"))).filter((f) => f.endsWith(".tmp")),
			[]
		);
		await rm(dir, { recursive: true, force: true });
	});

	it("keeps every other preference of an existing file", async () => {
		const dir = await tmp();
		await mkdir(join(dir, "Default"), { recursive: true });
		await writeFile(
			join(dir, "Default", "Preferences"),
			JSON.stringify({
				homepage: "https://example.test/",
				browser: { show_home_button: true, theme: { color_scheme2: 2, other: 1 } },
				profile: { avatar_index: 26, name: "Person 1" },
			})
		);
		await writeFile(
			join(dir, "Local State"),
			JSON.stringify({ browser: { enabled_labs_experiments: ["a"] } })
		);
		assert.deepEqual(await applyCereaProfile(dir), { written: true });
		const prefs = await readJson(join(dir, "Default", "Preferences"));
		assert.equal(prefs.homepage, "https://example.test/");
		assert.equal(prefs.browser.show_home_button, true);
		assert.equal(prefs.browser.theme.other, 1);
		assert.equal(prefs.browser.theme.color_scheme2, THEME_PREFS.color_scheme2);
		assert.equal(prefs.profile.avatar_index, 26);
		assert.equal(prefs.profile.name, "Cerea");
		const state = await readJson(join(dir, "Local State"));
		assert.deepEqual(state.browser.enabled_labs_experiments, ["a"]);
		await rm(dir, { recursive: true, force: true });
	});

	it("leaves a malformed file untouched and writes nothing", async () => {
		const dir = await tmp();
		await mkdir(join(dir, "Default"), { recursive: true });
		await writeFile(join(dir, "Default", "Preferences"), "{ not json");
		assert.deepEqual(await applyCereaProfile(dir), { written: false, reason: "unreadable" });
		assert.equal(await readFile(join(dir, "Default", "Preferences"), "utf8"), "{ not json");
		await assert.rejects(readFile(join(dir, "Local State"), "utf8"));
		await rm(dir, { recursive: true, force: true });
	});

	it("writes nothing while Chrome runs on the profile, and does once its lock is stale", async () => {
		const dir = await tmp();
		await symlink(`host-${process.pid}`, join(dir, "SingletonLock"));
		assert.equal(await profileIsRunning(dir), true);
		assert.deepEqual(await applyCereaProfile(dir), { written: false, reason: "running" });
		await assert.rejects(readFile(join(dir, "Default", "Preferences"), "utf8"));
		await rm(join(dir, "SingletonLock"));
		await symlink("host-2147483000", join(dir, "SingletonLock"));
		assert.equal(await profileIsRunning(dir), false);
		assert.deepEqual(await applyCereaProfile(dir), { written: true });
		await rm(dir, { recursive: true, force: true });
	});
});

describe("the start page", () => {
	it("says what it is, has no script and no network, and escapes the computer's name", () => {
		const html = startPageHtml('Office <PC> "1"');
		assert.match(html, /Cerea browser on Office &#60;PC&#62; &#34;1&#34;/);
		assert.match(html, /Cerea can use the tabs in this window when you ask in a chat\./);
		assert.ok(!/<script|src=|href=/i.test(html));
		assert.ok(isBlankUrl(START_URL) && isBlankUrl("about:blank") && !isBlankUrl("https://a.test/"));
	});

	describe("in the browser", () => {
		let r: Rig;
		before(async () => {
			r = await rig({ branding: true });
		});
		after(() => r.close());

		it("shows on the first tab, is not listed as a tab and is not read as a page", async () => {
			// Starting the browser puts the start page on its first tab.
			const first = await r.tabs();
			assert.equal(first.started, true, "the runtime says it started the browser");
			await r.session.withPage(async (_p, context) => {
				const start = context.pages().find((p) => p.url() === START_URL);
				assert.ok(start, "a tab is on the start page");
				assert.match(await start.locator("h1").innerText(), /^Cerea browser on /);
			});
			assert.ok(first.tabs.every((t) => !t.url.includes("cerea.invalid")));
			// It is not a page to snapshot: what the task sees is the same as with no page.
			await r.session.endTask({ keep: true });
			const snap = await r.snapshot();
			assert.ok(!snap.text.includes("Cerea browser on"));
		});

		it("leaves a normal task to navigate away from it", async () => {
			const snap = await r.goto("/form");
			assert.equal(snap.url, `${r.fx.base}/form`);
			assert.equal((await r.tabs()).started, undefined, "the browser was already running");
		});
	});
});
