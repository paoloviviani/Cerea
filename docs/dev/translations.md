# Translations: messages, locales, and the check

The app's words are moving, area by area, into one catalogue,
`messages/en.json`, read through Paraglide JS (inlang) the way the Pystino
console does it, with the same key style, the same `en-XA` pseudo-locale and the
same `i18n:check`. English is the only language that ships; the machinery is
here so that adding a language is a file, not a change to every screen.

**Converted so far:** every screen: Settings, chat (conversation, composer,
messages), sidebar and navigation, connectors, the app shell and its shared
components, projects, models, skills, knowledge, memory, admin, the Code area
(`src/routes/code`, `src/lib/components/code`) and the Workspace area
(`src/routes/workspace`, `src/lib/components/workspace`). The list is `CONVERTED` in
`scripts/i18n-check.mjs`. Everything else still spells its words in the
template, which is correct until its area is converted.

**Adding a string** (in a converted area, or one you are converting):

1. Add the key to `messages/en.json`: `area.screen.thing`, lower snake_case words
   joined by dots, e.g. `settings.notifications.devices.remove`. A message with a
   value in it uses `{name}`; a count uses a plural variant (see
   `settings.notifications.notice.sent`); a bit of markup uses `{#tag}text{/tag}`.
2. Use it: `import { m } from "$lib/paraglide/messages";` then
   `{m["settings.title"]()}` or `m["settings.notifications.notice.removed"]({ label })`.
   Write the key as a literal (`m["a.b"]`, never built from a variable): the check
   finds keys by reading them. To choose between messages, keep the functions in a
   lookup table (`{ blue: m["settings.application.accent.option.blue"] }`).
3. Markup: declare a snippet per tag, then
   `<Rich parts={m["key"].parts({ ... })} tags={{ code }} />` (`$lib/i18n/Rich.svelte`). The words and their order are the translator's, the
   look is the template's.
4. Run `npm run i18n:pseudo` (regenerates `messages/en-XA.json`) and
   `npm run i18n:check`.

Words that are not words (the product name, a command, a value from the API) stay
literal, on a line that says so: `<!-- i18n: literal -->` in a template, or
`// i18n: literal` in a script (`i18n: server text` for text that came off the
wire). Numbers, dates and relative times never go through `toLocaleString` with a
hard-coded tag: use `$lib/i18n/format` (`formatNumber`, `formatDate`,
`formatDateTime`, `formatRelativeTime`, `formatCurrency`), which follow the
page's language, not the browser's.

**Converting an area:** replace its strings with messages, add the directory to
`CONVERTED` in the same commit, and `npm run i18n:check` then fails on any word
that slips back into a template there (text between tags, and `title`,
`placeholder`, `aria-label`, `alt`, `label`). The check also fails on a key used
but missing, a key in `en.json` that no code uses, an out-of-date `en-XA.json`,
and a real locale that lost a key or a `{placeholder}`. It runs in `npm run lint`
(so in CI's check job). Strings in `.ts` helpers (an error message built in
`utils/`) are not scanned: convert those by hand when you convert their caller.

**Adding a language:** copy `messages/en.json` to `messages/<tag>.json` and
translate the values (keys and `{placeholders}` unchanged), add the tag to
`locales` in `project.inlang/settings.json`, run `npm run i18n:check`. It appears
in Settings → Language by itself, written in its own name.

**Which language a request gets** is decided once, in `hooks/handle.ts`, by the
pure `resolveLocale` (`src/lib/i18n/resolve.ts`): the person's saved choice
(`Settings.locale`, saved through the same two settings endpoints as the palette,
so it follows them across devices), then the `cerea_locale` cookie (what the
selector wrote in this browser), then `Accept-Language`, then English. The render
runs inside Paraglide's per-request store (`server/requestLocale.ts`), so
concurrent requests never see each other's language; `%lang%` in `app.html`
becomes `<html lang>` in the first chunk; the root layout returns the answer as
`data.locale` and the browser adopts it before its first render
(`adoptServerLocale`), so hydration matches the HTML. Changing the language in
Settings saves it, sets the cookie and reloads: messages are plain strings, not
reactive. Changing the browser's language does nothing for a person who has
chosen one, and that is the point of choosing.

**`en-XA`** is English with every message accented and bracketed, so a string
that is still hard-coded stands out on screen. It is a developer tool: it is
offered in Settings → Language only under `vite dev` or with
`CHAT_PSEUDO_LOCALE=true`, it is never selected from `Accept-Language`, and the
server ignores it from the cookie or the saved setting where it is not enabled.
Pick it in Settings (dev), or set the `cerea_locale` cookie to `en-XA`.

`src/lib/paraglide/` is generated (by the Vite plugin, and by
`npm run i18n:compile`, which `check` and `i18n:check` run first) and is not
committed. The compiler options are in `project.inlang/paraglide.config.ts`.
