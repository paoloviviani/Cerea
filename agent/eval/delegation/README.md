# Delegation evaluation

Does a model pick the right way to hand work off, and does a handoff come back?
Ten prompts (`prompts.json`) on two or three real models:

- `spawn`: the person asks for a separate session, a second opinion or a handoff
  they want to talk to. The right choice is `session_spawn`; the round trip is
  complete when the spawner receives a message from that session and finishes a
  turn answering it (with report-back on, galopin delivers it; on code before
  ADR 0099 the model has to ask the child to `session_send` back).
- `task`: a quick helper inside the turn. Right is `task` (and no spawn).
- `no_spawn`: a question to answer directly. Right is anything but a spawn.

The harness is `agent/delegation_eval_it_test.go` (it needs galopin's internals,
so it lives in the package). It starts an **isolated** opencode and galopin
(own temp dirs, own ports, a fixture workspace), approves every card as the
person would, and counts model calls as assistant messages across all sessions
a run touched. It compiles against code with and without report-back, so the
same file measures a baseline.

## Running

The gateway key comes from an env file (default `~/.config/galopin-eval.env`,
mode 600) defining `EVAL_GATEWAY_KEY` and `EVAL_GATEWAY_BASE_URL`; it is passed
only through the environment into a config file inside a temp directory that is
deleted afterwards. Never put it on a command line.

    eval/delegation/run.sh after                       # this checkout
    eval/delegation/run.sh baseline /path/to/other/agent   # e.g. a worktree of origin/main

Knobs (environment): `EVAL_MODELS` (space separated, default
`deepseek-v4-flash-0731 glm-5.3`), `EVAL_MAX_CALLS` (total budget, split evenly
over the models; default 100), `EVAL_RUN_CALLS` (cap per prompt, default 8),
`EVAL_ONLY` (comma separated prompt ids), `EVAL_OUT` (results JSON).
Without `GALOPIN_DELEGATION_EVAL=1` (which `run.sh` sets) the test is skipped, so
a normal `go test` never spends a model call.

Results: a JSON file and a table per model and prompt (choice, right, round
trip, calls). A run is one sample per prompt, so a difference of one prompt is
noise; read the totals, not single rows.
