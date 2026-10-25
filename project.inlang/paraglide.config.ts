import { defineConfig } from "@inlang/paraglide-js";

/**
 * Compiler options for the message catalogue (see AGENTS.md, "Translations").
 *
 * They live here rather than in `vite.config.ts` because every surface that
 * compiles the catalogue reads this one file: the Vite plugin (dev and build)
 * and the `paraglide-js compile` that `check` and the `i18n:*` scripts run
 * before TypeScript or the checker ever see the generated output.
 *
 * The locale policy is NOT expressed through `strategy`. Which language a
 * request gets is decided once per request, in `src/lib/i18n/resolve.ts` (a
 * pure, unit-tested function), by `hooks.server.ts`, which runs the render
 * inside Paraglide's AsyncLocalStorage so that `getLocale()` answers with that
 * decision on the server. The root layout then hands the same answer to the
 * browser (`overwriteGetLocale`), so hydration cannot disagree with the HTML.
 * The strategy below is only the fallback for code that runs outside both
 * (a script, a test): the explicit-choice cookie, then English.
 */
export default defineConfig({
	outdir: "./src/lib/paraglide",
	/**
	 * One output layout everywhere. The plugin otherwise switches to
	 * `locale-modules` outside production, which moves every generated `.d.ts`.
	 */
	outputStructure: "message-modules",
	/** Without the declarations every `m["…"]` is an implicit `any`. */
	emitTsDeclarations: true,
	/** Read by `src/lib/i18n/locale.ts`, which is the one place that names it. */
	cookieName: "cerea_locale",
	strategy: ["cookie", "baseLocale"],
});
