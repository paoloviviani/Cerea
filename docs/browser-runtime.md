# The browser on your computer

!!! info "For users who want Cerea's browse tool to use a browser on their own computer"

    `galopin browser` sets up and manages the browser that Cerea's `browse` tool
    drives on a computer you control: your laptop, or a development server. For
    what the tool does and how approvals work, see [Browser use](browser-use.md);
    for local connectors in general, see [Local connectors](local-connectors.md).

The browser is a small program (the **browser runtime**) with a Chromium of its
own. galopin offers it to the chat as a [local connector](local-connectors.md)
named `cerea-browser`, so it travels over the link galopin already has: no port is
opened. It keeps its **own profile** on your computer, so you can sign in to a
site by hand once and the browse tool can use that session. Nothing is installed
system-wide, and nothing is sent anywhere by the runtime itself (it has no
telemetry).

## Set it up

You need Node.js 22.18 or newer (from [nodejs.org](https://nodejs.org) or your package
manager) and a computer that [runs galopin](agent-machines.md).

```sh
galopin browser setup     # once, and again after a galopin update
galopin browser enable    # offer it to Cerea
galopin browser status    # installed? offered? answering?
```

`setup` writes the runtime into `<config-dir>/galopin/browser/runtime`, installs
its npm dependency there (a pinned `playwright-core`, installed with `npm ci` from a lockfile that
carries the tarball's sha512, so that exact file is fetched or the install fails), starts the browser once to check
it works, and prints each step.

- **An installed Google Chrome is used when there is one**, and then no browser is
  downloaded at all. It runs with galopin's own profile, never your own Chrome profile
  (which is locked while Chrome runs and private to you).
- Only when there is no Chrome, or it will not start under the runtime, or you ask for it
  with `setup --bundled`, is Playwright's Chromium downloaded into
  `<config-dir>/galopin/browser/ms-playwright`.
- If an earlier setup downloaded Chromium and Chrome is now used, `setup` offers to remove
  the downloaded copy; `setup --prune` removes it without asking.
- `status` says which one is in use: "Google Chrome 142.0 (installed)" or "Chromium 158.0
  (bundled)".

`enable` adds the `cerea-browser` entry to your `mcp.json` (every other entry is
kept) and creates the profile in `<config-dir>/galopin/browser/profile`. The
window is **shown when the computer has a display**, so you can watch and sign in;
without one (a server) the browser runs headless. `--headed` and `--headless`
choose. `galopin run` picks the change up by itself.

`disable` removes the entry. The profile, with your logins, is kept unless you
add `--remove-profile`.

## Signing in to a site

Sign in once, by hand, in the profile's browser. With a window, `galopin browser
enable --headed` and start a browse task that opens the site's sign-in page;
sign in in the window. On a server, use a computer with a display for the first
sign-in and copy the profile directory, or run the browser there with remote
access of your own. The runtime never types your password: the browse tool does
not know it.

## Your own tabs, and keeping the last page

The browse task works in pages it opened itself. A tab you opened is never used unless
you approve it: the agent can list the open tabs (`tabs`) and ask to use one
(`use_tab`), which always raises an approval card (reason: your own tab). The tab is lent,
not taken: when the task ends it is let go and never closed.

When a task ends, Cerea can ask the runtime to **keep the last page open**
(`end_task` with `keep`). Only a page the task opened itself is kept (the `open` tool opens a page of its own with no task and returns the same kind of token, which is how Cerea's "Open browser" ties a page to a chat): **a tab you lent is
never kept**, it is released and stays yours. The runtime gives back a random token, and a
later task that presents it (`resume`) gets that page back with no new approval. If the
page was **moved since** (a different address, query included; a fragment alone does not
count), `resume` **refuses** with `page_changed`, gives back its title and address, and
the token is spent: Cerea then asks you to lend the tab (`use_tab`) or opens a new one.
Only a changed title still resumes, and says so. Without the token a kept page is just
one of your tabs. A token works once, for 24 hours, and only while the page is open; the
idle close never closes a kept page. When a task stops because the browser reached a site on
the administrator's deny list, Cerea closes the page instead of keeping it.

## Verification steps (CAPTCHAs)

The runtime recognises reCAPTCHA, hCaptcha, Cloudflare Turnstile and the common "verify
you are human" pages, says so in the snapshot (`challenge`), and **refuses any action on
the widget**, whatever approval comes with it: the user solves it, in the window. It does
not try to solve or avoid them. It also pauses a random 150 to 600 ms between actions and
batches (`--pace MIN-MAX`, or `--pace off`), as a person would.

## What the runtime refuses

The runtime is the second line of defence behind Cerea's approvals. It checks
every action itself:

- an action that **submits a form, spends, sends, deletes, publishes or signs,
  starts a download, or leaves the site** runs only with an approval that Cerea
  signed for exactly that action on exactly that page; an approval that is
  missing, expired, edited, for another action or already used is refused;
- it never opens an address that is not `http` or `https` (no `file:`, `javascript:`
  or `data:` pages), whatever was approved;
- it dismisses JavaScript dialogs (`confirm` answers no) and says so, and it does
  not open file pickers, so a page cannot hang a task;
- page text is handed to the model as content, with hidden and look-alike
  characters removed, never as instructions. A page can still say anything to
  the model: it cannot approve its own buttons.

Cerea gives the computer a **key** for these signatures the first time the browser
is used (over the same link, `browser.key`; see `agent/PROTOCOL.md` §10.7). galopin
keeps it in `<config-dir>/galopin/browser/key` (mode 0600) and the runtime reads
it from there; `disable` deletes it. An approval can be used once: the runtime remembers
the ones it has spent (until they expire) in `used-grants.json` in the same directory, so
a restart does not forget them, and it refuses an approval whose expiry is more than 15
minutes ahead of this computer's clock. The key is never shown, logged or put on a
command line.

## What the runtime cannot know

The facts the runtime reports about a control (is it a submit button, which form does it
belong to, where does its form send data, is it a download link) are read by a small script
that runs **in the page's own JavaScript world**, because that is where the page's elements
are. A hostile page can therefore lie about its own controls: make a submit button look
like a plain one, or the other way round. This lets a page deceive the runtime only about
that page: the runtime still judges the site the action runs on by the address the browser
is actually at, a link's target and a form's action are resolved by the browser, and
leaving the site, downloading and non-web addresses are decided from those, not from what
the page says about itself. A page can attack its own site and no other. When the
facts cannot be read at all (a page too busy to answer), the control is marked
`metaUnknown` and treated as a commit.

## One browser at a time

The runtime has one browser (one profile) per computer, and galopin allows one
channel to it at a time. Each browse task opens its own page, starting blank, and closes it
when the task ends (or after ten minutes without a call); a page you opened is never
used, and a page the task opened that leaves the site is reported, not followed. Two tasks at once
on one computer are refused by Cerea. If you also open the same profile in
another Chromium, the runtime says the profile is already in use.

## Watching and taking over

While a browse task runs, you can watch its page in the chat and take it over
(see "Live view and taking over" in the browser use page). On this computer that
means two things:

- The runtime streams the page's picture to Cerea through galopin whenever you
  are watching, and stops when you are not. Nothing is kept on the way.
- With a visible window (`galopin browser enable --headed`) a small bar shows
  over the page the agent is using, **Cerea is using this window · Take over**.
  Clicking it pauses the agent so you can use the window; **Hand back** in the
  same bar lets it continue. The runtime keeps the bar out of the page's tree and
  out of the agent's screenshots, and page scripts cannot click it.

The agent stays paused for as long as you hold the page; a task you leave
paused still ends after ten minutes with no activity, like any other.

## Sandbox

Chromium runs in its own sandbox when the computer allows it. Some systems
restrict the user namespaces the sandbox needs (Ubuntu 24.04 and containers do,
by default). `setup` notices, says so, and `enable` then starts Chromium without
its sandbox: pages the browser opens are then not isolated from your user account,
so use the browser for sites you trust, or lift the restriction and run `setup`
again.

## If something is off

| `galopin browser status` says         | What to do                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runtime: not installed`              | Run `galopin browser setup`.                                                                    |
| `playwright: ... (this galopin pins)` | galopin was updated: run `galopin browser setup` again.                                         |
| `registered: no`                      | Run `galopin browser enable`.                                                                   |
| `key: not fetched yet`                | Normal until the browser is first used. It needs `galopin run` and a Cerea with browser use on. |
| `responding: no: ...`                 | The reason follows; `galopin connectors test cerea-browser` shows the runtime's own message.    |

The runtime can also run by hand: `node <config-dir>/galopin/browser/runtime/cerea-browser.mjs
--profile DIR --headless` speaks MCP over stdio, or over Streamable HTTP on
loopback with `--http PORT --token TOKEN`. `--help` lists the options.
