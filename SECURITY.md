# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: the repository's **Security**
tab → **Report a vulnerability**. Please don't open a public issue.

Include what is affected, how to reproduce it, and what an attacker gains.

## Supported versions

Security fixes are made on `main` and in the latest release.

## What to expect

We acknowledge a report within five working days, keep you informed while we
work on a fix, and credit you when it is released, unless you prefer otherwise.
Please give us reasonable time to release a fix before disclosing.

## CVE-2026-111497 (Brotli, "Node2Shell")

An out-of-bounds write in Google's Brotli decoder (1.0.3 to 1.2.0), fixed in
Node.js 22.23.4, 24.22.1 and 26.12.1 and in Brotli 1.0.10, 1.1.1 and 1.2.1.
Cerea's response, from 0.32.4:

- Every Node base image is pinned to an exact patched version (24.22.1 for the
  chat image, 22.23.4 for the MCP proxy image), and a test fails on a floating
  `node:` tag or a version below the fix. CI uses the same versions.
- The web-fetch browser sends `Accept-Encoding: gzip, deflate`, so a
  well-behaved server never sends it Brotli. Checked against the kit's
  Playwright image: without this the browser sends `gzip, deflate, br, zstd`
  over HTTPS.
- The Playwright image's Node is patched. Its Chromium's bundled Brotli is not
  verified, and its system `libbrotli1` (1.1.0) is unpatched but not used by
  the fetch path, as far as is known. The image will be bumped when a
  Playwright release with a newer Chrome ships.

A malicious server can still ignore the header, so keep the browser service
unpublished and credential-free, as the kit already does.
