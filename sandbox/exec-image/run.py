"""cerea-run: the client of cerea-execd. The chat runs this once per `execute_code` call.

Reads one JSON request ({"code", "timeout", "figures"}) from stdin, starts the daemon if it is not
running (the first call of a lease), forwards the request over its unix socket and prints the
daemon's one-line JSON reply on stdout. State lives in the daemon, not here.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time

SOCKET = os.environ.get("EXECD_SOCKET", "/tmp/execd.sock")
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
        start_new_session=True,
        close_fds=True,
    )


def main() -> int:
    request = sys.stdin.buffer.read()
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
    with s:
        s.sendall(request.rstrip(b"\n") + b"\n")
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    sys.stdout.write((buf.split(b"\n")[0] or json.dumps({"ok": False, "error": "no reply"}).encode()).decode() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
