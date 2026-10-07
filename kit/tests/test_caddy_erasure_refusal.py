"""The proxy's own half of ADR 0093 §9.3: /chat/internal/* and /internal/*
answer 404 before either backend's own route ever sees the request, however
that path is spelled. A throwaway container running the real, pinned Caddy
image against this repository's own Caddyfile -- not a parser test, since
what matters is the rendered routing decision, not the source text.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "caddy:2.11-alpine"
CONTAINER = "cerea-deploy-test-caddy-erasure"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@unittest.skipUnless(shutil.which("docker"), "needs docker")
class CaddyErasureRefusalTests(unittest.TestCase):
    """One container for the whole class: starting Caddy is the slow part,
    and none of these requests changes anything it would need isolating
    from another test."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.port = _free_port()
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, timeout=15)
        subprocess.run(
            [
                "docker", "run", "-d", "--rm", "--name", CONTAINER,
                "-p", f"127.0.0.1:{cls.port}:80",
                "-v", f"{ROOT / 'caddy'}:/etc/caddy:ro",
                "-v", f"{ROOT / 'proxy.d'}:/etc/caddy.d:ro",
                # Upstream mode (no TLS_DIRECTIVE): the site is plain http,
                # so nothing here ever attempts ACME. gateway/chat/authelia
                # are never resolved -- only reached by a request this test
                # does not make to the paths this rule does not cover.
                "-e", "SITE_ADDRESS=http://:80",
                "-e", "TLS_DIRECTIVE=",
                "-e", "PROXY_DEFAULT=gateway",
                IMAGE,
            ],
            check=True, capture_output=True, timeout=30,
        )
        deadline = time.monotonic() + 15
        up = False
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/", timeout=1)
                up = True
                break
            except urllib.error.HTTPError:
                up = True  # any HTTP answer at all means Caddy is serving
                break
            except OSError:
                time.sleep(0.5)
        if not up:
            logs = subprocess.run(
                ["docker", "logs", CONTAINER], capture_output=True, text=True, timeout=10
            )
            subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, timeout=15)
            raise RuntimeError(f"caddy did not come up:\n{logs.stdout}\n{logs.stderr}")

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True, timeout=15)

    def _status(self, path: str) -> int:
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=5)
            return response.status
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_chat_internal_is_refused(self) -> None:
        self.assertEqual(self._status("/chat/internal/erasure"), 404)
        self.assertEqual(self._status("/chat/internal/erasure/preview"), 404)

    def test_bare_internal_is_refused(self) -> None:
        self.assertEqual(self._status("/internal/erasure"), 404)

    def test_an_ordinary_chat_path_reaches_the_chat_route_instead(self) -> None:
        # 502, not 404: the upstream `chat` host does not exist in this
        # throwaway container, which is exactly the point -- a 404 here
        # would be indistinguishable from the refusal above firing on the
        # wrong path instead of never reaching this one at all.
        self.assertEqual(self._status("/chat/something"), 502)


if __name__ == "__main__":
    unittest.main()
