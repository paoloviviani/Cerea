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
  shop.example.com"), the site, the page address, why you are asked and, when the
  browser could take one, a picture of the element. **Allow this action** lets that one
  action run. **Deny** tells the browsing agent it was refused; it must choose
  another path or stop, and it is told not to get the same result another way.
  There is no "allow for the whole conversation": every commit asks.
- **Approvals reach you wherever you are.** An ask also appears in the **Needs
  you** bar (the same one agent asks use, on every page, on a phone too) and sends
  the usual push notification ("Permission" events in your notification settings),
  so you can answer from your phone with the chat closed.
- **Downloads go into the conversation** as files, like an attachment, stored
  once. Only files that an action you approved produced are kept; a file a page
  started by itself is dropped and said so. Files a privacy rule withholds stay
  withheld: they are listed, reported as withheld, and no tool can read them.
  Audio downloads are not transcribed.
- **Stop works.** Stopping the turn stops the browsing agent, and the card shows
  that you stopped it.

### What asks

Each action is sorted into one of three classes before it runs:

| Class      | Examples                                                                                                                                                                                                                                                 | What happens |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Read**   | Scrolling, waiting, opening a page on the same site, following a link on the site, submitting a search form that only fetches                                                                                                                            | Runs         |
| **Input**  | Typing into a field, choosing an option                                                                                                                                                                                                                  | Runs         |
| **Commit** | Submitting a form, a button that means pay, buy, order, send, delete, remove, confirm, publish or sign (in English, Italian, Spanish, French and German: "Paga", "Invia", "Elimina", "Conferma", "Acquista"), starting a download, going to another site | **Asks you** |

Every click target's name is checked, whatever its kind (a plain `div` named
"Delete" is still Delete), and the verbs include save, apply, accept, approve,
share, reply, upload, cancel, unsubscribe and deactivate (salva, applica,
accetta, approva, condividi, rispondi, carica, annulla, disiscriviti, disattiva).
Pressing Enter or Space with no known target, or Control or Meta with Enter, asks.
A form that posts to another site asks, even a search box. A button whose name
cannot be read (empty, or not in a script Cerea reads) asks. Addresses that are
not web pages (`javascript:`, `file:`, `data:`, `blob:`) are always refused, never
asked about. When Cerea cannot tell what an element does, it asks. The names are
matched broadly on purpose: a "Remove filter" button asks too. Commits ask even
when your other tools are set to always allow.

A blank page is no way around this: opening `about:blank` is refused, and from a page
with no site every move is judged against the last real site of the task (only the
task's own first move to its start address is exempt). Enter or Space on anything
that is not a place to type counts as a click on it. Typed text may not contain line
breaks (Enter is a separate key press, which is classified).

Each action is classified on the page it will run on: a batch is run one action
at a time, with a fresh look at the page in between.

The browser itself also refuses a commit that has no approval from Cerea for
that exact action (defence in depth). An approval is a signed grant: it names the
action, the page address (without the `#` part) and the element's name, is signed
with a key that belongs to that machine, and expires 10 minutes after you allow
it. Allow-listed sites get signed grants too.

## What it needs

- The deployment switch on, [local connectors](local-connectors.md) on, and
  `CHAT_SECRET_KEY` set (it seals the per-machine key that signs approvals; without
  it nothing is offered).
- A machine of yours that is online and runs the browser runtime. The runtime
  appears on a machine as a server named `cerea-browser`. It is **not** listed
  among your connectors and cannot be picked in the composer: only `browse` uses it.
- `browse` is offered to the assistant only when such a machine is online. With
  several, the assistant names the machine; otherwise the first one is used.
  One task runs at a time on a machine; this is enforced in the database, so it
  holds across servers and restarts, and a task that dies frees the machine within
  a minute.

How to enable the runtime on a machine: coming with `galopin browser`. Until it
ships, the setting can be turned on but no machine offers a browser, so `browse`
is never offered.

## For users without agents

Browser use needs only [local connectors](local-connectors.md), not coding agents.
A user whose groups may use local connectors but not agents can set up a
browser on their own computer:

1. Open Workspace, Connectors. The **Use the browser on your computer** card
   shows the commands for this deployment (it appears when browser use is on and
   local connectors are allowed for the user). Copy them in order:
   install galopin, enroll it with `--connectors-only`, set up and enable the browser, run galopin.
2. Approve the computer under **On your computers** (sign in to Cerea once in the
   browser first). The card then shows the computer's browser as ready, offline
   or not ready.

```sh
curl -fsSL 'https://cerea.example.org/galopin/install.sh' | sh
~/.local/bin/galopin enroll --connectors-only --cerea 'https://cerea.example.org'
~/.local/bin/galopin browser setup
~/.local/bin/galopin browser enable
~/.local/bin/galopin run
```

`galopin enroll --cerea <address>` asks the chat for its sign-in settings (the
issuer and the client id, public facts), so only the address is needed; the card
prints the explicit flags too. The computer needs Node.js 22.18 or newer. A user
who **already has galopin for agents** skips the install and the enrol: `browser
setup` and `browser enable` are enough, and the same `galopin run` serves the
browser. The per-computer approval key is handed over on the same link
(`browser.key`), which a connectors-only computer can use like any other.

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

If the user's answer comes after the page changed, the browser looks again first and
runs nothing that is no longer what was approved. A task that loses its hold on the
machine's browser (another task took over) stops with `lease_lost`.

A task that reaches a budget stops and returns what it has, with a
`stopped_reason` (`max_steps`, `max_tokens`, `max_time`) and a note on the card.

Site entries are a host (`shop.example.com`), a wildcard (`*.example.com`) or a
bare domain (`example.com`, which covers its subdomains). A public suffix such as
`com` or `co.uk` is refused, because it would cover unrelated sites. Sites are
told apart by the public suffix list, so two users' pages on a shared host such as
`github.io` are different sites; an IP address matches only itself. The deny list
wins over the allow list, and a task that ends up on a denied site, however it got
there, stops at once. An allow-listed site covers commits on it, not a commit that
leaves for another site.

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
