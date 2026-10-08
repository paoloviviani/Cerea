---
name: charts
description: >
  Build truthful, accessible, publication-ready figures with matplotlib and
  seaborn — honest encodings, uncertainty displays, colour-vision-safe
  palettes, and clean exports as PNG/SVG. Use when the person wants a chart,
  plot, or figure from data, or asks to check or improve an existing figure.
license: MIT
---

# Scientific visualization

Build figures that preserve scientific meaning before optimizing appearance.
Separate universal principles from dated publisher rules, preserve raw data
and transformations, use color redundantly, and inspect delivered files
rather than trusting plotting defaults.

## Non-negotiable guardrails

- Never alter, hide, invent, or selectively enhance data to improve a figure.
- Preserve raw tables/images, exclusions, missing-value codes, analysis code,
  normalization, binning, image adjustments, and random seeds.
- Do not silently connect missing observations, suppress inconvenient points,
  upsample images as if detail increased, or tune axes/dual axes to
  exaggerate a conclusion.
- Static output is the deliverable in this environment: a saved PNG or SVG
  file, or the figure the app shows automatically. There is no interactive
  hover, so every annotation must be in the figure itself.

## Workflow

### 1. Define the evidence and destination

Record before coding: audience and medium; the figure's final width; variable
semantics, units, sample/replicate structure; missing/censored values; the
estimator and uncertainty definition; transformations (filtering, aggregation,
normalization, smoothing, bins). If requirements are not known, create a
provisional general figure and label publisher-specific choices as pending.

### 2. Choose an honest encoding

Prefer position on a common scale. Before coding, check:

- **Bars/areas:** normally include zero, because length/area is measured from
  a baseline.
- **Points/lines:** nonzero limits can be valid; show context and disclose
  breaks.
- **Uncertainty:** name SD, SE, CI, percentile, or another interval; state
  `n` and the unit of replication.
- **Raw observations:** show them when feasible; do not let jitter obscure
  categories/values.
- **Missing data:** distinguish missing, zero, censored, and excluded; use
  gaps or explicit styling.
- **Log axes:** label the base/transform and declare how zero/negative values
  are handled.
- **Binning/smoothing:** record edges, bandwidth/window, method.
- **Normalization:** state the formula/reference and keep limits consistent
  across compared panels.
- **Dual axes:** prefer aligned panels; if unavoidable, justify units and do
  not engineer apparent correlation.

### 3. Design accessibility in, not after

- Use color plus marker, line style, hatching, direct label, or panel
  separation — color cannot be the only cue.
- Choose qualitative, sequential, diverging, or cyclic color according to
  data semantics. See the bundled `references/color_palettes.md` for
  colour-vision-safe palettes (Okabe-Ito, viridis and friends).
- Audit contrast at the rendered size; make missing and out-of-range values
  explicit (a light-grey "bad" colour on a colormap, a gap in a line).

### 4. Implement with the object-oriented API

```python
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(89 / 25.4, 60 / 25.4), layout="constrained")
ax.plot(x, y, marker="o", label="Observed")
ax.set(xlabel="Time (hours)", ylabel="Response (unit)")
ax.legend()
```

- `layout="constrained"` supports colorbars, nested GridSpec, subfigures and
  `subplot_mosaic`. Do not call `tight_layout()` afterwards; it disables
  constrained layout. Avoid `bbox_inches="tight"` unless a changed page size
  is intentional.
- Color normalization only when its mapping matches the meaning:

```python
import matplotlib as mpl

norm = mpl.colors.TwoSlopeNorm(vmin=-2, vcenter=0, vmax=5)
cmap = mpl.colormaps["RdBu_r"].with_extremes(bad="#777777")
image = ax.imshow(values, norm=norm, cmap=cmap, interpolation="nearest")
fig.colorbar(image, ax=ax, label="Change (unit)")
```

- Seaborn (0.13) uses the current `errorbar` API:

```python
import seaborn as sns

sns.lineplot(
    data=frame, x="time", y="response", hue="treatment",
    style="treatment", markers=True, errorbar=("ci", 95), n_boot=5000,
)
```

- Reusable style presets ship as matplotlib style files — write the bundled
  asset into the working directory and load it:
  `plt.style.use("publication.mplstyle")` (also `presentation.mplstyle`,
  `nature.mplstyle`). A preset is a starting point, not a compliance
  certificate; publisher rules come from the person, not from this skill.

### 5. Deliver

- `plt.savefig("figure-name.png", dpi=300)` for a named file (or `.svg` for
  vector). A figure drawn without an explicit save is shown to the person
  automatically as `figure-1.png`, `figure-2.png`, … — but do not count on
  those names; save explicitly when the file matters.
- Name files descriptively (`response-by-treatment.png`, not `fig2.png`).
- State what the figure shows in one or two sentences in the chat, including
  the uncertainty definition and `n`, and anything the person should check.

## Rules

- The sandbox has matplotlib, seaborn, numpy and pandas; no Plotly, no
  interactive backends, no LaTeX/PGF, no network for fonts or data.
- Do not claim a DPI value or palette makes a figure "journal-compliant";
  requirements come from the person's target venue.
- `matplotlib_examples.md` (bundled) holds ready-to-adapt snippets: multi-panel
  layouts, errorbars, heatmaps, annotations. Adapt them to the data at hand —
  they are reference code, not a runner.
