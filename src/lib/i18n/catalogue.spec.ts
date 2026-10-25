import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages";

// The check is a plain Node script, not app code: loaded by URL so the type
// checker (which would try to infer it) leaves it alone.
const { hardCoded, usedKeys } = (await import(
	/* @vite-ignore */ new URL("../../../scripts/i18n-check.mjs", import.meta.url).href
)) as {
	hardCoded: (source: string) => { line: number; value: string; kind: string }[];
	usedKeys: (files: string[]) => Promise<Map<string, Set<string>>>;
};

describe("the catalogue", () => {
	it("answers in English by default and in marked-up English for en-XA", () => {
		expect(m["settings.title"]()).toBe("Settings");
		expect(m["settings.title"]({}, { locale: "en-XA" })).toBe("[Śéťťíńǧś]");
	});

	it("keeps placeholders and plural variants intact in the pseudo-locale", () => {
		expect(
			m["settings.notifications.notice.removed"]({ label: "Phone" }, { locale: "en-XA" })
		).toBe("[Ŕéḿóǚéď Phone.]");
		expect(m["settings.notifications.notice.sent"]({ count: 1 })).toBe("Sent to 1 device.");
		expect(m["settings.notifications.notice.sent"]({ count: 3 })).toBe("Sent to 3 devices.");
		expect(m["settings.notifications.notice.sent"]({ count: 3 }, { locale: "en-XA" })).toBe(
			"[Śéńť ťó 3 ďéǚíćéś.]"
		);
	});
});

describe("i18n-check: hardCoded", () => {
	it("flags words in text nodes and in text props", () => {
		const found = hardCoded(
			[
				"<h1>Hello there</h1>",
				'<input placeholder="Type here" />',
				'<button title="Close">x</button>',
			].join("\n")
		);
		expect(found.map((p) => [p.kind, p.value])).toEqual(
			expect.arrayContaining([
				["text", "Hello there"],
				["placeholder", "Type here"],
				["title", "Close"],
			])
		);
	});

	it("passes messages, expressions, punctuation, scripts, styles and comments", () => {
		expect(
			hardCoded(
				[
					"<script>const label = 'Plain English in a script';</script>",
					"<style>.a > b { color: red }</style>",
					"<!-- Plain English in a comment -->",
					'<p>{m["a"]()} · {x > 1 ? "no" : "no"}</p>',
					'<input placeholder={m["b"]()} aria-label={`${m["c"]()}`} />',
					"<span>…</span>",
				].join("\n")
			)
		).toEqual([]);
	});

	it("lets a line or the line before it say 'i18n: literal'", () => {
		expect(hardCoded("<!-- i18n: literal -->\n<b>Cerea</b>")).toEqual([]);
		expect(hardCoded("<b>Cerea</b> <!-- i18n: literal -->")).toEqual([]);
		expect(hardCoded("<b>Cerea</b>")).toHaveLength(1);
	});
});

describe("i18n-check: usedKeys", () => {
	it("is exported for the check and reads this app's own files", async () => {
		const used = await usedKeys([
			new URL(import.meta.url).pathname.replace("catalogue.spec.ts", "rich.spec.ts"),
		]);
		expect(used.has("settings.application.task_model.description")).toBe(true);
	});
});
