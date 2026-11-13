# Browser use

!!! info "For operators"

    Browser use is off by default. Turning it on is an administrator decision
    (Administration, Assistant, Browser use). The browser itself runs on a user's
    own computer, set up with `galopin browser setup` and `galopin browser enable`
    ("The browser on your computer").

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
  once. Only files that these produced are kept: an action you approved, the
  start address the chat asked the browser to open, and a site the administrator
  trusts (the allowed list); a file a page started by itself is dropped and said so. Files a privacy rule withholds stay
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
- `browse` is offered to the assistant only when such a machine is online. Which one is used
  is decided by rules ("Which computer"), not by the assistant.
  One task runs at a time on a machine; this is enforced in the database, so it
  holds across servers and restarts, and a task that dies frees the machine within
  a minute.

To enable the runtime on a machine, install galopin there and run
`galopin browser setup` (Node.js 22.18 or newer; it installs the runtime and a
Chromium of its own into galopin's directory) and `galopin browser enable`, then
keep `galopin run` going. See "The browser on your computer"
and, for users who have no agents, "For users without agents" below. Until a
machine offers a browser, `browse` is never offered.

### Your own tabs

The browser may hold pages you opened yourself. When the goal refers to the page
you are on ("this site", "the current tab"), the browsing agent lists the open
pages and **sees their titles and addresses, without the query string**, never
their content. To work in one it must ask you first: "Let Cerea use your tab
..." is an approval like any commit, bound to that tab, its address and its title
(a tab that changed while you decided is refused), and no allowed-sites list
covers it. A tab on a site of the deny list is not listed at all. Once a task works in one of your
tabs it stays on that page and its site: going to another site is refused unless the goal names it
(and it then asks as for any new site), and the same tab is never asked about twice. If the goal
cannot be done on that page, the task stops and says why.

**A tab you allow stays lent to that chat.** Later requests in the **same conversation** continue
in it without asking again, as long as the tab is still open and still on the **same address host**
(scheme, host and port as when you approved it; the page, path and query may change, for example to
the next step of a form, but a different host, even of the same site, asks again). The lend lapses
after an hour without a task using it, 8 hours after you approved it at the latest (chained tasks
cannot extend it), when the tab is closed, or when the tab leaves that host (it is then released with
nothing remembered). A tab with no web address (a blank page) is never lent. Scheduled runs never
continue in a lent tab, and a tab on a site your rules now deny is not resumed. While a tab of yours
is in use, the model sees its address without query or fragment. Cerea never closes it, whether a
task ends or goes idle. In another conversation it is just one of your tabs, and using it asks you
first.

When the goal says "my tab" or "the page I'm on", the agent lists the tabs first and never opens a
new tab for it. A start address (or a navigation) that is already open in one of your tabs, at the
same origin and path, is not opened a second time: the agent asks to use that tab instead.

The browser itself does not emulate a window size: in a window you can see, pages use its real
size, so a tab of yours is never resized. Only a browser with no window uses a default size
(1280 by 800).

### Live view and taking over

While a task runs on a computer, the Browsing card shows a small **Live view**
of its page. Click it to enlarge it to the whole screen, which also works on a
phone. Only you, the owner of the chat, can watch it. The picture is sent only
when the page changes, nothing is kept, and it stops as soon as you close the
view, the task ends or the computer is taken by another task.

**Take over** pauses the browsing agent: it reads nothing, does nothing, and the
time you spend does not count toward its time budget. What you do in the live
view (click, tap, scroll, type, use the phone keyboard) happens on the page as if
you were at the computer, and is yours: it is not asked about or approved. **Hand
back** lets the agent continue from a fresh look at the page as you leave it.
Anything it does after that that commits still asks you first.

If the computer shows the browser window, the runtime puts a small bar over the
page the agent is using: **Cerea is using this window · Take over**. Clicking it
pauses the agent the same way, so you can act in the window itself, and the bar
then offers **Hand back**. The bar is not part of the page: the agent never sees
it in a snapshot or a screenshot, and a page cannot click it or read it.

A scheduled run can be watched but not taken over: nobody is there to hand it
back. If the computer's galopin is older than this feature, the card shows no live
view; update galopin there.

### Verifications

A verification (a captcha or a bot check) is never solved by the model. The task
pauses, a card (also in the Needs you bar and as a push) says "A verification
appeared in the browser on <machine>. Solve it in the window, then tap Continue.",
and the task goes on from a fresh look at the page. The wait does not count toward
the time budget. Stopping, or a scheduled run with nobody to ask, ends the task.

### The page stays open

When a task ends, its last page stays open in the browser, and the card says
"Left open: <title>". The next `browse` in the **same conversation** continues
on that page; in another conversation it is just one of your tabs (adopting it
needs your approval). If the page changed in the meantime, or has been closed, the
next task starts on a new tab instead and says so. A tab of yours that a task
used is kept the same way, as a tab lent to the chat (see "Your own tabs"): it
continues while it stays on the same address host, for an hour after the last use (8 hours at most). A task
that stopped on a site of the deny list closes its page.

A task opens no page of its own until it needs one: looking at the tab list, or
using one of your tabs, never leaves a blank tab behind, and a blank page a task
made but never used is closed when it ends. **Open browser** reuses a blank tab
if one is open instead of adding another.

### Opening the browser yourself

You can open a page in the browser on one of your computers without asking for a task:

- **In a chat:** **+ menu, Open browser…**. It takes an optional address (a bare `example.com` is
  opened over https; only http and https are opened) and, when several computers are ready, asks
  which one. The page opens there and is **tied to this chat**, exactly like the page a task leaves
  open: the next browsing task in the chat continues on it, with no approval to use the tab. You
  see "Opened on <computer>". The item is shown only when browser use is on and at least one of
  your computers has its browser ready. On the home page, where no chat exists yet, the page opens
  as one of your own tabs. Opening a page from a chat on another computer moves the chat there.
- **In Workspace, Connectors:** each computer's card has **Open browser** beside "Browser:
  ready". That page is tied to no chat: for the assistant it is one of your tabs, and using it
  asks you first, as it does for any tab you opened.

Opening is refused while a browsing task is using that computer's browser ("busy": try again when
it finishes), for a site on the deny list, and for any address that is not http or https. The
assistant can also open the browser for you when you only ask to open it.

