# Seccomp profile for the headless browser

`playwright.json` is Playwright's own Docker seccomp profile, unmodified, used
by the `playwright` service (profile `fetch`) in `../compose.yaml` so Chromium's
sandbox can start without extra capabilities.

- Source: https://github.com/microsoft/playwright/blob/v1.65.0/utils/docker/seccomp_profile.json
- Playwright tag: v1.65.0 (commit a1f35e1955976e84411f9c10358228a80b763ebe)
- Licence: Apache-2.0, Copyright (c) Microsoft Corporation
  (https://github.com/microsoft/playwright/blob/v1.65.0/LICENSE)

When you bump `PLAYWRIGHT_VERSION`, replace the file with the one from the new
tag and update this notice.
