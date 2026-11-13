# The sidebar, and signing out at both ends

**Two trees, then three rows, then the footer.** `components/nav/` holds the
pieces: `TreeBranch`, `TreeLeaf`, `RowMenu`, `ProjectsBranch` for the one
branch whose children are themselves folders, and `NavFooter` for the foot.

The split is the point, and it was arrived at by getting it wrong first: every
top-level entry was a branch, and a disclosure triangle revealing a list you
then clicked to open a dialog anyway was worse. Only **Projects and Chats**
have contents worth expanding. The rows at the foot are single addresses —
**Workspace** (the tabbed page hosting models, Custom models, memory,
knowledge bases, skills and memory), **Settings**, and **Admin** for administrators (gated on
`gatewayIsAdmin`, the gateway's answer, not the chat's own flag) — and the
**footer** is static: the user's tag and name, a theme switch, and a sign-out
button, all inline, with no popup. (Models, Knowledge and MCP Servers were
three more rows that each opened their own dialog; the workspace page absorbed
them, and `UserMenu` — whose popup carried Settings, Admin, the theme switch
and sign out — went with them.)

**Projects and Chats are pages as well as folders.** In each header the
**label is a link** (to `/projects`, the list of projects, and to `/chats`, the
searchable list of every chat) and **only the chevron expands or collapses** the
branch. They are two controls and two tab stops, never one button: the chevron
is its own button named "Expand Projects" / "Collapse Projects" (likewise
Chats) with `aria-expanded`, drawn at a 20px target but laid out as before.
`TreeBranch` does this when given an `href`; the folders inside a branch (a
project's own row) keep the single button, which is the file-tree idiom. The `+`
beside Projects is unchanged. Do not make the label toggle again "because every
tree does": the chevron is the toggle, and the label is where you go.

**The width is one variable.** The desktop sidebar is `--nav-width` (340px, in
`styles/main.css`): the layout's grid column, the collapse handle riding its
edge and the width pinned on the nav's children all read it, so they cannot
disagree. It was 260, then 300 because titles and the /code tree's nested rows
(flush machines and workspaces, indented sessions and subagents) were
unreadable once the
text grew by a pixel; 340 because at 300 a session row's state dot, badges and
⋯ menu still cut its title short, while the phone drawer (85% of a 390px
screen, ~330px) showed it whole. It means nothing below `md`, where the sidebar is the
drawer. Put no pixel width for the nav anywhere else.

Four rules:

- **a tree's contents load when it is opened**, never on page load. A project's
  chats load when _its_ folder opens, not with the project list — a dozen
  projects would otherwise be a dozen requests to draw a sidebar nobody
  expanded;
- **managing a project happens on its own row**, through the `⋯`: **Project
  settings** navigates to the project's page (`/projects/<id>`), Delete removes
  it after a confirmation that says what is _kept_ (the chats return to the
  ordinary list; the knowledge bases are gateway resources with their own
  owner). The `+` on the Projects header goes to `/projects/new` and is the only
  control there that is not about an existing project. There is no overlay and
  no nested Edit: the page tells the tree to reload through `projectsRevision`;
- **the list of all projects is a page, and the label opens it.** `/projects`
  (`ProjectsManager`, just that list, each card a link to the project's page)
  was once reachable only from a project page's back link, and the rule here
  said nothing in the sidebar opens it. That rule is reversed on purpose: the
  Projects label is the way to it, and still no overlay;
- **a project's chats live under the project, so the sidebar's Chats leaves
  them out.** That is what `projectId` on `ConvSidebar` is for; without it every
  project conversation appeared in both places. The `/chats` page is the
  opposite on purpose: it is the "find anything" list, so it includes them and
  marks each with its project.

**Recent** (`components/nav/RecentList.svelte`, `utils/recentItems.ts`) is the
third option of the Chats | Recent | Agents switch (`codeNav.view`, memory only
like the other two). It is one list of chats (project chats included, badge from
the projects the sidebar already reads) and agent sessions, newest first, built on
the client from stores that already exist: the layout's chat list (`lastActivityAt`,
kept live by the same watcher, so a new message moves a chat up) and the Agents
tree's cache (`codeTreeCache`, read through the proxy for paired machines that are online; a machine that has gone offline keeps its last sessions, shown dimmed).
There is **no endpoint and no server-side session store**: the machine owns its
sessions and `CodeAgent.ts` forbids a second agent store, so a server list would
either have to ask every machine or mirror them. A session's clock is its
`updatedAt` as the machine reports it. The window is `RECENT_WINDOW_MS` (48 h),
filled to `RECENT_MIN_ITEMS` (10) with older items; while more chat pages exist,
sessions older than the oldest loaded chat are held back so order never needs
correcting. Everything around the list (New chat, Schedules, the foot) is the Chats
mode's, shared; only the list differs. Users without agent access get the switch
without Agents and a chats-only list.

**`/chats` and its search** (`components/chats/ChatsList.svelte`). A search box
focused on open, rows of title, last updated (relative), model and the project
badge, newest first, more rows as the end scrolls into view. The filter is the
**server's**, as an optional `q` on `GET /api/v2/conversations` rather than a
new endpoint, because it is that same list with one more condition: the same
auth condition (the caller's own conversations, so their own project chats are
in and a colleague's chats in a shared project are not — those stay on the
project's page), the same sort, the same `p` paging and `hasMore`, the same
row shape, and no second route to keep in step. Three things about `q`:

- **case and accents are folded in the pattern**
  (`server/titleSearch.ts`), because MongoDB's `$regex` ignores collation: each
  letter becomes a class of its cased and accented forms plus any combining
  marks (so a title stored decomposed matches), and everything else is escaped,
  so `c++` and `(draft` are text. Latin only; a Greek or Cyrillic accent is
  matched as typed. Whitespace runs match any whitespace;
- **the length is capped** at `MAX_TITLE_QUERY_LENGTH` (100, in
  `constants/pagination.ts`; the box has the same `maxlength`) and the rest is
  ignored rather than refused;
- **the index is `{ userId, updatedAt, title }`**, which _replaces_ `{ userId,
updatedAt }` (`database.ts`). An unanchored folded regex cannot use an index
  for bounds, but with `title` as a trailing key Mongo tests it on the index
  entries and fetches only the matches: on 3,000 of one user's conversations
  with 24 KB of messages each, 2,959 documents fetched became 31 (and 0 for a
  search with no match). The old index has to be dropped, not kept beside it:
  with both, the planner keeps picking the narrower one and the search never
  gets the benefit. The list without `q` costs the same on either.

**Title only.** Searching message text is a different cost, not a bigger
version of this one. A regex over `messages.content` reads every message of
every conversation the person owns; a text index would hold every message of
every user and be rewritten on each turn, and it matches words and stems, not
the substrings a title search does. The sound way is the embedding/retrieval
pipeline the projects already have for "index past chats", which is per-project
and opt-in. It was left out on purpose.

**Signing out ends the session at both ends** (`routes/logout/+server.ts`), and
the second end is the one that was missing. `POST /logout` deleted the local
session and cleared the cookie correctly, then redirected to `/` — which re-ran
the OIDC flow, and the _provider's_ still-live session signed the person
straight back in with no prompt. From the outside, Sign out did nothing. It now
does RP-initiated logout: local session first (so a provider round trip that
never returns still leaves this app signed out), then the browser to the
`end_session_endpoint` with `id_token_hint` and back.

Three things that follow, all found by running it:

- **the id token is kept on the session** (`Session.oauth.idToken`) for exactly
  one purpose, `id_token_hint`. It was previously discarded;
- **Keycloak answers 400 for an unregistered `post_logout_redirect_uri`**, and
  `post.logout.redirect.uris = +` registers only the _login_ callback — not the
  app root the browser is sent back to. Register a wildcard under the
  published origin instead, which is safe only because the deployment serves
  one origin;
- **landing on a login prompt afterwards is the proof, not a fault.** The
  browser returns to `/chat/`, which is unauthenticated by then and bounces to
  the provider's login page.

A provider advertising no `end_session_endpoint` keeps the old behaviour
exactly: the local sign-out still happens, and `getOIDCLogoutUrl` returns
`null` rather than throwing.

One trap for anyone writing a check against the panel: matching a row by
`>Label<` fails for exactly the rows that carry a count badge, because the
label is then followed by whitespace and a `<span>`. Strip the tags and match
the text.