### Which computer

Several of your computers can have a browser. Cerea decides which one by these rules, in order; the
assistant never chooses:

1. **The chat's computer.** Once a chat has used a computer (a task ran there, or you opened a page
   from the chat), it always uses that one. It never jumps to another.
2. **Your default.** On a computer's card in Connectors, **Use for browsing by default**. There is
   one default per user; it is cleared when that computer is removed.
3. **The only one.** With one computer ready, it is used and nothing is asked.
4. **Otherwise you are asked.** A **Which computer?** card lists the ready computers, with
   **Remember as default** ticked. It appears in the chat and in the **Needs you** bar, so a chat
   running on its own waits for your answer there. A scheduled run with nobody to ask stops and
   says so.

If the computer the rules point at (the chat's or your default) is offline or its browser is not
ready, the task stops with "<computer> is offline." and does not move to another one. The
`machine` the assistant may name is only a hint: it counts only when it is the exact name of one of your
ready computers, your latest message names that computer, and nothing above decides (never in a
scheduled run). If the assistant wants to open a different site than the page the chat already has
open, you are asked first.

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
keeps the long form with explicit flags under "Using an older galopin?". The computer needs Node.js 22.18 or newer. A user
who **already has galopin for agents** skips the install and the enrol: `browser
setup` and `browser enable` are enough, and the same `galopin run` serves the
browser. The per-computer approval key is handed over on the same link
(`browser.key`), which a connectors-only computer can use like any other.

### Node.js for the browser

The browser needs **Node.js 22.18 or newer** on that computer (not needed for connectors
alone). Get it from [nodejs.org/en/download](https://nodejs.org/en/download) (pick the LTS),
or on macOS with `brew install node`. Check it with `node --version`. The upcoming macOS
"Cerea connector" app bundles Node, so app users do not need this.

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
- Taking over is sent as a stream of pictures (a dozen a second at most), good
  for clicking and typing; a smoother video stream for longer sessions, marking
  an area to tell the agent about, and replaying known tasks are not part of this
  release.

## For developers

The runtime contract (MCP tools: `snapshot`, `diff`, `act`, `extract`,
`screenshot`, `download`, `tabs`, `open`, `resume`, `end_task`; and for the live view
`control`, `screencast`, `input`, which only the live-view routes call) is in
`src/lib/server/browser/contract.ts`, with a fake
runtime for tests in `fakeRuntime.ts`. The design is ADR 0116.

### The live view's path (phase 2a)

The runtime casts the active page with CDP `Page.startScreencast` (JPEG, on
repaint, acked) and sends each frame as an MCP notification
`notifications/cerea/frame` over its stdio channel. galopin turns it into a
binary link frame (kind `0x04`, PROTOCOL.md §9.2) on the stream lane, so no
base64 crosses the link. Cerea routes the frames by device to the task's
viewers (`liveView.ts`) and sends them to the browser as Server-Sent Events from
`GET /api/v2/browse/live/<task>`; input and takeover are `POST`s to `.../input`
and `.../control`. The routes answer only the owner of a running task (anything
else is a 404), input is rate limited, and no frame is stored or logged. Pausing
is in the runtime (every agent tool answers `paused`) and mirrored by
`takeover.ts` for the loop, which waits and then looks at the page again.
