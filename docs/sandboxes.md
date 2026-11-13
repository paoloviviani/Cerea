# Server sandboxes

!!! info "For administrators who want model-written code to run on the server"

    Server sandboxes run code in isolated containers on a host you control, instead of in
    the user's browser. They are **off by default**. This page is the operator's view: how
    to switch them on, what they cost, and what protects the host. The design is in
    ADR 0115.

!!! note "What runs on it today"

    The model's `execute_code` tool can run in a server sandbox (below). Python code blocks in the
    chat still run in the user's browser (Pyodide), whatever you set here. Hosted agent machines
    (a later phase) and the egress proxy they need are not built; a request for one is refused.

## Run `execute_code` on the server

Two settings, both off by default: the sandboxes themselves (`SANDBOX`, below) and where the
model's code runs (`CHAT_CODE_EXECUTION`).

```sh
./configure --sandbox local --code-execution server
docker compose up -d
```

`--code-execution browser|server|off` sets `CHAT_CODE_EXECUTION`. `server` needs `SANDBOX` to be
`local` or `remote`; with `SANDBOX=off`, or while the manager is not answering, the chat runs the
tool in the browser instead, **automatically**, and logs it (`[code-execution] ... code runs in the
person's browser`, once when it starts and again when it recovers). A call whose sandbox cannot be
leased is handed to the browser too, before any code has run. After the code has started there is
no fallback: a failure is reported as the run's error.

The model sees the same `execute_code` tool, with the same argument and the same result format.
What differs is the engine, which the tool's description says:

- **Preinstalled stack, no network.** Python 3.13 with numpy, pandas, scipy, scikit-learn,
  matplotlib, seaborn, sympy, Pillow, lxml, python-docx, openpyxl, XlsxWriter, python-pptx, pypdf and
  reportlab (the image `cerea-sandbox-python`, versions pinned in `sandbox/exec-image/requirements.txt`).
  Nothing can be installed or downloaded.
- **State lasts.** One sandbox per conversation: variables, imports and files stay between calls.
  The manager releases it after about twenty idle minutes (`SANDBOX_IDLE_SECONDS`); the next call
  makes a new one, and the result tells the model its earlier state is gone.
- **Files in.** The conversation's attachments are copied to `/mnt/data/<name>` on demand, by the same
  plan as the browser (same names, the extracted text beside each file as `<name>.md`, the same size
  caps). A file a privacy rule withheld is never copied: it is neither planned nor readable.
  Files the document tools produced are not copied yet.
- **Files out.** Files the code writes under `/mnt/output/` come back as the conversation's files and
  show as download cards, kept as long as any deliverable (`CHAT_FILE_RETENTION_DAYS`). At most 20 files
  and 8 MB each per run; a figure drawn with matplotlib is saved as `figure-N.png` for the model, as in the browser.
- **Rich output.** Results come back as text, like the browser's: a DataFrame prints as a table. (A
  full Jupyter kernel, with inline HTML tables and widgets, is not used: the exec daemon in the image,
  `sandbox/exec-image/execd.py`, is a small standard-library program that keeps one interpreter and
  returns `stdout`, `stderr`, the last value, the error and the files. It is the seam to swap if
  inline HTML is ever wanted.)
- **A run that cannot be stopped.** The daemon stops a run at its limit and replaces its interpreter
  (nothing survives, not even a changed module). A C call that holds the interpreter (a huge `sum(range(...))`)
  defeats the daemon's own timers, so the client in the sandbox gives up after the limit plus a grace and kills
  the daemon's process group; the chat then releases that sandbox, and the next call gets a fresh one and the
  model is told its state is gone.
- **Fallback is told.** When a call runs in the browser because a sandbox could not be leased (the limits below,
  or the manager down), the model's result says so. A scheduled run, which has no browser to fall back to,
  fails with an "unavailable" result instead.
- **Limits.** One run is stopped after the configured limit (`CHAT_CODE_RUN_TIMEOUT_SECONDS`, 60 s by
  default); a stopped run restarts the interpreter and the model is told. Memory, CPU, processes, workspace
  and the other limits are the sandbox's (see [Sizing](#sizing)); one sandbox is leased per conversation,
  so `SANDBOX_MAX_LEASES_PER_OWNER` is also the number of conversations a user can run code in at once.

**What users see.** The same code card as before: it shows "Running code" while the sandbox works (no
"keep this page open" hint, because nothing runs in their page), then the output and the file cards. A
turn does not need the page to stay open, and a scheduled run can use the tool.

The sandbox lease is kept in the chat process's memory. With several chat replicas, a conversation's
next call may land on another one, which leases a second sandbox; the first is released by the idle
timeout. Run a single replica, or accept the extra start-up.

## The switch

