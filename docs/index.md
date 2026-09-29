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

| Part             | What it is                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| **Cerea**        | this repository: the chat, and **galopin**, the agent that runs on a person's own machine (`agent/`) |
| **Pystino**      | the gateway and its console: every model call, its accounting, quotas, redaction and sign-in         |
| **cerea-deploy** | the deployment: one `compose.yaml`, a documented `.env.example` and a `./configure` script           |

Each call the chat makes carries the signed-in person's own token, so quotas
and billing are theirs. Pystino has its own documentation site; this one links
to it from the Reference section rather than repeating it.

## Which section is yours

| If you are…              | Read                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| **using** the chat       | _Using Cerea_: Python in the browser, knowledge, the agent machines you pair  |
| **running** a deployment | _Operating Cerea_: the `/code` panel and, later, deployment and configuration |

Every page opens with a one-line note saying who it is for.

## Upstream

Cerea began as a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui)
(Apache-2.0), with its history intact, and is now mostly a hard fork.
`docs/source/` in the repository is **upstream's** documentation, kept as
upstream wrote it; parts of it do not apply to Cerea, and it is not part of
this site. The [NOTICE](https://github.com/paoloviviani/Cerea/blob/main/NOTICE)
records the attribution, and Cerea is licensed under the
[Apache License 2.0](https://github.com/paoloviviani/Cerea/blob/main/LICENSE).
