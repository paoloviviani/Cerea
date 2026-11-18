import { describe, expect, it } from "vitest";
import { m } from "$lib/paraglide/messages";

// The check is a plain Node script, not app code: loaded by URL so the type
// checker (which would try to infer it) leaves it alone.
const { hardCoded, usedKeys, compareMessage, reviewLocale } = (await import(
	/* @vite-ignore */ new URL("../../../scripts/i18n-check.mjs", import.meta.url).href
)) as {
	hardCoded: (source: string) => { line: number; value: string; kind: string }[];
	usedKeys: (files: string[]) => Promise<Map<string, Set<string>>>;
	compareMessage: (base: unknown, translated: unknown) => string[];
	reviewLocale: (
		base: Record<string, unknown>,
		translated: Record<string, unknown>
	) => {
		empty: string[];
		same: string[];
		long: { key: string; english: number; translated: number }[];
	};
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

describe("the Italian catalogue", () => {
	it("answers in Italian, with placeholders and plurals", () => {
		expect(m["settings.title"]({}, { locale: "it" })).toBe("Impostazioni");
		expect(
			m["settings.notifications.notice.removed"]({ label: "Telefono" }, { locale: "it" })
		).toBe("Telefono rimosso.");
		expect(m["settings.notifications.notice.sent"]({ count: 1 }, { locale: "it" })).toBe(
			"Inviata a 1 dispositivo."
		);
		expect(m["settings.notifications.notice.sent"]({ count: 3 }, { locale: "it" })).toBe(
			"Inviata a 3 dispositivi."
		);
		// Italian's "many" (round millions) falls back to the plural form.
		expect(m["settings.notifications.notice.sent"]({ count: 1_000_000 }, { locale: "it" })).toBe(
			"Inviata a 1000000 dispositivi."
		);
	});
});

describe("i18n-check: compareMessage and reviewLocale", () => {
	const plural = (match: Record<string, string>) => [
		{
			declarations: ["input count", "local countPlural = count: plural"],
			selectors: ["countPlural"],
			match,
		},
	];
	const one = "countPlural=one";
	const other = "countPlural=other";

	it("accepts a translation that keeps the placeholders and tags, in any order", () => {
		expect(
			compareMessage("Hi {name}, see {#code}{path}{/code}", "{#code}{path}{/code}: ciao {name}")
		).toEqual([]);
	});

	it("catches a placeholder that was lost, renamed or invented", () => {
		expect(compareMessage("Hi {name}", "Ciao")).toHaveLength(1);
		expect(compareMessage("Hi {name}", "Ciao {nome}")).toHaveLength(1);
		expect(compareMessage("Hi", "Ciao {name}")).toHaveLength(1);
		expect(compareMessage("A {#code}x{/code}", "A {#code}x")).toHaveLength(1);
	});

	it("catches a plural variant that is missing, but allows the extra many", () => {
		const base = plural({ [one]: "{count} file", [other]: "{count} files" });
		expect(
			compareMessage(base, plural({ [one]: "{count} file", [other]: "{count} file" }))
		).toEqual([]);
		const withMany = plural({
			[one]: "{count} file",
			[other]: "{count} file",
			"countPlural=many": "{count} file",
		});
		expect(compareMessage(base, withMany)).toEqual([]);
		expect(compareMessage(base, plural({ [one]: "{count} file" }))).toEqual([
			"has no variant countPlural=other",
		]);
		expect(compareMessage(base, "{count} file")).toHaveLength(1);
		expect(compareMessage(base, plural({ [one]: "{count} file", [other]: "files" }))).toHaveLength(
			1
		);
	});

	it("flags empty and untranslated values, and lets legitimate repeats through", () => {
		const base = { a: "Save changes", b: "Cerea", c: "OK", d: "Hello there friend" };
		const found = reviewLocale(base, { a: "Save changes", b: "Cerea", c: "OK", d: "" });
		expect(found.same).toEqual(["a"]);
		expect(found.empty).toEqual(["d"]);
	});

	it("reports values much longer than the English, without failing them", () => {
		const { long } = reviewLocale(
			{ a: "Short label here", b: "Short label here" },
			{ a: "Una etichetta molto più lunga qui", b: "Etichetta breve" }
		);
		expect(long.map((entry) => entry.key)).toEqual(["a"]);
	});
});
