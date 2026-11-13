"""cerea-execd: the exec daemon of the Cerea code sandbox (ADR 0115, class E).

A small, dependency-free (standard library) Python server that runs a conversation's code in ONE
long-lived interpreter, so variables, imports and open DataFrames survive from one `execute_code`
call to the next for as long as the sandbox lease lives. It is deliberately not a Jupyter kernel:
the chat needs `stdout`, `stderr`, the last expression's value, an error traceback, the files the
code wrote to /mnt/output and nothing else, and a kernel would add a messaging protocol, several
processes and a dozen packages for none of it. If rich MIME outputs (inline HTML tables, widgets)
are ever wanted, this is the seam to swap for ipykernel: the client script (run.py) and the
reply shape would stay.

The reply mirrors what the browser's Pyodide worker returns, so the chat's renderers and the
model's tool result are the same whichever engine ran the code:

    {"ok": bool, "stdout": str, "stderr": str, "result": str | null, "error": str | null,
     "files": [{"path": "/mnt/output/x.png", "size": 123}], "timeout": {...} | null}

Matplotlib figures become PNG files in /mnt/output (figure-1.png, ...) by the same module the
browser uses (src/lib/utils/execution/figures.ts); the chat sends its source with the first
request, so there is one copy of that code. A DataFrame prints and returns as text, as it does in
Pyodide.

One request at a time. A run past its time limit is stopped and the INTERPRETER IS REPLACED
(`os.execv`, so modules, threads, the working directory and the environment do not survive either):
the same "the sandbox restarted" contract as Pyodide, which the model is told. SIGALRM stops
Python-level code, a watchdog thread catches what SIGALRM could not, and for a C call that holds the
GIL (`sum(range(10**13))`) neither can run: the client, run.py, then kills the daemon's process
group, and the chat releases the sandbox.

Protocol: newline-delimited JSON over a unix socket (/tmp/execd.sock). Request:
    {"code": str, "timeout": seconds, "figures": str | null}
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import re
import signal
import socket
import sys
import threading
import traceback
import types

SOCKET = os.environ.get("EXECD_SOCKET", "/tmp/execd.sock")
PIDFILE = os.environ.get("EXECD_PIDFILE", "/tmp/execd.pid")
OUTPUT_ROOT = os.environ.get("EXECD_OUTPUT_ROOT", "/mnt/output")
MOUNT_ROOT = os.environ.get("EXECD_MOUNT_ROOT", "/mnt/data")
CWD = os.environ.get("EXECD_CWD", "/workspace")
#: The same bounds as the browser runtime (src/lib/utils/execution/protocol.ts).
MAX_OUTPUT_CHARS = 8000
MAX_LISTED_FILES = 200
MAX_REQUEST_BYTES = 8 * 1024 * 1024
WATCHDOG_GRACE_SECONDS = 5
_MATPLOTLIB_MENTION = re.compile(r"\b(matplotlib|pylab|seaborn)\b")


class RunTimeout(BaseException):
    """Raised in the run by SIGALRM. A BaseException so a bare `except Exception` cannot eat it."""


def clamp(text: str) -> str:
    suffix = "… [output truncated]"
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[: max(0, MAX_OUTPUT_CHARS - len(suffix))] + suffix


def render_result(value: object) -> str | None:
    """Pyodide hands the host a JS string for str/number values and the object's repr otherwise."""
    if value is None:
        return None
    try:
        if isinstance(value, (str, int, float, bool)):
            text = str(value)
        else:
            text = repr(value)
    except Exception:
        return "<unprintable result>"
    return clamp(text) if text != "" else None


def compile_with_value(code: str, filename: str = "<exec>"):
    """Compile `code`; when its last statement is an expression, split it off so its value can be
    returned (unless it ends with `;`, the notebook way to silence it)."""
    tree = ast.parse(code, filename, "exec")
    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not code.rstrip().endswith(";"):
        last_expr = ast.Expression(tree.body.pop().value)
        ast.fix_missing_locations(last_expr)
    body = compile(tree, filename, "exec")
    tail = compile(last_expr, filename, "eval") if last_expr is not None else None
    return body, tail


def describe_error(exc: BaseException) -> str:
    """A traceback without this module's own frames, like Pyodide's."""
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != "<exec>":
        tb = tb.tb_next
    lines = traceback.format_exception(type(exc), exc, tb)
    if tb is None:
        lines = traceback.format_exception_only(type(exc), exc)
    return clamp("".join(lines).strip() or "unknown error")


def is_clean_exit(exc: SystemExit) -> bool:
    return exc.code in (None, 0, "0")


def snapshot() -> dict[str, tuple[int, int]]:
    """Every file under OUTPUT_ROOT as {path: (mtime_ns, size)}."""
    found: dict[str, tuple[int, int]] = {}
    for base, _dirs, names in os.walk(OUTPUT_ROOT):
        for name in sorted(names):
            path = os.path.join(base, name)
            try:
                st = os.stat(path)
            except OSError:
                continue
            found[path] = (st.st_mtime_ns, st.st_size)
    return found


def changed_outputs(before: dict[str, tuple[int, int]]) -> list[dict]:
    """Files written or changed since `before`, like the browser's listing (capped)."""
    after = snapshot()
    changed = [
        {"path": path, "size": size}
        for path, (mtime, size) in sorted(after.items())
        if before.get(path) != (mtime, size)
    ]
    return changed[:MAX_LISTED_FILES]


