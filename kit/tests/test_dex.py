"""The dex+authelia identity mode's files, run by the real pinned images.

Three things: Caddy's routing in each identity mode (the Authelia-alone mode
must adapt to exactly what it did before Dex existed, and name no Dex route),
Dex's own configuration template rendered by the Dex image's gomplate with a
connector file from dex.d/, and what Dex does with that rendering. Standard
library only: `python3 -m unittest`; skipped without docker.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CADDY = "caddy:2.11-alpine"
#: compose.yaml's default; a test keeps the two equal.
DEX = "ghcr.io/dexidp/dex:v2.45.1"

ENV = {
    "DEX_ISSUER": "https://cerea.example.org/dex",
    "PUBLIC_ORIGIN": "https://cerea.example.org",
    "DEX_PG_PASSWORD": "pgpass",
    "DEX_CONSOLE_CLIENT_ID": "pystino-console",
    "DEX_CONSOLE_CLIENT_SECRET": "console-secret",
    "DEX_CHAT_CLIENT_ID": "cerea",
    "DEX_CHAT_CLIENT_SECRET": "chat-secret",
    "DEX_MACHINE_CLIENT_ID": "opencode-enrollment",
    "DEX_AUTHELIA_CLIENT_SECRET": "authelia-secret",
    "DEX_AUTHELIA_NAME": "Cerea account",
}


def _docker(*args: str, timeout: int = 90) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


@unittest.skipUnless(shutil.which("docker"), "needs docker")
class CaddyIdentityModes(unittest.TestCase):
    def adapt(self, mode: str | None, host: str = "") -> dict:
        args = ["run", "--rm", "-v", f"{ROOT / 'caddy'}:/etc/caddy:ro", "-v", f"{ROOT / 'proxy.d'}:/etc/caddy.d:ro",
                "-e", "SITE_ADDRESS=https://cerea.example.org", "-e", "TLS_DIRECTIVE=", "-e", "PROXY_DEFAULT=gateway"]
        if mode:
            args += ["-e", f"IDP_MODE={mode}", "-e", f"IDP_PUBLIC_HOST={host}"]
        args += [CADDY, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
        proc = _docker(*args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_authelia_alone_has_no_dex_route(self) -> None:
        text = json.dumps(self.adapt(None))
        self.assertNotIn("dex", text)
        self.assertEqual(self.adapt("authelia"), self.adapt(None))

    def test_dex_mode_publishes_dex_and_nothing_else_changes(self) -> None:
        alone, fronted = self.adapt(None), self.adapt("dex+authelia", "cerea.example.org:8443")
        text = json.dumps(fronted)
        self.assertIn('"dex:5556"', text)
        self.assertIn("/dex/*", text)
        self.assertNotEqual(alone, fronted)

    def test_the_backchannel_names_the_public_origin_to_authelia(self) -> None:
        proc = _docker(
            "run", "--rm", "-v", f"{ROOT / 'dex'}:/etc/dex:ro", "-e", "IDP_PUBLIC_HOST=cerea.example.org:8443",
            CADDY, "caddy", "adapt", "--config", "/etc/dex/backchannel.Caddyfile", "--adapter", "caddyfile",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = proc.stdout
        self.assertIn(":9092", text)
        self.assertIn("authelia:9091", text)
        self.assertIn("cerea.example.org:8443", text)
        self.assertIn("X-Forwarded-Proto", text)


@unittest.skipUnless(shutil.which("docker"), "needs docker")
class DexConfigTemplate(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dexd = Path(self.tmp.name)
        self.dexd.chmod(0o755)

    def render(self, extra: dict | None = None) -> subprocess.CompletedProcess[str]:
        args = ["run", "--rm", "--entrypoint", "gomplate", "-v", f"{ROOT / 'dex'}:/etc/dex:ro",
                "-v", f"{self.dexd}:/etc/dex.d:ro", "-w", "/etc/dex"]
        for key, value in {**ENV, **(extra or {})}.items():
            args += ["-e", f"{key}={value}"]
        return _docker(*args, DEX, "-f", "/etc/dex/config.yaml.tpl")

    def test_the_compose_default_is_the_image_these_tests_run(self) -> None:
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("${DEX_IMAGE:-" + DEX + "}", compose)

    def test_it_renders_the_clients_and_the_authelia_connector(self) -> None:
        proc = self.render()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = proc.stdout
        self.assertIn('issuer: "https://cerea.example.org/dex"', out)
        self.assertIn('redirectURI: "https://cerea.example.org/dex/callback"', out)
        self.assertIn('"https://cerea.example.org/auth/callback/default"', out)
        self.assertIn('"https://cerea.example.org/chat/login/callback"', out)
        # Device flow: Dex insists on /device/callback among a device client's URIs.
        self.assertIn("/device/callback", out)
        self.assertIn("insecureEnableGroups: true", out)
        self.assertNotIn("{{", out)
        if importlib.util.find_spec("yaml"):
            import yaml

            doc = yaml.safe_load(out)
            clients = {c["id"]: c for c in doc["staticClients"]}
            self.assertEqual(set(clients), {"pystino-console", "cerea", "opencode-enrollment"})
            self.assertTrue(clients["opencode-enrollment"]["public"])
            self.assertEqual(clients["opencode-enrollment"]["trustedPeers"], ["pystino-console", "cerea"])
            self.assertEqual([c["id"] for c in doc["connectors"]], ["authelia"])
            self.assertEqual(doc["connectors"][0]["config"]["issuerAlias"], "https://cerea.example.org/authelia")
            self.assertFalse(doc["enablePasswordDB"])

    def test_a_connector_file_is_added_after_authelia_with_its_secret_left_to_dex(self) -> None:
        (self.dexd / "10-acme.yaml").write_text(
            "- type: oidc\n  id: acme\n  name: ACME\n  config:\n    issuer: https://sso.acme.example\n"
            "    clientID: cid\n    clientSecret: ${DEX_CONN_ACME_CLIENT_SECRET}\n    insecureEnableGroups: true\n",
            encoding="utf-8",
        )
        (self.dexd / "README.md").write_text("not a connector", encoding="utf-8")
        proc = self.render()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("${DEX_CONN_ACME_CLIENT_SECRET}", proc.stdout)
        self.assertNotIn("not a connector", proc.stdout)
        if importlib.util.find_spec("yaml"):
            import yaml

            doc = yaml.safe_load(proc.stdout)
            self.assertEqual([c["id"] for c in doc["connectors"]], ["authelia", "acme"])

    def test_dex_accepts_the_rendering_and_expands_the_secret_from_its_environment(self) -> None:
        """Start Dex on the rendered file (memory storage) and read what it logs."""
        (self.dexd / "10-acme.yaml").write_text(
            "- type: oidc\n  id: acme\n  name: ACME\n  config:\n    issuer: https://127.0.0.1:1\n"
            "    clientID: cid\n    clientSecret: ${DEX_CONN_ACME_CLIENT_SECRET}\n    redirectURI: https://cerea.example.org/dex/callback\n",
            encoding="utf-8",
        )
        # One connector that always opens, so Dex has something to start on.
        (self.dexd / "20-mock.yaml").write_text("- type: mockCallback\n  id: mock\n  name: Mock\n", encoding="utf-8")
        rendered = self.render()
        self.assertEqual(rendered.returncode, 0, rendered.stderr)
        config = Path(self.tmp.name).parent / f"{Path(self.tmp.name).name}-rendered.yaml"
        self.addCleanup(lambda: config.unlink(missing_ok=True))
        # Memory storage in place of PostgreSQL: the storage block is the only difference.
        text = rendered.stdout
        start = text.index("storage:")
        end = text.index("web:")
        config.write_text(text[:start] + "storage:\n  type: memory\n\n" + text[end:], encoding="utf-8")
        config.chmod(0o644)
        # `dex-backchannel` unreachable on purpose, and quickly: Dex opens connectors at start.
        proc = _docker("run", "--rm", "--add-host", "dex-backchannel:127.0.0.1", "-e", "DEX_CONN_ACME_CLIENT_SECRET=expanded", "-v", f"{config}:/c.yaml:ro",
                       DEX, "sh", "-c", "timeout 12 dex serve /c.yaml 2>&1")
        log = proc.stdout
        self.assertIn("listening on", log, log)
        self.assertIn("config connector", log)
        self.assertNotIn("invalid config", log)
        # Dex goes on without the connectors it cannot open (Authelia, ACME: both
        # unreachable here), but not without all of them.
        self.assertIn('Failed to open connector" id=acme', log)


if __name__ == "__main__":
    unittest.main()
