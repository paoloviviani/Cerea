"""The server-side MCP example (tools/mcp/), as static checks.

What a unit test can hold without a Docker daemon: the image is pinned, the
example's services stay unprivileged and publish no port, and the chat's
compose service passes the two variables the README tells people to set.
Standard library only: `python3 -m unittest`.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MCP = ROOT / "tools" / "mcp"
OVERRIDE = (MCP / "compose.override.example.yaml").read_text(encoding="utf-8")
DOCKERFILE = (MCP / "Dockerfile").read_text(encoding="utf-8")
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
ENV_EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")


class McpExample(unittest.TestCase):
    def test_image_is_pinned(self):
        self.assertRegex(DOCKERFILE, r"(?m)^FROM python:3\.\d+-slim@sha256:[0-9a-f]{64}$")
        self.assertRegex(DOCKERFILE, r"mcp-proxy==\d+\.\d+\.\d+")
        self.assertRegex(DOCKERFILE, r"uv==\d+\.\d+\.\d+")
        self.assertNotIn(":latest", OVERRIDE)

    def test_services_stay_unprivileged_and_unpublished(self):
        self.assertNotIn("docker.sock", OVERRIDE)
        self.assertNotRegex(OVERRIDE, r"(?m)^\s*ports:")
        services = re.findall(r"(?m)^  (mcp-[a-z0-9-]+):\n    build:", OVERRIDE)
        self.assertEqual(services, ["mcp-search", "mcp-osm"])
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pull_policy: never"):
            self.assertEqual(OVERRIDE.count(needle), len(services), needle)

    def test_the_chat_receives_the_settings_the_readme_names(self):
        for var in ("MCP_SERVERS", "MCP_INTERNAL_HOSTS"):
            self.assertIn(f"{var}: ${{{var}:-}}", COMPOSE)
            self.assertIn(f"{var}=", ENV_EXAMPLE)
            self.assertIn(var, README)

    def test_readme_hostnames_match_the_example(self):
        for host in ("mcp-search", "mcp-osm"):
            self.assertIn(f"http://{host}:8096/mcp", README)
            self.assertIn(f"  {host}:", OVERRIDE)


if __name__ == "__main__":
    unittest.main()
