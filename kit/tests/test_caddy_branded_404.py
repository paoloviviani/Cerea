"""The gateway-mode proxy answers a browser's wrong address with the branded
404 page, and leaves API clients the gateway's own JSON. A throwaway Caddy
container (the real, pinned image, this repository's Caddyfile) in front of a
stub `gateway` that always answers JSON 404, on a throwaway network.
"""

from __future__ import annotations

import json
import shutil
import socket
import subprocess
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "caddy:2.11-alpine"
PYTHON_IMAGE = "python:3.13-slim"
SUFFIX = uuid.uuid4().hex[:8]
NETWORK = f"cerea-kit-test-404-{SUFFIX}"
PROXY = f"cerea-kit-test-404-proxy-{SUFFIX}"
STUB = "gateway"  # the name the Caddyfile proxies to

STUB_SERVER = """
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ok":
            body, status, kind = b"fine", 200, "text/plain"
        else:
            body, status, kind = json.dumps({"detail": "Not Found"}).encode(), 404, "application/json"
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

HTTPServer(("0.0.0.0", 8000), H).serve_forever()
"""

BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _run(*args: str, timeout: int = 30) -> None:
    subprocess.run(list(args), check=True, capture_output=True, timeout=timeout)


@unittest.skipUnless(shutil.which("docker"), "needs docker")
class BrandedNotFoundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        for image in (IMAGE, PYTHON_IMAGE):
            _run("docker", "pull", "-q", image, timeout=600)
        cls.port = _free_port()
        try:
            _run("docker", "network", "create", NETWORK)
            _run(
                "docker", "run", "-d", "--rm", "--name", f"{STUB}-{SUFFIX}",
                "--network", NETWORK, "--network-alias", STUB,
                PYTHON_IMAGE, "python", "-c", STUB_SERVER,
            )
            _run(
                "docker", "run", "-d", "--rm", "--name", PROXY, "--network", NETWORK,
                "-p", f"127.0.0.1:{cls.port}:80",
                "-v", f"{ROOT / 'caddy'}:/etc/caddy:ro",
                "-v", f"{ROOT / 'proxy.d'}:/etc/caddy.d:ro",
                "-e", "SITE_ADDRESS=http://:80",
                "-e", "TLS_DIRECTIVE=",
                "-e", "PROXY_DEFAULT=gateway",
                IMAGE,
            )
            deadline = time.monotonic() + 30
            while True:
                try:
                    cls._get("/ok")
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() > deadline:
                        raise RuntimeError("proxy or stub did not come up")
                    time.sleep(0.5)
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        subprocess.run(["docker", "rm", "-f", PROXY, f"{STUB}-{SUFFIX}"], capture_output=True, timeout=30)
        subprocess.run(["docker", "network", "rm", NETWORK], capture_output=True, timeout=30)

    @classmethod
    def _get(cls, path: str, accept: str | None = None) -> tuple[int, str, str]:
        request = urllib.request.Request(f"http://127.0.0.1:{cls.port}{path}")
        if accept is not None:
            request.add_header("Accept", accept)
        try:
            response = urllib.request.urlopen(request, timeout=5)
        except urllib.error.HTTPError as exc:
            response = exc
        return response.status if hasattr(response, "status") else response.code, response.headers.get("Content-Type", ""), response.read().decode()

    def test_browser_gets_the_page_with_404(self) -> None:
        status, kind, body = self._get("/cerea", BROWSER)
        self.assertEqual(status, 404)
        self.assertIn("text/html", kind)
        self.assertIn("<title>Page not found</title>", body)
        self.assertIn('href="/chat/"', body)
        self.assertNotIn("detail", body)

    def test_json_and_bare_requests_keep_the_gateway_json(self) -> None:
        for accept in ("application/json", None, "*/*"):
            with self.subTest(accept=accept):
                status, kind, body = self._get("/cerea", accept)
                self.assertEqual(status, 404)
                self.assertIn("application/json", kind)
                self.assertEqual(json.loads(body), {"detail": "Not Found"})

    def test_api_paths_never_get_html(self) -> None:
        for path in ("/v1/whatever", "/v1", "/api/x", "/auth/x", "/scim/v2/Users", "/V1/whatever"):
            with self.subTest(path=path):
                status, kind, body = self._get(path, BROWSER)
                self.assertEqual(status, 404)
                self.assertNotIn("text/html", kind)
                self.assertEqual(json.loads(body), {"detail": "Not Found"})

    def test_a_found_page_is_not_replaced(self) -> None:
        status, _, body = self._get("/ok", BROWSER)
        self.assertEqual((status, body), (200, "fine"))


if __name__ == "__main__":
    unittest.main()
