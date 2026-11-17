"""The proxy's artifact-share routes (ADR 0120), in all three TLS modes and both
share modes. The real, pinned Caddy image adapts this repository's Caddyfile
(`caddy adapt`, nothing is started); skipped without Docker or the image."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "caddy:2.11-alpine"

TLS = {
    "acme": dict(SITE_ADDRESS="https://llm.example.org", TLS_DIRECTIVE="", SHARE_SITE_ADDRESS="https://share.example.org"),
    "internal": dict(SITE_ADDRESS="https://llm.example.org", TLS_DIRECTIVE="tls internal", SHARE_SITE_ADDRESS="https://share.example.org"),
    "upstream": dict(SITE_ADDRESS="http://:80", TLS_DIRECTIVE="", SHARE_SITE_ADDRESS="http://share.example.org"),
}


def _have_image() -> bool:
    if not shutil.which("docker"):
        return False
    done = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True)
    return done.returncode == 0


def adapt(mode: str, tls: str) -> dict:
    env = {**TLS[tls], "SHARE_MODE": mode, "SHARE_PATH": "/s", "PROXY_DEFAULT": "chat"}
    cmd = ["docker", "run", "--rm", "-v", f"{ROOT / 'caddy'}:/etc/caddy:ro", "-v", f"{ROOT / 'proxy.d'}:/etc/caddy.d:ro"]
    for key, value in env.items():
        cmd += ["-e", f"{key}={value}"]
    cmd += [IMAGE, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        raise AssertionError(done.stderr)
    return json.loads(done.stdout)


def hosts(config: dict) -> list:
    out = []
    for server in config["apps"]["http"]["servers"].values():
        for route in server["routes"]:
            for match in route.get("match", []):
                out += match.get("host", [])
    return out


@unittest.skipUnless(_have_image(), f"needs Docker and the {IMAGE} image")
class TestShareRoutes(unittest.TestCase):
    def test_every_tls_mode_adapts_in_every_share_mode(self):
        for tls in TLS:
            for mode in ("off", "path", "subdomain"):
                with self.subTest(tls=tls, mode=mode):
                    adapt(mode, tls)

    def test_subdomain_adds_one_host_that_serves_only_the_share_handler_without_cookies(self):
        text = json.dumps(adapt("subdomain", "acme"))
        self.assertIn("share.example.org", text)
        # Only a token, its document or its file reaches the app; nothing else routes.
        self.assertIn("[A-Za-z0-9_-]{22}(/doc|/file/.+)?", text)
        self.assertIn("/chat/s{http.request.uri}", text)
        # No cookie goes to the app and none comes back.
        self.assertIn('"delete": ["Cookie"]', text)
        self.assertIn('"response": {"delete": ["Set-Cookie"]}', text)

    def test_subdomain_keeps_the_path_on_the_app_host_for_signed_in_links(self):
        config = adapt("subdomain", "acme")
        self.assertIn("llm.example.org", hosts(config))
        self.assertIn("/s/*", json.dumps(config))

    def test_path_adds_no_second_host_and_publishes_the_prefix(self):
        config = adapt("path", "acme")
        self.assertNotIn("share.example.org", hosts(config))
        self.assertIn("/s/*", json.dumps(config))

    def test_off_adds_neither(self):
        config = adapt("off", "acme")
        self.assertNotIn("share.example.org", hosts(config))
        self.assertNotIn("/s/*", json.dumps(config))


if __name__ == "__main__":
    unittest.main()
