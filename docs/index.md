# Cerea

Cerea is a self-hosted chat for the models your gateway exposes, with
knowledge bases, artifacts, Python in the browser, and coding agents on your
own machines.

!!! info "For everyone"

    Start here to find the section written for you.

![Cerea](assets/cerea.png)

**The name.** _Cerea_ is a Turinese _modo di dire_: a historic, affectionate
greeting that means both _buongiorno_ and _arrivederci_.

## The stack

Cerea is one part of a stack of three repositories, and this site documents
the chat:

| Part               | What it is                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Cerea**          | this repository: the chat, and **galopin**, the agent that runs on a person's own machine (`agent/`)     |
| **Pystino**        | the gateway and its console: every model call, its accounting, quotas, redaction and sign-in             |
| **The deploy kit** | the deployment (`kit/` here): one `compose.yaml`, a documented `.env.example` and a `./configure` script |

Each call the chat makes carries the signed-in person's own token, so quotas
and billing are theirs. Pystino has its own documentation; this site links to it from the
[reference](reference.md) page rather than repeating it.

!!! tip "Three ways to run it"

    The whole stack from the deploy kit, the chat without the kit, or the
    chat without Pystino at all — each a supported path with a different
    feature set. [Deploying](deploy.md) lays them out side by side.

## Which section is yours

| If you are…              | Read                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **using** the chat       | _Using Cerea_: [Chat](chat.md), [Artifacts](artifacts.md), [Python in the browser](pyodide.md), [Skills](skills.md), [Knowledge and projects](knowledge.md), [Connectors](connectors.md), and [Agent machines](agent-machines.md) for the coding agents you pair from your own laptop |
| **running** a deployment | _Operating Cerea_: [Deploying](deploy.md), [Configuration](configuration.md), [Administering the chat](chat-admin.md) and [The `/code` panel](code-panel.md); the [headless browser](browser.md) is an optional add-on                                                                |
| **changing** the code    | _Development_: [toolchains, git hooks, tests, CI and releasing](development.md)                                                                                                                                                                                                       |
| looking something up     | _Reference_: the [wire protocol, upstream docs and the rest of the stack](reference.md)                                                                                                                                                                                               |

Every page opens with a one-line note saying who it is for.

## Upstream

Cerea began as a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)
(Apache-2.0), with its history intact, and is now mostly a hard fork.
`docs/source/` in the repository is **upstream's** documentation, kept as
upstream wrote it; parts of it do not apply to Cerea, and it is not part of
this site. The [NOTICE](https://github.com/paoloviviani/Cerea/blob/main/NOTICE)
records the attribution, and Cerea is licensed under the
[Apache License 2.0](https://github.com/paoloviviani/Cerea/blob/main/LICENSE).
