"""The server-side MCP example (tools/mcp/), as static checks.

What a unit test can hold without a Docker daemon: the image is pinned, the
example's services stay unprivileged and publish no port, and the chat's
compose service passes the two variables the README tells people to set.
Standard library only: `python3 -m unittest`.
"""

from __future__ import annotations

import re
import shutil
import subprocess
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

    def test_osm_server_is_pinned_and_identifies_itself(self):
        self.assertIn("osm-mcp@0.3.2", OVERRIDE)
        self.assertNotIn("osm-mcp-server", OVERRIDE)
        self.assertRegex(OVERRIDE, r'OSM_USER_AGENT: "cerea-kit \(\+[^)\s]+\)"')
        self.assertNotRegex(OVERRIDE, r"OSM_USER_AGENT:.*example\.org")  # Nominatim refuses placeholder domains
        self.assertIn("NPM_CONFIG_CACHE: /cache/npm", OVERRIDE)
        self.assertRegex(DOCKERFILE, r"(?m)^FROM node:\d+-slim@sha256:[0-9a-f]{64} AS node$")
        self.assertIn("USER 10001", DOCKERFILE)

    def test_override_is_valid_compose(self):
        docker = shutil.which("docker")
        if not docker:
            self.skipTest("docker not installed")
        r = subprocess.run(
            [docker, "compose", "-f", str(MCP / "compose.override.example.yaml"), "config", "--quiet"],
            capture_output=True, text=True,
        )
        if r.returncode != 0 and "compose" in r.stderr and "not a docker command" in r.stderr:
            self.skipTest("docker compose not available")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_the_chat_receives_the_settings_the_readme_names(self):
        for var in ("MCP_SERVERS", "MCP_INTERNAL_HOSTS"):
            self.assertIn(f"{var}: ${{{var}:-}}", COMPOSE)
            self.assertIn(f"{var}=", ENV_EXAMPLE)
            self.assertIn(var, README)

    def test_readme_hostnames_match_the_example(self):
        for host in ("mcp-search", "mcp-osm"):
            self.assertIn(f"http://{host}:8096/mcp", README)
            self.assertIn(f"  {host}:", OVERRIDE)


    def test_maps_skill_names_only_tools_the_osm_server_has(self):
        skill = (MCP / "skills" / "maps-routing" / "SKILL.md").read_text(encoding="utf-8")
        front = re.match(r"(?s)^---\nname: maps-routing\ndescription: >\n(.+?)\n---\n", skill)
        self.assertIsNotNone(front, "frontmatter with name and description")
        osm_tools = {
            "geocode", "reverse_geocode", "route", "route_matrix", "optimize_route", "isochrone",
            "find_nearby_pois", "poi_details", "suggest_meeting_point", "straight_line_distance", "map_link",
        }
        named = set(re.findall(r"`([a-z_]+)`", skill))
        # `load_tools` is the chat's own built-in that loads a connector's tools (ADR 0104).
        self.assertEqual(
            named - osm_tools - {"load_tools"}, set(), "tools the skill names that osm-mcp does not have"
        )
        self.assertIn("tools/mcp/skills/maps-routing/SKILL.md", README)

if __name__ == "__main__":
    unittest.main()