One setting, `SANDBOX`, in `.env`. `./configure` writes the rest.

| `SANDBOX`       | What runs                                                                 | You give                                                        |
| --------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `off` (default) | nothing                                                                   | nothing                                                         |
| `local`         | the manager and the socket proxy, in this compose (the `sandbox` profile) | nothing: `./configure` mints the token and fills in the address |
| `remote`        | nothing here; the manager runs on another host                            | its URL and token                                               |

```sh
./configure --sandbox local
./configure --sandbox remote --sandbox-url https://sandbox.example.org --sandbox-token-env SANDBOX_MANAGER_TOKEN
./configure --sandbox off
docker compose up -d
```

- `local` adds the `sandbox` profile to `COMPOSE_PROFILES`, sets
  `SANDBOX_MANAGER_URL=http://sandbox-manager:8080` and mints `SANDBOX_MANAGER_TOKEN`.
- `remote` removes the profile and stores the URL and token you give. The token comes from an
  environment variable, never from the command line (which other users can read).
- `off` removes the profile, the URL and the token.
- **`local` needs gVisor.** `./configure` asks Docker (`docker info`) whether the `runsc`
  runtime is registered. If it is not, it says so, leaves `SANDBOX=off` and carries on with the
  rest of your answers. It never changes the Docker daemon's configuration.

The chat reads `SANDBOX`, `SANDBOX_MANAGER_URL` and `SANDBOX_MANAGER_TOKEN`, and reaches the
manager by that address and token alone, never by assuming a service name. A mix of the three
(`SANDBOX=local` without a token, `SANDBOX=off` with a URL, the profile on while `remote`) is
reported as an error by `./configure --check` and as a warning in the chat's log at start; the
chat treats it as off. It is never half on. At start the chat logs one line: `[sandbox] off`, or
`[sandbox] manager healthy` with the runtime, or a warning that the configured manager does not
answer.

`CHAT_CODE_EXECUTION` stays a separate setting (above). With `SANDBOX=off` it is forced to the
browser.

## Install gVisor

On the host that will run the sandboxes (the chat host for `local`, the sandbox host for
`remote`). This restarts Docker, so plan it; the kit's scripts never do it for you.

```sh
# Install runsc from https://gvisor.dev/docs/user_guide/install/ (apt repository or release binary), then:
sudo runsc install        # registers the runtime in /etc/docker/daemon.json
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}'    # must list runsc
docker run --rm --runtime=runsc hello-world
```

Rootless Docker, Docker Desktop and some hosted container platforms do not support custom
runtimes; use a Linux host with the standard Docker Engine.

For development and tests only, `SANDBOX_RUNTIME=runc` with `SANDBOX_ALLOW_RUNC=true` runs the
sandboxes with the host's own kernel and no gVisor in between. The manager logs a warning at
every start. Never use it for real users.

## A separate sandbox host

Run the sandboxes on their own machine when they should not share a host with the chat: more
CPU, or a different trust zone. `kit/sandbox/` has a standalone compose with its own
`.env.example`.

```sh
# on the sandbox host
git clone https://github.com/paoloviviani/Cerea && cd Cerea/kit/sandbox     # or ./get-kit.sh
cp .env.example .env && chmod 600 .env
# set SANDBOX_MANAGER_TOKEN (openssl rand -hex 32) and, if needed, SANDBOX_BIND, SANDBOX_DOCKER_GID
docker compose up -d

# on the chat host
SANDBOX_MANAGER_TOKEN=... ./configure --sandbox remote --sandbox-url https://sandbox.example.org --sandbox-token-env SANDBOX_MANAGER_TOKEN
```

The manager listens on `SANDBOX_BIND:SANDBOX_PORT` (default `127.0.0.1:8080`). It has no TLS of
its own and the token is a bearer secret, so either put a TLS reverse proxy in front of it on
the same host:

```
sandbox.example.org {
    reverse_proxy 127.0.0.1:8080
}
```

or bind it to a private address (a VPN or LAN interface) and use `http://` there; `./configure`
notes plain http. Every call but `GET /v1/health` needs the token, in the kit and standalone alike.
The socket proxy never publishes a port.

## How the host is protected

