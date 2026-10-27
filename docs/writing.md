# Writing the interface

How the words in Cerea's interface are written. Read this before you add or
change any text a person sees: labels, buttons, toasts, error messages, empty
states, tooltips, `aria-label`s, page titles, settings descriptions. It is also
the brief for anyone extracting strings for translation: translate the
plain-language wording, not the technical term it replaced.

The owner's rule: _it should not be technical as much as possible._

## Who reads it

Everyone from a power user to someone who has never used a chat assistant. Write
for the second one and the first one still understands. A power user who needs
the exact term will find it on an admin page, in the docs, or in a tooltip that
adds it in brackets.

## Tone

- Plain, friendly, short. One idea per sentence. Say it the way you would say it
  to a colleague.
- Sentence case everywhere ("Add connector", not "Add Connector"). Titles of
  things people name themselves keep their own case.
- Say what happened and what to do next. "Could not save. Try again." beats
  "Request failed (500)."
- No blame ("You entered an invalid..."), no stack-speak, no status codes, no
  environment variable names on pages ordinary people see.
- Do not promise what the code does not do. If something is partial or has a
  catch, say so in the same breath, briefly.
- Prefer a verb on buttons ("Sign in", "Add", "Check"), the thing's name on
  headings.
- Admin pages may be more technical, but still clear: a variable name or a URL
  is fine there, a paragraph of jargon is not.

## Terms

| Technical term                                            | The interface says                                                         | Notes                                                                                                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP server                                                | connector                                                                  | Keep "MCP" only where an expert needs it: admin pages and the URL hint in the add-connector form ("the address of an MCP server").                                                                                      |
| Base server, `.env` server, "Provided by this deployment" | built-in connector                                                         | Group heading "Built-in connectors".                                                                                                                                                                                    |
| "from .env" pill                                          | "Set up by the administrator"                                              | Shown to administrators only. The admin page itself may say "Set in the .env file".                                                                                                                                     |
| deployment, instance, gateway, Pystino                    | "here", "this service", "your administrator"                               | Leave it out when the sentence still works. Never name the gateway product to ordinary people.                                                                                                                          |
| OAuth, authenticate, authorize                            | sign in                                                                    | "Sign in to this connector." Say "OAuth" only on admin pages and the advanced authentication choice, with "sign in" beside it.                                                                                          |
| token, API key, bearer, credential                        | "access key" / "password"                                                  | Only on pages that need one (add a connector with a key, push set-up), and explain where it comes from. "Tokens" as the model's length budget: say "length" or "words", never "tokens", outside the Code context meter. |
| health check                                              | Check                                                                      | The button and the result ("Working", "Not reachable").                                                                                                                                                                 |
| elicitation                                               | question                                                                   | "The assistant has a question."                                                                                                                                                                                         |
| tool call, tool                                           | "action" (what the assistant does), "tool" kept in the connector tool list | "Allow this action?" Tool names themselves are shown as they are.                                                                                                                                                       |
| artifact                                                  | file, or document                                                          | The panel is "Files". A card says what it is: "Document", "Diagram", "Web page", "Code". Keep "artifact" nowhere in the UI.                                                                                             |
| knowledge base                                            | knowledge base                                                             | Already plain. "Embedding model", "reindex", "OCR" stay on the admin page only; elsewhere "ready to search", "Update".                                                                                                  |
| system prompt                                             | instructions                                                               | "Custom instructions". The expert term is fine in the model editor's help line.                                                                                                                                         |
| context documents                                         | project files                                                              | Whole files the chat reads every time.                                                                                                                                                                                  |
| sandbox, Pyodide, WASM                                    | "in your browser"                                                          | "Runs safely in your browser."                                                                                                                                                                                          |
| skill                                                     | skill                                                                      | Already plain enough; describe it as "a saved way of doing something".                                                                                                                                                  |
| sub-agent, delegate                                       | helper                                                                     | "The assistant asked a helper to look into it." Admin pages keep "sub-agent".                                                                                                                                           |
| conversation                                              | chat                                                                       | "Conversation" survives only in "Delete conversation" style legal wording where the dialog already says chat; prefer "chat".                                                                                            |
| Workspace (the library page)                              | Workspace                                                                  | Connectors, skills, knowledge. Keep.                                                                                                                                                                                    |
| Code area: machine, device, daemon, enroll, pair          | kept                                                                       | The agent (Code) area is for power users and keeps its technical vocabulary. See "Kept terms" below.                                                                                                                    |
| Code area: workspace (a folder on a machine)              | kept                                                                       | Same reason.                                                                                                                                                                                                            |
| Code area: agent                                          | agent                                                                      | The product word in the sidebar ("Agents").                                                                                                                                                                             |
| Code area: session                                        | session                                                                    | Kept: it is what an agent's run is.                                                                                                                                                                                     |
| Code area: worktree, HEAD, branch                         | kept                                                                       | Git words for people who use git. Add a plain half-sentence.                                                                                                                                                            |
| Code area: posture, ceiling, policy                       | kept                                                                       | Same reason.                                                                                                                                                                                                            |
| error "The request failed (500)"                          | "Something went wrong. Try again."                                         | Keep the status code only in the console.                                                                                                                                                                               |

## Kept terms

The agent (Code) area, and the Local connectors page that goes with it, are
for power users. They keep their technical vocabulary on purpose:

- **local connector**: the tab, the section and the page name. Not "connector on
  your computer".
- **machine** and **pair** ("Pair a machine"), device, daemon, enroll,
  workspace (a folder on a machine), session, worktree, posture, ceiling,
  policy, galopin, opencode, subagent.

Plain-language work in that area is limited to clumsy phrasing and error
messages (what happened, what to do). Do not rename its terms.

## Errors

Pattern: what happened, then what to do. "Could not save the connector. Check
the address and try again." If you do not know what to do, say "Try again in a
moment." Do not show raw server text unless it is the only information there is,
and then put it after our sentence.

API error strings that tests or other code match on are not interface text:
change them only together with their matchers.
