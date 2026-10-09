# Source

- **Upstream:** https://github.com/K-Dense-AI/scientific-agent-skills,
  `skills/scientific-visualization`
- **Commit:** 92ace75ac21efe19a620434e0ca4e356081fe807
- **Licence:** MIT (`LICENSE.md`, kept verbatim beside this file; upstream
  copyright "K-Dense Inc.")

## Changes from upstream

- Rewritten for Cerea's sandbox: no CLI (upstream's `scripts/` are
  argparse-driven CLIs and are not bundled), no Plotly/Kaleido (needs a
  browser, which does not exist here), no `uv` environment management, no
  journal live-verification workflow (the sandbox has no network — publisher
  requirements come from the person). The honest-encoding guardrails, the
  accessibility doctrine, the object-oriented matplotlib guidance, the
  constrained-layout and color-normalization snippets, and the seaborn
  0.13 `errorbar` idiom are kept as written.
- Bundled from upstream, unmodified: `assets/publication.mplstyle`,
  `assets/presentation.mplstyle`, `assets/nature.mplstyle`,
  `references/color_palettes.md`.
- `references/matplotlib_examples.md` is upstream's with the skill-directory
  bootstrap section and the backend paragraph replaced by the sandbox
  reality (Agg only, no TeX, files via savefig).
- Delivery guidance reflects Cerea's file convention (savefig for named
  files; automatic figure capture otherwise).
