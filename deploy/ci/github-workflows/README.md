# GitHub Actions workflows, parked

These belong in `.github/workflows/`. GitHub refused them from the agent's
token on 2026-09-24 with exactly:

    ! [remote rejected] deploy/rearch -> deploy/rearch (refusing to allow a
    Personal Access Token to create or update workflow
    `.github/workflows/images.yml` without `workflow` scope)

The token is a fine-grained PAT; it needs **Repository permissions →
Workflows: Read and write** (or push these yourself). Then:

    git mv deploy/ci/github-workflows/*.yml .github/workflows/
    git rm deploy/ci/github-workflows/README.md
    git commit -m "Activate the workflows" && git push

What the workflow does: builds every image on PRs; pushes to
`ghcr.io/paoloviviani/cerea` (private while the repository is private) on
`main` (tag `edge`), `deploy/rearch` (tag `rearch`) and `v*` tags (`X.Y.Z`,
`X.Y`); deletes untagged versions beyond the newest five.

| Workflow | Runs on | What |
|---|---|---|
| `ci.yml` | PRs (docs excluded) | lint, svelte-check, server + ssr unit tests |
| `contract.yml` | PRs touching gateway-facing code (pinned gateway); Mondays (`edge`, non-blocking) | the gateway contract |
| `images.yml` | pushes to main (path-filtered) and v* tags | build + push `ghcr.io/paoloviviani/cerea` (private), prune untagged |

Budgeted for the GitHub free plan: see the deployment re-architecture report,
§11 ("Action minutes").