def ensure_dir(path: str) -> None:
    """Create a directory, following a symlink that points at one that does not exist yet
    (/mnt/output -> /workspace/output in the image)."""
    os.makedirs(os.path.realpath(path), exist_ok=True)


def mounted_files() -> list[str]:
    out: list[str] = []
    for base, _dirs, names in os.walk(MOUNT_ROOT):
        out.extend(os.path.join(base, n) for n in names)
    return sorted(out)[:MAX_LISTED_FILES]


class Interpreter:
    """The persistent namespace and the figure module."""

    def __init__(self) -> None:
        self.namespace: dict = {"__name__": "__main__"}
        self.figures: types.ModuleType | None = None

    def reset(self) -> None:
        self.namespace = {"__name__": "__main__"}

    def load_figures(self, source: str | None) -> None:
        if self.figures is not None or not source:
            return
        module = types.ModuleType("_cerea_figures")
        sys.modules["_cerea_figures"] = module
        try:
            exec(compile(source, "<figures>", "exec"), module.__dict__)
            self.figures = module
        except Exception:
            sys.modules.pop("_cerea_figures", None)

    def figures_step(self, step: str, code: str = "") -> None:
        """Best effort, as in the browser: figure capture never fails a run."""
        if self.figures is None:
            return
        try:
            if step == "begin":
                self.figures.begin(bool(_MATPLOTLIB_MENTION.search(code)))
            else:
                self.figures.sweep()
        except Exception:
            pass

    def run(self, code: str, timeout: float, figures_source: str | None = None) -> dict:
        self.load_figures(figures_source)
        stdout, stderr = io.StringIO(), io.StringIO()
        value = None
        error: str | None = None
        timed_out = False
        ensure_dir(OUTPUT_ROOT)
        before = snapshot()
        self.figures_step("begin", code)

        def on_alarm(_signum, _frame):
            raise RunTimeout()

        previous = signal.signal(signal.SIGALRM, on_alarm)
        signal.setitimer(signal.ITIMER_REAL, max(0.5, float(timeout)))
        try:
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                try:
                    body, tail = compile_with_value(code)
                    exec(body, self.namespace)
                    if tail is not None:
                        value = eval(tail, self.namespace)
                except RunTimeout:
                    timed_out = True
                except SystemExit as exc:
                    if not is_clean_exit(exc):
                        error = describe_error(exc)
                except BaseException as exc:  # noqa: BLE001 - the model's code may raise anything
                    error = describe_error(exc)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
            self.figures_step("sweep")

        reply: dict = {
            "ok": error is None and not timed_out,
            "stdout": clamp(stdout.getvalue()),
            "stderr": clamp(stderr.getvalue()),
            "result": None if error is not None or timed_out else render_result(value),
            "error": error,
            "files": changed_outputs(before),
            "timeout": None,
        }
        if timed_out:
            mounted = mounted_files()
            # Same contract as the browser: a run stopped by the limit restarts the interpreter.
            self.reset()
            reply["error"] = "The run was stopped by the time limit."
            reply["timeout"] = {"seconds": int(timeout), "mountedFiles": mounted}
        return reply


def restart() -> None:
    """Replace this process with a fresh daemon: nothing of the old interpreter survives."""
    os.execv(sys.executable, [sys.executable, os.path.abspath(__file__), "serve"])


def serve(path: str = SOCKET) -> None:
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    ensure_dir(OUTPUT_ROOT)
    ensure_dir(MOUNT_ROOT)
    try:
        os.chdir(CWD)
    except OSError:
        pass
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    os.chmod(path, 0o600)
    server.listen(4)
    interpreter = Interpreter()
    while True:
        conn, _ = server.accept()
        with conn:
            try:
                handle(conn, interpreter)
            except Exception:  # noqa: BLE001 - a bad client must not take the interpreter down
                pass


def read_line(conn: socket.socket) -> bytes:
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buf += chunk
        if len(buf) > MAX_REQUEST_BYTES:
            raise ValueError("request too large")
    return buf


def handle(conn: socket.socket, interpreter: Interpreter) -> None:
    request = json.loads(read_line(conn) or b"{}")
    code = request.get("code")
    if not isinstance(code, str):
        conn.sendall(json.dumps({"ok": False, "error": "no code"}).encode() + b"\n")
        return
    timeout = float(request.get("timeout") or 60)
    figures_source = request.get("figures") if isinstance(request.get("figures"), str) else None
    done = threading.Event()

    def watchdog() -> None:
        # A C call (a long numpy operation) can sit through SIGALRM. Past the grace the interpreter
        # is replaced, as on the alarm path. (One that holds the GIL starves this thread too: the
        # client's own deadline and kill are the last resort.)
        if done.wait(timeout + WATCHDOG_GRACE_SECONDS):
            return
        reply = {
            "ok": False, "stdout": "", "stderr": "", "result": None,
            "error": "The run was stopped by the time limit.", "files": [],
            "timeout": {"seconds": int(timeout), "mountedFiles": mounted_files()},
        }
        try:
            conn.sendall(json.dumps(reply).encode() + b"\n")
        finally:
            restart()

    threading.Thread(target=watchdog, daemon=True).start()
    reply = interpreter.run(code, timeout, figures_source)
    done.set()
    conn.sendall(json.dumps(reply).encode() + b"\n")
    if reply.get("timeout"):
        restart()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
    else:
        sys.exit("usage: execd.py serve")
