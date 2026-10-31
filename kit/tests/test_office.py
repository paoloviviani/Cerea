"""The office profile (Gotenberg), as static checks on compose.yaml and .env.example.

Gotenberg parses uploaded documents with LibreOffice and Chromium, so what
matters here is that its box does not quietly loosen: no way out, no published
port, no shared volume, limits, timeouts. A unit test cannot start Docker; the
behaviour is proven on a throwaway container (see the Cerea repository's
gotenberg.integration.spec.ts). Standard library only.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def service(name: str) -> str:
    """The text of one top-level service block."""
    match = re.search(rf"^  {re.escape(name)}:\n((?:(?!^  \S|^\S).*\n|\n)*)", COMPOSE, re.MULTILINE)
    assert match, f"no service {name}"
    return match.group(1)


GOTENBERG = service("gotenberg")


class GotenbergBox(unittest.TestCase):
    def test_it_is_off_unless_the_office_profile_is_on(self):
        self.assertRegex(GOTENBERG, r"profiles: \[office\]")
        for other in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE):
            if other != "gotenberg":
                self.assertNotIn("office]", service(other).split("\n    image")[0], other)

    def test_the_image_is_an_exact_pinned_version(self):
        self.assertRegex(GOTENBERG, r"image: \$\{GOTENBERG_IMAGE:-gotenberg/gotenberg:8\.\d+\.\d+\}")
        self.assertNotIn("latest", GOTENBERG)

    def test_it_sits_on_the_internal_network_alone(self):
        self.assertRegex(GOTENBERG, r"networks: \[office\]")
        self.assertRegex(COMPOSE, re.compile(r"^networks:\n(?:  #.*\n)*  office:\n    internal: true\n", re.MULTILINE))
        # Nothing but the chat is on it.
        members = [
            name
            for name in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE)
            if re.search(r"networks: \[[^\]]*\boffice\b", service(name))
        ]
        self.assertEqual(sorted(members), ["chat", "gotenberg"])

    def test_it_publishes_nothing_and_shares_nothing(self):
        for key in ("ports:", "expose:", "volumes:", "volumes_from", "network_mode", "extra_hosts"):
            self.assertNotIn(key, GOTENBERG, key)
        self.assertNotIn("docker.sock", GOTENBERG)

    def test_it_is_confined(self):
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pids_limit:"):
            self.assertIn(needle, GOTENBERG)
        self.assertNotIn("privileged", GOTENBERG)

    def test_it_has_cpu_and_memory_limits(self):
        self.assertRegex(GOTENBERG, r"mem_limit: \$\{GOTENBERG_MEM_LIMIT:-\d+g\}")
        self.assertRegex(GOTENBERG, r"cpus: \$\{GOTENBERG_CPUS:-\d+\}")

    def test_it_has_its_own_timeouts_queues_and_url_filters(self):
        for flag in (
            "--api-timeout=",
            "--api-disable-download-from",
            "--libreoffice-restart-after=",
            "--libreoffice-max-queue-size=",
            "--chromium-max-queue-size=",
            "--chromium-disable-javascript",
            "--libreoffice-deny-public-ips",
            "--chromium-deny-public-ips",
            "--chromium-deny-private-ips",
        ):
            self.assertIn(flag, GOTENBERG)

    def test_it_has_a_healthcheck(self):
        self.assertIn("/health", GOTENBERG)


class ChatSide(unittest.TestCase):
    def test_the_chat_learns_the_url_from_one_variable_that_defaults_to_off(self):
        chat = service("chat")
        self.assertIn("CHAT_GOTENBERG_URL: ${CHAT_GOTENBERG_URL:-}", chat)
        self.assertRegex(chat, r"networks: \[default, office, docs, objects\]")

    def test_the_example_documents_it_commented_out(self):
        self.assertRegex(EXAMPLE, re.compile(r"^# CHAT_GOTENBERG_URL='http://gotenberg:3000'$", re.MULTILINE))
        self.assertNotRegex(EXAMPLE, re.compile(r"^CHAT_GOTENBERG_URL=", re.MULTILINE))
        self.assertIn("office", re.search(r"^#   office .*", EXAMPLE, re.MULTILINE).group(0))
        self.assertNotRegex(EXAMPLE, r"COMPOSE_PROFILES='[^']*office")

    def test_the_readme_explains_the_option_and_the_isolation(self):
        for needle in ("--office-preview", "CHAT_GOTENBERG_URL", "internal", "convert_document"):
            self.assertIn(needle, README)


if __name__ == "__main__":
    unittest.main()
