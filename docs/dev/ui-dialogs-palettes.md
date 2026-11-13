# Dialogs, palettes and the look

## The dialog language, and where it comes from

**A project is a page (`/projects/<id>`, `/projects/new`); models, MCP servers
and knowledge are tabs of the workspace page** (`/workspace`), and every manager
screen and the project page are drawn in the shape the MCP dialog gave this app — the design language's reference
implementation is still `src/lib/components/mcp/`. Read
`MCPServerManager.svelte` and `ServerCard.svelte` before adding a screen.

What it consists of, all of it in `src/lib/components/overlay/styles.ts` as
constants lifted verbatim from those two files:

- **sub-views switch inside one screen** on a `view` variable, rather than
  navigating — somebody managing knowledge is doing one task and should not
  lose their place at each step of it. In the overlay era that came with
  per-view widths (`w-[800px]` for a list, `w-[600px]` for a form); the
  workspace managers keep the switching and lost the shell, drawing inside the
  tab's card instead (`styles.EMBEDDED`);
- a **tinted summary strip** under the header: a `size-10 rounded-xl
bg-blue-500/10` icon tile, a count, a state, and the actions on the right.
  `bg-blue-50` when there is something, `bg-gray-100` and `grayscale` when
  there is not;
- **blue-600 as the single accent** — the only place blue is a fill rather than
  a tint is a primary button;
- **two-column gradient cards** (`bg-linear-to-br`) that tint blue when active;
- **rounded-full status pills** with an icon, in four tones;
- **dashed empty states** with a large muted icon and a primary call to action;
- a closing **Quick Tips** block, which is where the surprising rules go.

Three practical notes. `btn` is a project class, not a Tailwind one.
`bg-linear-to-br` is Tailwind 4's spelling and `bg-gradient-to-br` silently
does nothing. And the MCP dialog deliberately still inlines its own classes
rather than importing the constants — it is the definition, and moving it one
step away from itself would be the wrong direction.

**Old manager addresses redirect into the workspace.** `/knowledge` and
`/knowledge/<id>` redirect to `/workspace?tab=kb` (with the `id` carried over),
because people link to those addresses. `/projects` is the list of projects and
`/projects/<id>` one project's page (`ProjectPage`; `ProjectsManager` is only
the list now, and the overlay is gone). The one trap that caused — **a page body runs
on the server**, so a manager that fetched in its component body answered 502
with `Failed to parse URL from /chat/api/v2/...`. Every manager loads in
`onMount`, which the workspace tabs also rely on.

## Palettes: accent and background tone

**Settings → Application settings → Appearance** offers an accent (Blue,
Violet, Teal, Green, Rose, Orange) and a background tone (Gray, Slate, Stone),
stored as `Settings.accent` / `Settings.neutral` (`utils/palettes.ts`). The
theme (System, Light, Dark) is separate and stays in `localStorage`. Three
things to know:

- **The defaults are the absence of an attribute.** `paletteAttributes()` emits
  `data-accent` / `data-neutral` on `<html>` only for a non-default choice, so
  a person who never picked one, and a page drawn before settings load, is the
  unthemed app. `hooks/handle.ts` fills `%paletteAttrs%` in `app.html` from the
  stored settings (`server/paletteSettings.ts`), so there is no flash.
- **`src/styles/palettes.css` is generated** by `scripts/generate-palettes.mjs`
  (then `npx prettier --write` on it): edit the tables in the script, never the
  CSS. Every shade is the sRGB hex Tailwind's oklch value clips to, because
  `palettes.contrast.test.ts` measures what the browser paints and Tailwind 4
  emits no `--color-teal-*` variable that nothing uses. The contrast test holds
  every combination to 4.5:1 in light and dark.
- **Palettes are Cerea-only.** `tokens.css` stays a byte copy of Pystino's; the
  palettes override it from their own file. The swatch colours in
  `utils/palettes.ts` are checked against the CSS by a test.
