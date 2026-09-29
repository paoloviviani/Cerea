# Reference

!!! info "For everyone"

    Links to the specifications and to the other documentation this site does not repeat.

This page is only links. The wire protocol and the upstream documentation are
kept where they live, so there is one copy of each.

## In this repository

- [`agent/PROTOCOL.md`](https://github.com/paoloviviani/Cerea/blob/main/agent/PROTOCOL.md):
  the wire protocol between the chat and galopin (transport, pairing and
  authorization, operations, events, machine powers). Binding for both ends.
- [`agent/README.md`](https://github.com/paoloviviani/Cerea/blob/main/agent/README.md):
  building and testing galopin.
- [`CONTRIBUTING.md`](https://github.com/paoloviviani/Cerea/blob/main/CONTRIBUTING.md),
  [`SECURITY.md`](https://github.com/paoloviviani/Cerea/blob/main/SECURITY.md),
  [`PRIVACY.md`](https://github.com/paoloviviani/Cerea/blob/main/PRIVACY.md),
  [`LICENSE`](https://github.com/paoloviviani/Cerea/blob/main/LICENSE) (Apache-2.0)
  and [`NOTICE`](https://github.com/paoloviviani/Cerea/blob/main/NOTICE).

## Upstream chat-ui

Cerea is a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)
(Apache-2.0). Its documentation is kept in this repository as upstream wrote it,
and parts of it do not apply to Cerea. It is not rendered on this site; read it
at source:

- [Configuration overview](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/overview.md)
  (every variable [Configuration](configuration.md) does not list)
- [OpenID](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/open-id.md),
  [MCP tools](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/mcp-tools.md),
  [LLM router](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/llm-router.md),
  [metrics](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/metrics.md)
  and [theming](https://github.com/huggingface/chat-ui/blob/main/docs/source/configuration/theming.md)
- [Architecture](https://github.com/huggingface/chat-ui/blob/main/docs/source/developing/architecture.md)

## The rest of the stack

- **Pystino**, the gateway and console that every call goes through, has its own
  [documentation](https://github.com/paoloviviani/Pystino/tree/main/docs):
  identity and administrators, accounting and quotas, redaction, the console, and
  what the gateway provides to coding agents.
- **cerea-deploy**, the deployment, has the
  [README](https://github.com/paoloviviani/cerea-deploy#readme) that is the
  install and upgrade runbook (see [Deploying](deploy.md)).
