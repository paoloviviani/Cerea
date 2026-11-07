# Source

- **Origin:** written for Cerea by its maintainer; no upstream. Licensed with
  the repository (Apache-2.0).

## Notes

- Describes the `slides` artifact type (ADR 0111): HTML `<section>` slides on
  reveal.js, with a Markdown shortcut. Keep the theme names and brand variables
  here in step with `src/lib/utils/slides/themes.ts`; `slidesSkill.spec.ts`
  checks it.
- `references/example-deck.html` is a copy of the test fixture
  `src/lib/utils/slides/fixtures/talk-deck.html`, which the screenshots use.