- **The Docker socket is mounted by one service.** The socket proxy has it; the manager and
  the chat never do. The proxy allows only the calls the manager makes (create, start, remove,
  inspect, stats, exec, and pulling the one allow-listed image), refuses every other Docker
  endpoint, and on every call for a container checks that it carries the manager's labels
  (`cerea.sandbox=1` and this project's `cerea.sandbox.instance`). It also re-checks each
  create request, so even a buggy or compromised manager cannot ask for a privileged
  container, a host mount, a network, a capability, a root user, another image or another runtime.
- **The manager refuses to act on a container without the label.** It checks before every
  command, file transfer and removal. On start it removes the labelled containers a previous
  run left behind (and only this project's).
- **Each sandbox is its own container**: the `runsc` runtime, a non-root user, a read-only root
  file system, a small RAM-backed workspace, no host mounts, all capabilities dropped,
  `no-new-privileges`, no swap, memory, CPU and process limits, and **no network at all**.
- **A lease is its own container.** One lease cannot see another's files; a lease id is random,
  and the chat also sends the owner so a mismatched owner gets "no such lease". File paths are
  normalised under `/workspace`: `..` is refused, and a symlink out of the workspace is refused.
  Command output and file sizes are bounded; a command that outlives its time limit has its
  sandbox destroyed.
- **The manager and the socket proxy are boxed too**: read-only root, no capabilities, limits,
  on internal networks (`sandbox-docker` holds the manager and the proxy alone; `sandbox-api`
  the manager and the chat).
- **Audit log.** Every lease, command, file transfer, release and denial is one JSON line,
  with OCSF-style fields (`time`, `activity`, `status`, `actor`, `lease`, `owner`) on the
  manager's output and appended to `/var/lib/sandbox/audit.jsonl` (the `sandbox-audit` volume).
  It holds sizes, counts and a short hash of a command, never the command, a file name or any content.
- **No secret is ever put inside a sandbox.**
- **The chat reads the three `SANDBOX*` settings from its environment only**, never from the
  administration config store, so a saved setting cannot repoint it at another manager.

### The audit log grows

`/var/lib/sandbox/audit.jsonl` is append-only and the manager never rotates or trims it: a busy
deployment adds a line per call. Rotate it from the host, for example with `logrotate` on the
volume's path (`docker volume inspect <project>_sandbox-audit`) using `copytruncate`, or ship the manager's output (which carries the same lines, prefixed `audit `) to your log system. Keep what your policy requires before you delete anything.

## Sizing

Everything below is a variable in `.env` (see `.env.example`); an empty one means the default.

**Per sandbox**: a default, and a maximum a request may not pass (a request above the maximum is refused with
`limit_exceeds_maximum`, never silently reduced).

| Limit                                                            | Variable                        | Default | Maximum |
| ---------------------------------------------------------------- | ------------------------------- | ------- | ------- |
| Memory                                                           | `SANDBOX_EXEC_MEMORY_MB`        | 1024 MB | 2048 MB |
| CPUs                                                             | `SANDBOX_EXEC_CPUS`             | 1       | 2       |
| Processes                                                        | `SANDBOX_EXEC_PIDS`             | 256     | 1024    |
| Workspace (a RAM-backed tmpfs: it counts against memory)         | `SANDBOX_EXEC_WORKSPACE_MB`     | 256 MB  | 1024 MB |
| Wall time of one call                                            | `SANDBOX_EXEC_TIMEOUT_SECONDS`  | 30 s    | 300 s   |
| Output of one call (more is cut, the call is marked `truncated`) | `SANDBOX_EXEC_MAX_OUTPUT_BYTES` | 256 KiB | 1 MiB   |
| A file put or got                                                | `SANDBOX_MAX_FILE_BYTES`        | 8 MiB   |         |
| Idle before release                                              | `SANDBOX_IDLE_SECONDS`          | 20 min  | 60 min  |
| Lifetime, however busy                                           | `SANDBOX_MAX_LIFETIME_SECONDS`  | 4 h     |         |

(Each maximum has its own `SANDBOX_EXEC_MAX_*` variable.)

**Totals**:

| Limit                                                                             | Variable                       | Default                                                        |
| --------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------- |
| Concurrent sandboxes overall                                                      | `SANDBOX_MAX_LEASES`           | 8                                                              |
| Concurrent sandboxes per user                                                     | `SANDBOX_MAX_LEASES_PER_OWNER` | 3                                                              |
| Requests the manager handles at once (more get `503 busy`, before a body is read) | `SANDBOX_MAX_INFLIGHT`         | 16                                                             |
| File transfers in flight (a subset of the above)                                  | `SANDBOX_MAX_FILE_TRANSFERS`   | 4                                                              |
| Warm pool (pristine sandboxes kept ready)                                         | `SANDBOX_WARM_POOL_SIZE`       | 0 (reserved; the pool arrives with the `execute_code` backend) |

A request over a total gets `429 quota_exceeded`.

**The services**: the manager is capped at 512 MB, 0.5 CPU and 128 processes
(`SANDBOX_MANAGER_MEM_LIMIT`, `_CPUS`, `_PIDS`); the socket proxy at 128 MB, 0.25 CPU and 64
processes (`SANDBOX_PROXY_*`).

**Why the manager gets 512 MB.** It buffers what it moves: a call's output is held as bytes, as a
string, and again as JSON (a binary-looking byte can become six characters of JSON), and a file
transfer holds its file several times over. The worst case is about

```
64 MB + (SANDBOX_MAX_INFLIGHT - SANDBOX_MAX_FILE_TRANSFERS) x 15 x SANDBOX_EXEC_MAX_OUTPUT_BYTES_CAP
      + SANDBOX_MAX_FILE_TRANSFERS x 4 x SANDBOX_MAX_FILE_BYTES
```

With the defaults that is 64 + 12 x 15 MiB x 1 + 4 x 4 x 8 MiB = about 370 MB. Raise any of the
three caps and raise `SANDBOX_MANAGER_MEM_LIMIT` with it; lower them and you may lower it. A request
past `SANDBOX_MAX_INFLIGHT` is refused before its body is read, so the worst case is a ceiling, not a hope.

**What N concurrent sandboxes cost.** The limits are caps, not reservations: a sandbox that runs
a small script uses far less than its cap. Plan for the worst case, with the defaults:

| Concurrent sandboxes  | Memory cap (plus about 0.65 GB for the two services) | CPU cap |
| --------------------- | ---------------------------------------------------- | ------- |
| 1                     | 1 GB                                                 | 1       |
| 2                     | 2 GB                                                 | 2       |
| 4                     | 4 GB                                                 | 4       |
| 8 (the default total) | 8 GB                                                 | 8       |

gVisor adds some memory and start-up time per sandbox beyond the cap's own use; measure on your
host. The default total of 8 wants a host with 8 to 16 GB to spare; on a 4 to 8 GB host shared with the rest of the stack set `SANDBOX_MAX_LEASES` to 3 or 4. On a dedicated sandbox host, raise `SANDBOX_MAX_LEASES` to what the memory table allows, and keep
the per-user limit low enough that one user cannot take them all.
Since a sandbox lives only while a conversation uses it (and for about twenty idle minutes after), a
deployment of N users rarely needs N sandboxes at once.

**Quotas with `execute_code` on the server.** Each conversation that runs code holds one sandbox. A user
can run code in `SANDBOX_MAX_LEASES_PER_OWNER` conversations at once (default 3); the whole deployment in
`SANDBOX_MAX_LEASES` (default 8). A call that needs a new sandbox when a limit is reached is not refused:
it runs in the browser, and the model is told so in the result. Raise the limits with the RAM table above,
or lower `SANDBOX_IDLE_SECONDS` so idle sandboxes free their share sooner.

## The API (for the curious)

All calls but health send `Authorization: Bearer <token>` and **must** send `X-Sandbox-Owner`, the owner the lease was made for (on a create it must equal the `owner` in the body); a lease is only ever visible to its owner, so a leaked or guessed lease id is not enough. The
chat's typed client is `src/lib/server/sandbox/client.ts`.

| Call                                      |                                                                                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                          | no token; status, runtime, whether machines are enabled                                                                                                                                                 |
| `POST /v1/leases`                         | `{kind: "exec", owner, conversation?, limits?}` returns the lease; `kind: "machine"` is refused (`403 machines_disabled`; `501` when `SANDBOX_MACHINES_ENABLED=true`, as hosted machines are not built) |
| `GET /v1/leases/:id`                      | status, limits, usage                                                                                                                                                                                   |
| `DELETE /v1/leases/:id`                   | release                                                                                                                                                                                                 |
| `POST /v1/leases/:id/exec`                | `{cmd: [...]}` or `{command: "..."}`, plus `timeout_seconds`, `cwd`, `env`, `stdin`, `max_output_bytes`; returns `exit_code`, `stdout`, `stderr`, `truncated`, `timed_out`                              |
| `PUT` / `GET /v1/leases/:id/files/<path>` | raw bytes, under `/workspace`                                                                                                                                                                           |

## Troubleshooting

- **`./configure --sandbox local` says runsc is not registered.** Install it (above), or use a
  manager on another host with `--sandbox remote`.
- **The chat logs "the manager is configured but not reachable".** Check
  `docker compose ps sandbox-manager sandbox-socket-proxy` and the manager's logs; for `remote`, the URL,
  TLS and the token.
- **The manager logs `orphan sweep failed`.** The socket proxy was not ready or cannot read the
  Docker socket: check `SANDBOX_DOCKER_GID` against `stat -c %g /var/run/docker.sock`.
- **`503 sandbox_start_failed`.** Usually the runtime is not registered, or the image cannot be
  pulled by the Docker host. The audit log names the Docker error.

## Not built yet

The warm pool (the first call of a conversation pays for a start, a second or two with the image
already pulled; the first ever pays for the image pull) and staging files the document tools made;
hosted agent machines and the default-deny egress proxy they need (a later phase).
