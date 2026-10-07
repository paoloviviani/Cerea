# Security policy

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Report a vulnerability, under the Security tab). If it is unavailable,
contact the maintainer directly; do not open a public issue for
anything security-sensitive.

Please include what the issue is, how to reproduce it, which component
it touches (Cerea, Pystino, the deployment kit, or an interaction
between them), and any affected versions or pins.

## Scope

This repository holds the deployment kit: the compose stack, the
Authelia and Caddy configuration templates, the pin and build tooling,
and the deploy runbook. It does not hold component code — report
issues in Cerea or Pystino's own security policies where the fix
belongs; cross-component interactions can be reported here and will
be routed.

## Expectations

No bounty is offered. Reports are acknowledged within a few days and
fixed according to severity; fixes are released under the normal
release process (see CHANGELOG.md), and pins move only forward.

## Deployment-specific notes

- Secrets live in `.env` (permissions `0600`) and are never committed;
  the pin tooling writes image digests, never credentials.
- The stack is designed for a single-origin deployment behind the
  bundled proxy; running it exposed differently is unsupported and
  may be insecure.
- The agent machines dial **out** over WSS with their own OIDC
  credential — nothing capability-bearing is stored in the chat's
  database, and a revoked machine stays as a tombstone.
