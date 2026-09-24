# GitHub Actions workflows, parked

This belongs in `.github/workflows/`. GitHub refused it from the agent's
token on 2026-09-24 with exactly:

    ! [remote rejected] thin-agent/quickwins -> thin-agent/quickwins
    (refusing to allow a Personal Access Token to create or update workflow
    `.github/workflows/ci.yml` without `workflow` scope)

The token is a fine-grained PAT; it needs **Repository permissions →
Workflows: Read and write** (or push this yourself). Then:

    git mv deploy/ci/github-workflows/ci.yml .github/workflows/ci.yml
    git rm deploy/ci/github-workflows/README.md
    git commit -m "Activate the CI workflow" && git push

What the workflow does: `npm run lint` + `npm run check`, the `server`/`ssr`
vitest projects against a Mongo service container, and the `client` vitest
project inside the Playwright image pinned to the installed Playwright
version. Browser-driven e2e (`tests/*.spec.ts`) is deliberately left out —
see the workflow's own comments.
