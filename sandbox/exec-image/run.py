"""cerea-run: the client of cerea-execd. The chat runs this once per `execute_code` call.

Reads one JSON request ({"code", "timeout", "figures"}) from stdin, starts the daemon if it is not
running (the first call of a lease), forwards the request over its unix socket and prints the
daemon's one-line JSON reply on stdout. State lives in the daemon, not here.

It also owns the last resort. A C call that holds the GIL defeats both of the daemon's own timers,
and the manager's `timeout -s KILL` only reaches this process, not the daemon (it has its own
session). So the wait for a reply has a deadline (the run's limit plus a grace), and when it passes
the daemon's whole process group is killed (its pid is in the pidfile), the socket removed, and a
timeout reply printed. The next call starts a fresh daemon.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time

SOCKET = os.environ.get("EXECD_SOCKET", "/tmp/execd.sock")
PIDFILE = os.environ.get("EXECD_PIDFILE", "/tmp/execd.pid")
GRACE = float(os.environ.get("EXECD_CLIENT_GRACE", "10"))
DAEMON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "execd.py")


def connect() -> socket.socket | None:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(SOCKET)
        return s
    except OSError:
        s.close()
        return None


def start_daemon() -> None:
    subprocess.Popen(
        [sys.executable, DAEMON, "serve"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,  # its own process group: killpg below reaches it and its threads
        close_fds=True,
    )


def kill_daemon() -> None:
    try:
        with open(PIDFILE) as f:
            pid = int(f.read().strip())
        os.killpg(pid, signal.SIGKILL)
    except (OSError, ValueError):
        pass
    for path in (SOCKET, PIDFILE):
        try:
            os.unlink(path)
        except OSError:
            pass


def main() -> int:
    raw = sys.stdin.buffer.read()
    try:
        timeout = float(json.loads(raw or b"{}").get("timeout") or 60)
    except (ValueError, AttributeError):
        timeout = 60.0
    s = connect()
    if s is None:
        start_daemon()
        deadline = time.monotonic() + 15
        while s is None and time.monotonic() < deadline:
            time.sleep(0.1)
            s = connect()
    if s is None:
        print(json.dumps({"ok": False, "error": "the exec daemon did not start"}))
        return 0
    buf = b""
    with s:
        s.settimeout(timeout + GRACE)
        try:
            s.sendall(raw.rstrip(b"\n") + b"\n")
            while b"\n" not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
        except socket.timeout:
            kill_daemon()
            print(json.dumps({
                "ok": False, "stdout": "", "stderr": "", "result": None,
                "error": "The run was stopped by the time limit.", "files": [],
                "timeout": {"seconds": int(timeout), "mountedFiles": []},
            }))
            return 0
    line = buf.split(b"\n")[0]
    sys.stdout.write((line or json.dumps({"ok": False, "error": "no reply"}).encode()).decode() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
