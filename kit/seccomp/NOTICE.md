# Seccomp profile for the headless browser

`playwright.json` is Playwright's own Docker seccomp profile, unmodified, used
by the `playwright` service (profile `fetch`) in `../compose.yaml` so Chromium's
sandbox can start without extra capabilities.

- Source: https://github.com/microsoft/playwright/blob/v1.64.1/utils/docker/seccomp_profile.json
- Playwright tag: v1.64.1 (commit cfe490d941f992655948eee8fd4fd94e1c4234bf)
- Licence: Apache-2.0, Copyright (c) Microsoft Corporation
  (https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE)

When you bump `PLAYWRIGHT_VERSION`, replace the file with the one from the new
tag and update this notice.
