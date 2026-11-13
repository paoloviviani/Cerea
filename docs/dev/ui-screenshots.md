# Validating UI with screenshots

Tests prove behaviour; screenshots are how a person judges a visual change. The
rules:

- **Screenshot the real app, not a mock.** Write a throwaway Playwright spec
  (`tests/_shots.spec.ts`, deleted afterwards, never committed) that seeds the
  state with the fixtures (`seedConversation` and friends), builds once, and
  runs with `E2E_SKIP_BUILD=1`.
- **Wait for the rendered state before shooting.** Markdown renders after the
  text arrives: wait for a heading or table role, not for the text. A shot taken
  too early shows raw markdown and misleads whoever reviews it.
- **Prototype before building.** To compare options without touching code,
  inject CSS with `page.addStyleTag()` per variant (fonts as data-URL
  `@font-face`, token overrides with `:root:root` for specificity). Only after a
  choice is made does the change go into the source, and then it is
  screenshotted again from the build.
- **Always both widths, and both themes when colour changes:** desktop 1440 and
  phone 390 (360 when space is tight); light and dark by adding `dark` to
  `<html>`. A phone screenshot needs a tall viewport (e.g. 390×1300) to show a
  whole reply.
- **Compare side by side.** Stitch before/after (or one cell per variant) into a
  labelled contact sheet with Pillow (`uv run --with pillow python …`), same
  crop and scale for every cell. Separate screenshots viewed one after the
  other hide small differences.
- **Use element screenshots for details** (`locator.screenshot()`, after
  `scrollIntoViewIfNeeded()`): a folded long message, a focus ring, a single
  control.
- **Check overflow by measurement, not by eye.** A page can scroll sideways
  inside its own scrolling panel while the window does not; assert that no
  element's `scrollWidth` exceeds its `clientWidth` across the scroll
  containers, at both widths (`tests/project-page.spec.ts` does this).
- **Look at every screenshot yourself before reporting it.** Then save the set
  outside the repository, in a reports directory the owner reads (for example
  `reports/screenshots/<date>-<topic>/` next to the checkout), never committed,
  and point to the files.
