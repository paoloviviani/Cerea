## Privacy

> Last updated: Sep 23, 2026

This is **Cerea**, a self-hosted chat application. It is not HuggingChat, and
nothing here is operated by Hugging Face. What follows describes what the
_software_ does; the answers that depend on who runs it — retention periods,
who the administrators are, which models are configured — belong to whoever
deployed this instance. Ask them.

### Sign-in

Authentication is **OpenID Connect against this deployment's own identity
provider**. There is no third-party social login. Which provider that is, and
what it already knows about you, is the operator's answer.

If the deployment allows it, an unsigned session is also possible; its
conversations are keyed to a browser session rather than to an account, and
they are gone when that session is.

### What is stored, and where

Everything below stays inside the deployment. Nothing is sent to Hugging Face
or to any other third party unless the operator has explicitly configured one.

|                                                            | Where                                               |
| ---------------------------------------------------------- | --------------------------------------------------- |
| conversations, messages, attachments                       | this deployment's MongoDB                           |
| knowledge-base documents, their extracted text and vectors | this deployment's PostgreSQL                        |
| standing personal facts, if you opted in to user memory    | this deployment's MongoDB                           |
| your spend, and a record of each request                   | the gateway's ledger — see below                    |
| paired coding-agent machines                               | a name, a machine id and a public key. Nothing else |

You can delete any conversation at any time from the interface. Deleting a
conversation deletes its messages and attachments with it.

### Where prompts go

Prompts are sent to the **gateway** this deployment is configured against
(`OPENAI_BASE_URL`), and the gateway forwards them to whichever model provider
it has been configured with. That is the one hop that may leave the deployment,
and what is at the other end of it is the operator's configuration, not this
application's.

Two things the gateway does on the way:

- **Accounting.** Every request writes a row: who called, which model, token
  counts and cost. Those rows are what usage reports and quotas read. The row
  may also carry the assistant's reply text.
- **Redaction**, when the operator has enabled it. Detected personal data is
  replaced with a deterministic placeholder _before_ the prompt leaves the
  deployment, and restored in the answer you see — so the provider never
  receives it.

### What does not leave your browser

- **Code execution.** Model-written Python runs in your own browser in a
  WebAssembly sandbox with no network access. Nothing is uploaded, and the
  deployment spends no compute on it.
- **Coding agents**, if this deployment offers the `/code` panel. The agent
  runs on your own machine; the traffic between it and this server is encrypted
  end to end, and the relay in the middle sees only ciphertext. Your code, your
  working tree and the agent's session live on your machine and are not stored
  here.

### Reading a URL, and reading a document

- Pasting a URL makes **this deployment** fetch it — either directly or through
  a headless browser it runs itself, never through a third-party scraping
  service.
- Attaching a PDF or an Office document sends it to the gateway's extraction
  endpoint. The deployment's own extractor runs locally and the document goes
  nowhere; an operator who has configured an upstream OCR model instead has
  made a deliberate choice, and it is one worth asking about.

### Technical details

[![chat-ui](https://img.shields.io/github/stars/huggingface/chat-ui)](https://github.com/huggingface/chat-ui)

Cerea is a fork of [huggingface/chat-ui](https://github.com/huggingface/chat-ui),
merged with its history intact. Upstream's code is Apache-2.0; first-party
additions are EUPL-1.2.

The technical write-ups behind the statements above are in this repository:
`docs/pyodide.md` (the code sandbox), `docs/agent-machines.md` (coding agents),
`docs/browser.md` (URL fetching).
