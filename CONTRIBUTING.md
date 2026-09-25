# Contributing

Thanks for helping. Cerea is small and moves quickly, so a short conversation
first saves work on both sides.

- **Bugs and ideas:** open an issue. For a bug, include what you did, what you
  expected, what happened, and your browser and deployment (a cerea-deploy
  preset, or your own setup).
- **Changes:** open a pull request against `main`. Keep it focused on one
  thing, and describe the problem it solves and how you checked it.
- **Before you push:** `npm run check`, `npm run lint`, and the tests that
  cover what you touched (see the README's Development section). For
  `agent/` (galopin), `go vet ./...` and `go test ./...`.
- **Style:** Prettier and ESLint decide formatting and most style questions.
  Svelte 5 runes, TypeScript strict, no `any`.
- **Security issues** go to [SECURITY.md](SECURITY.md), not to a public issue.

By contributing you agree that your contribution is licensed under the
Apache License 2.0, the licence of this repository.
