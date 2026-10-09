# Source

- **Upstream:** https://github.com/K-Dense-AI/scientific-agent-skills,
  `skills/exploratory-data-analysis` + `skills/statistical-analysis`, merged
- **Commit:** 92ace75ac21efe19a620434e0ca4e356081fe807
- **Licence:** MIT (`LICENSE.md`, kept verbatim beside this file; upstream
  copyright "K-Dense Inc.")

## Changes from upstream

- The two skills are merged into one `data-analysis` skill covering the
  common workflow: frame → inspect → select → assumptions → test + effect
  size → report.
- Rewritten for Cerea's sandbox: the statistics stack is scipy + statsmodels
  (both in Cerea's Pyodide package set) instead of pingouin + PyMC; effect
  sizes are computed explicitly in numpy. No CLI (`assumption_checks.py` and
  the EDA inspector CLIs are not bundled), no `uv` environments, no network.
- Dropped per the wave's scope decision: the domain format references
  (HDF5/FASTA/FASTQ, bioinformatics, chemistry, microscopy, spectroscopy,
  proteomics) and the Bayesian guidance (PyMC is unavailable). The
  data-untrusted boundary rules are kept.
- Bundled from upstream: `references/test_selection_guide.md`,
  `references/assumptions_and_diagnostics.md`,
  `references/effect_sizes_and_power.md`, `references/reporting_standards.md`
  (statistical-analysis), `references/report_template.md`
  (exploratory-data-analysis assets). All unmodified.
