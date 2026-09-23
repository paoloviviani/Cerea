# Chat UI

> **This directory is upstream chat-ui's documentation, carried in the fork.**
> It is kept close to upstream on purpose — the case for forking this project
> was that `git fetch upstream && git merge` keeps working — so read it as a
> description of chat-ui, not of this deployment. Where the two differ, the
> fork's own documents win: the [README](../../README.md) for what this fork
> adds and why, `.env` for the variables this deployment actually reads,
> [docs/code-panel.md](../code-panel.md) and
> [docs/agent-machines.md](../agent-machines.md) for the `/code` Agents panel,
> [docs/pyodide.md](../pyodide.md) for code execution, and
> [docs/browser.md](../browser.md) for URL fetching.
>
> The three differences most likely to mislead: this fork talks to a Pystino
> gateway rather than to a provider, so `OPENAI_BASE_URL` is the gateway's
> `/v1` and models arrive with capabilities and per-caller access; sign-in is
> **OIDC only** (`USE_USER_TOKEN=true` makes every inference call carry the
> signed-in person's own token, which is what gets them billed); and nothing
> HuggingChat-specific below applies.

Open source chat interface with support for tools, multimodal inputs, and intelligent routing across models. The app uses MongoDB and SvelteKit behind the scenes. Try the live version called [HuggingChat on hf.co/chat](https://huggingface.co/chat) or [setup your own instance](./installation/local).

Chat UI connects to any OpenAI-compatible API endpoint, making it work with:

- [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers)
- [Ollama](https://ollama.ai)
- [llama.cpp](https://github.com/ggerganov/llama.cpp)
- [OpenRouter](https://openrouter.ai)
- Any other OpenAI-compatible service

**[MCP Tools](./configuration/mcp-tools)**: Function calling via Model Context Protocol (MCP) servers

**[LLM Router](./configuration/llm-router)**: Intelligent routing to select the best model for each request

**[Multimodal](./configuration/overview)**: Image uploads on models that support vision

**[OpenID](./configuration/open-id)**: Optional user authentication via OpenID Connect

## Quickstart

**Step 1 - Create `.env.local`:**

```ini
OPENAI_BASE_URL=https://router.huggingface.co/v1
OPENAI_API_KEY=hf_************************
```

You can use any OpenAI-compatible endpoint:

| Provider     | `OPENAI_BASE_URL`                  | `OPENAI_API_KEY` |
| ------------ | ---------------------------------- | ---------------- |
| Hugging Face | `https://router.huggingface.co/v1` | `hf_xxx`         |
| Ollama       | `http://127.0.0.1:11434/v1`        | `ollama`         |
| llama.cpp    | `http://127.0.0.1:8080/v1`         | `sk-local`       |
| OpenRouter   | `https://openrouter.ai/api/v1`     | `sk-or-v1-xxx`   |

**Step 2 - Install and run:**

```bash
git clone https://github.com/huggingface/chat-ui
cd chat-ui
npm install
npm run dev -- --open
```

That's it! Chat UI will automatically discover available models from your endpoint.

> [!TIP]
> MongoDB is optional for development. When `MONGODB_URL` is not set, Chat UI uses an embedded database that persists to `./db`.

For production deployments, see the [installation guides](./installation/local).
