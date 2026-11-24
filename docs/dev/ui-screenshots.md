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

## The user-docs screenshots

`scripts/docs-screenshots/` regenerates the images in `docs/assets` from the hermetic e2e stack
(fake machine, fake data, a user called Ada). To re-run, after `npm run build`:
`E2E_SKIP_BUILD=1 flock /tmp/heavy.lock.a npx playwright test -c scripts/docs-screenshots/playwright.config.ts`
(`SHOTS_ONLY=<regexp on the test title>` shoots a subset), then
`uv run --with pillow python scripts/docs-screenshots/finish.py` writes the WebP files. Look at each one.

## The README animation and social preview

`docs/assets/cerea-demo.mp4` and `cerea-demo.webp` (the README's first screen) are recorded from the
same hermetic stack as the screenshots, by `scripts/docs-screenshots/demo.spec.ts`: three short
clips with Playwright's video (a: a question, a streamed answer and its artifact; b: a coding
agent's approval card, Allow once, the result; c: the same on a phone), with the fake machine
answering the approval. The helpers they share with `shots.spec.ts` are in `common.ts`. To re-record,
build once, then:

```sh
npm run build        # alone: a build next to the stack can run out of memory
E2E_SKIP_BUILD=1 flock /tmp/heavy.lock.a npx playwright test -c scripts/docs-screenshots/playwright.demo.config.ts
uv run --with imageio-ffmpeg --with pillow python scripts/docs-screenshots/make-demo.py
```

The first writes `clip-a/b/c.webm` and `clips.json` to `$DEMO_OUT` (default `/var/tmp/readme-tmp/demo`);
the second trims, joins and encodes them (the box has no ffmpeg; `imageio-ffmpeg` bundles one).
Keep the pace calm (pauses, no cursor chasing), the MP4 under about 8 MB and the WebP under about
5 MB, and look at frames of the result before committing.

`docs/assets/social-preview.png` (1280x640, GitHub's social preview) comes from
`scripts/docs-screenshots/social-preview.html` with `node scripts/docs-screenshots/social-preview.mjs`.
GitHub has no API for it: the owner uploads it under Settings, General, Social preview.
