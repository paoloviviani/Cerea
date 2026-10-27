# Cerea

Cerea is a self-hosted chat for any OpenAI-compatible endpoint, with
knowledge bases, artifacts, Python in the browser, and coding agents on your
own machines. It pairs with **Pystino**, a gateway for accounting, quotas and
redaction: each runs on its own, and together they are the intended setup.

!!! info "For everyone"

    Start here to find the section written for you.

![Cerea: a chat with a plan and two sub-agents](assets/cerea-chat-light-framed.webp#only-light)
![Cerea: a chat with a plan and two sub-agents](assets/cerea-chat-dark-framed.webp#only-dark)

_A chat where the assistant kept a plan and handed two lookups to sub-agents._

**The name.** _Cerea_ is a Turinese _modo di dire_: a historic, affectionate
greeting that means both _buongiorno_ and _arrivederci_.

## What you can do with it

| Feature                     | In short                                                                                                                                                                    | Read                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Chat**                    | Conversations over the models your gateway grants you, with web search, web fetch, memory, custom models and tool approvals                                                 | [Chat](chat.md)                                                               |
| **Artifacts**               | Documents, pages, tables and diagrams the assistant writes, opened and edited in a side pane                                                                                | [Artifacts](artifacts.md)                                                     |
| **Python in the browser**   | Code the assistant runs in a sandbox in your own tab, with your attachments mounted and files handed back                                                                   | [Python in the browser](pyodide.md)                                           |
| **Knowledge and projects**  | Knowledge bases searched at answer time, and projects that share instructions, documents and memory across chats                                                            | [Knowledge and projects](knowledge.md)                                        |
| **Connectors and skills**   | MCP servers the assistant can use, and `SKILL.md` instructions it loads when a task matches                                                                                 | [Connectors](connectors.md), [Skills](skills.md)                              |
| **Plans and sub-agents**    | A live plan for multi-step work, and sub-agents (including a research preset) that take on a sub-task in a fresh context                                                    | [Plans and sub-agents](chat.md#plans-and-sub-agents)                          |
| **Agents on your machines** | Coding agents that run on your own laptop under one small binary, driven from the chat with permissions you control; delegates, profiles and schedules                      | [Agent machines](agent-machines.md), [reference](agent-machines-reference.md) |
| **Notifications**           | A push to your phone or desktop when an agent needs you or a long run finishes, with the tab closed                                                                         | [Notifications](notifications.md)                                             |
| **Office files**            | The assistant creates and edits Word, Excel, PowerPoint and PDF files (native charts, designed slides, a new version per edit); Office files are previewed in the side pane | [Word, Excel, PowerPoint and PDF files](office.md)                            |
| **Voice**                   | Dictation into the message box using your browser's speech recognition, switched by an administrator                                                                        | [Dictation](chat.md#dictation), [Voice](chat-admin.md#voice)                  |

## How it pairs with Pystino

Cerea works with any OpenAI-compatible endpoint, and it is built to sit in front
of **Pystino**. Every model call the chat makes carries the signed-in person's own
token, so the gateway decides, per person and per group:

- **accounting**: each call is metered to the person and the billing group they
  chose, and the chat shows them their own figures;
- **quotas**: limits per person, group or deployment are enforced by the gateway,
  not by the chat;
- **routing**: which provider serves a model, and which models, search backends
  and document readers a person is offered at all;
- **the catalogue**: the model list the chat shows is the gateway's, per billing
  group, and capabilities such as vision, tools and reasoning come from it.

Coding agents on people's machines use the same credential, so their spend lands
in the same ledger. Users, groups, prices, quotas and redaction are managed in
Pystino's console, not in Cerea; see the [reference](reference.md) for its
documentation.

## The stack

Two repositories, each solving a different problem, with the deployment in
the first. This site documents the chat:

| Part               | What it is                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| **Cerea**          | this repository: the chat, and **galopin**, the agent that runs on a person's own machine (`agent/`)     |
| **Pystino**        | the gateway and its console: every model call, its accounting, quotas, redaction and access              |
| **The deploy kit** | the deployment (`kit/` here): one `compose.yaml`, a documented `.env.example` and a `./configure` script |

With Pystino, each call the chat makes carries the signed-in person's own
token, so quotas and billing are theirs; elsewhere on this site, "the gateway"
means Pystino. Pystino has its own documentation; this site links to it from the
[reference](reference.md) page rather than repeating it.

!!! tip "Three ways to run it"

    The whole stack from the deploy kit, the chat without the kit, or the
    chat without Pystino at all — each a supported path with a different
    feature set. [Deploying](deploy.md) lays them out side by side.

## Which section is yours

| If you are…              | Read                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **using** the chat       | _Using Cerea_: [Chat](chat.md), [Artifacts](artifacts.md), [Python in the browser](pyodide.md), [Skills](skills.md), [Knowledge and projects](knowledge.md), [Connectors](connectors.md), [Notifications](notifications.md), [Office files](office.md) and [Agent machines](agent-machines.md) for the coding agents you pair from your own laptop |
| **running** a deployment | _Operating Cerea_: [Deploying](deploy.md), [Configuration](configuration.md), [Administering the chat](chat-admin.md) and [The `/code` panel](code-panel.md); the [headless browser](browser.md) is an optional add-on                                                                                                                             |
| **changing** the code    | _Development_: [toolchains, git hooks, tests, CI and releasing](development.md)                                                                                                                                                                                                                                                                    |
| looking something up     | _Reference_: the [wire protocol, upstream docs and the rest of the stack](reference.md)                                                                                                                                                                                                                                                            |

Every page opens with a one-line note saying who it is for.

## Upstream

Cerea began as a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)
(Apache-2.0), with its history intact, and is now mostly a hard fork.
`docs/source/` in the repository is **upstream's** documentation, kept as
upstream wrote it; parts of it do not apply to Cerea, and it is not part of
this site. The [NOTICE](https://github.com/paoloviviani/Cerea/blob/main/NOTICE)
records the attribution, and Cerea is licensed under the
[Apache License 2.0](https://github.com/paoloviviani/Cerea/blob/main/LICENSE).
