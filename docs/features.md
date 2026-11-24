# Features

Everything Cerea does, in one list. The [home page](index.md) has the short version;
each item links to the page that explains it.

Unmarked features work against any endpoint; those marked _(Pystino)_ need
the gateway.

- **Chat over any model your endpoint serves**, signed in with OIDC. With
  Pystino each call carries the user's own token, so quotas and billing are
  theirs; without it, every call uses the one key you configure. The stack
  currently signs the chat and the console in against one provider; to combine
  several sources of users, federate them in your own IdP (Keycloak,
  Authentik and the like).
- **Web search** _(Pystino)_, run by the deployment's search backends through
  the gateway, with the backend chosen in Administration → Web search (the
  gateway can also meter provider-side search where a model offers it).
- **File upload and extraction**: PDFs, Office documents (old `.doc` too), images
  and text, read once at upload. With Pystino, extraction goes through the
  gateway and can stay inside your deployment; without it, PDFs and images
  go to an OCR endpoint you name (`CHAT_OCR_BASE_URL`). Scanned PDFs reach a
  model that sees images as page images.
- **Artifacts**: HTML, React and Mermaid previews in sandboxed frames with no
  network access, and generated files (see the next item).
- **Word, Excel, PowerPoint and PDF files**: the assistant creates and edits
  them through the bundled document service, saving each edit as a new version
  and leaving the original alone. Styling by asking, or from a template you
  upload; designed slides with backgrounds and shapes; native charts
  ([docs/office.md](office.md)).
- **Skills and connectors**: built-in skills for office files and data
  analysis ([docs/skills.md](skills.md)), and remote MCP servers as
  connectors ([docs/connectors.md](connectors.md)).
- **Knowledge bases and projects**, shareable with users or groups, with an
  optional project memory ([docs/knowledge.md](knowledge.md)).
- **Python the assistant runs**: by default in your browser, in a WebAssembly
  sandbox with the scientific and office libraries, so your files never leave
  your device ([docs/pyodide.md](pyodide.md)); or, when the operator
  turns it on, in a gVisor sandbox on the server with native packages and more
  memory ([docs/sandboxes.md](sandboxes.md)).
- **Share links**: a link to one artifact, for signed-in users or anyone, with an expiry
  and a band naming who shared it ([docs/artifacts.md](artifacts.md#sharing-an-artifact)).
- **Browser use**: the assistant does a task in a real browser on your own
  computer, with approval before anything that commits; no cloud browser
  ([docs/browser-use.md](browser-use.md)).
- **Large content as files**: a long paste or attachment is handed to the
  model as a file it can read in parts, and a connector's file result is kept
  as a file of the chat ([docs/chat.md](chat.md),
  [docs/connectors.md](connectors.md#files-a-connector-returns)).
- **One connector list** for the chat and your agents, with local connectors
  on your own computers ([docs/local-connectors.md](local-connectors.md)).
- **Self-hosted model servers** (vLLM, SGLang, llama.cpp) as gateway providers
  _(Pystino)_ ([Pystino docs](https://github.com/paoloviviani/Pystino/blob/main/docs/provider-catalogue.md#self-hosted-servers-vllm-sglang-llamacpp)).
- **Your own models and look**: a global system prompt and private custom
  models (a base model plus a prompt) under Workspace → Customize models, a
  searchable list of every chat at `/chats`, and accent and background palettes
  ([docs/chat.md](chat.md)).
- **The `/code` agents panel**: coding agents on your own machines through
  **galopin**, with a file explorer, scheduled actions (a prompt sent to a
  session on a timetable) and, off by default, a browser terminal. The file
  explorer uploads, downloads and zips files and folders; Claude Code runs
  over ACP, and `galopin service` keeps galopin running
  ([docs/agent-machines.md](agent-machines.md)). With
  Pystino the agents' model calls are metered like the chat's; without it
  they use opencode's own providers.
