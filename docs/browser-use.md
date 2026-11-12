# Browser use

!!! info "For operators"

    Browser use is off by default. Turning it on is an administrator decision
    (Administration, Assistant, Browser use). The runtime that drives the
    browser is not part of this release: it is coming with `galopin browser`.

With browser use, the assistant can do a task in a real browser on one of your
own machines, signed in as you are: search and filter, fill in forms, page
through results, read what a page shows and download files. You ask for the
outcome in the chat; a browsing agent does the clicking and reports back.

This is different from the [headless browser](browser.md), which only reads one
page at a given address. Browser use _acts_.

## What users see

- **One card in the chat.** A collapsible **Browsing** card streams each step
  as it happens: the action ("Click 'Search' on shop.example.com"), the page it
  ran on and a short outcome. The card is open while it works and closes when
  it is done. Its report is what the assistant reads, and the chat does not fill
  with a message per click.
- **You are asked before anything that commits.** An approval card appears
  right after the browsing card with a plain sentence ("Click 'Pay €120' on
  shop.example.com"), the site, why you are asked and, when the browser could
  take one, a picture of the element. **Allow this action** lets that one
  action run. **Deny** tells the browsing agent it was refused; it must choose
  another path or stop, and it is told not to get the same result another way.
  There is no "allow for the whole conversation": every commit asks.
- **Downloads go into the conversation** as files, like an attachment. Files a
  privacy rule withholds stay withheld: they are reported as withheld and no
  tool can read them.
- **Stop works.** Stopping the turn stops the browsing agent, and the card shows
  that you stopped it.

### What asks

Each action is sorted into one of three classes before it runs:

| Class      | Examples                                                                                                                                                                                                                                                 | What happens |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Read**   | Scrolling, waiting, opening a page on the same site, following a link on the site, submitting a search form that only fetches                                                                                                                            | Runs         |
| **Input**  | Typing into a field, choosing an option                                                                                                                                                                                                                  | Runs         |
| **Commit** | Submitting a form, a button that means pay, buy, order, send, delete, remove, confirm, publish or sign (in English, Italian, Spanish, French and German: "Paga", "Invia", "Elimina", "Conferma", "Acquista"), starting a download, going to another site | **Asks you** |

When Cerea cannot tell what an element does, it asks. The names are matched
broadly on purpose: a "Remove filter" button asks too. Commits ask even when
your other tools are set to always allow.

The browser itself also refuses a commit that has no approval from Cerea for
that exact action (defence in depth), so a mistake on one side does not let an
action through.

## What it needs

- The deployment switch on, and [local connectors](local-connectors.md) on.
- A machine of yours that is online and runs the browser runtime. The runtime
  appears on a machine as a server named `cerea-browser`. It is **not** listed
  among your connectors and cannot be picked in the composer: only `browse` uses it.
- `browse` is offered to the assistant only when such a machine is online. With
  several, the assistant names the machine; otherwise the first one is used.
  One task runs at a time on a machine.

How to enable the runtime on a machine: coming with `galopin browser`. Until it
ships, the setting can be turned on but no machine offers a browser, so `browse`
is never offered.

## Settings (operators)

Administration, Assistant, **Browser use**. With `ENABLE_CONFIG_MANAGER` off,
set the variables instead (a saved value overrides the variable).

| Setting                       | Variable                   | Default                  | Meaning                                                                         |
| ----------------------------- | -------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| Allow browser use             | `CHAT_BROWSER_ENABLED`     | off                      | The `browse` tool exists. Only exactly `true` turns it on.                      |
| Browser model                 | `CHAT_BROWSER_MODEL`       | the chat's own model     | The model the browsing agent runs on, called with the user's own token.         |
| Steps                         | `CHAT_BROWSER_MAX_STEPS`   | 25 (1 to 100)            | Model rounds one task may take.                                                 |
| Tokens                        | `CHAT_BROWSER_MAX_TOKENS`  | 200000 (5000 to 2000000) | Tokens one task may spend, all requests summed.                                 |
| Seconds                       | `CHAT_BROWSER_MAX_SECONDS` | 300 (10 to 3600)         | Wall time. The time spent waiting for an approval does not count.               |
| Sites that need no approval   | `CHAT_BROWSER_SITES_ALLOW` | none                     | Hosts where commit actions run without asking. One per line or comma-separated. |
| Sites the browser may not use | `CHAT_BROWSER_SITES_DENY`  | none                     | Hosts the browser refuses to open or act on.                                    |

A task that reaches a budget stops and returns what it has, with a
`stopped_reason` (`max_steps`, `max_tokens`, `max_time`) and a note on the card.

Site entries are a host (`shop.example.com`), a wildcard (`*.example.com`) or a
bare domain (`example.com`, which covers its subdomains). The deny list wins
over the allow list. An allow-listed site covers commits on it, not a commit
that leaves for another site.

### Cost and safety

- The browsing agent makes its own model calls, billed to the user like any
  message, through the gateway with their token, so quotas, redaction and the
  privacy pipelines apply as usual.
- It has only the browser's tools: no connectors, files or email.
- Text from a page is marked as untrusted in its prompt. A page that tries to
  give it instructions is reported, not obeyed.
- A scheduled run has nobody to ask, so a commit there is refused unless the
  site is on the allowed list.
- Browser use acts with the user's logged-in sessions on their machine: leave the
  deny list for sites where that is never wanted (a bank, an admin console).

### Limits of this release

- An approval waits inside the running turn. If the chat restarts while one is
  open, the task ends and the card shows it as expired.
- The runtime, `galopin browser`, live view and taking over the browser, and
  replaying known tasks are not part of this release.

## For developers

The runtime contract (six MCP tools: `snapshot`, `diff`, `act`, `extract`,
`screenshot`, `download`) is in `src/lib/server/browser/contract.ts`, with a fake
runtime for tests in `fakeRuntime.ts`. The design is ADR 0116.
