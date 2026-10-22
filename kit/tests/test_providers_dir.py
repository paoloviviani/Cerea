"""The operator provider-catalogue directory (providers.d), as static checks.

The gateway reads /etc/pystino/providers.d at start. The kit must mount a
directory that exists in the checkout (or Docker creates it as root), keep the
operator's own files out of git, and not lose them on an upgrade. Standard
library only.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
GITIGNORE = (ROOT / ".gitignore").read_text(encoding="utf-8")
GET_KIT = (ROOT / "get-kit.sh").read_text(encoding="utf-8")


def gateway() -> str:
    match = re.search(r"^  gateway:\n((?:(?!^  \S|^\S).*\n|\n)*)", COMPOSE, re.MULTILINE)
    assert match, "no gateway service"
    return match.group(1)


class TestProvidersDir(unittest.TestCase):
    def test_the_gateway_mounts_it_read_only(self):
        self.assertIn(
            "- ${PYSTINO_PROVIDERS_DIR:-./providers.d}:/etc/pystino/providers.d:ro", gateway()
        )

    def test_no_other_service_mounts_it(self):
        self.assertEqual(COMPOSE.count("/etc/pystino/providers.d"), 1)

    def test_the_directory_ships_with_a_readme(self):
        self.assertTrue((ROOT / "providers.d/README.md").is_file())

    def test_operator_files_are_ignored_but_the_readme_is_not(self):
        self.assertIn("providers.d/*.yaml", GITIGNORE)
        self.assertIn("providers.d/*.yml", GITIGNORE)
        self.assertNotIn("providers.d/README", GITIGNORE)

    def test_env_example_documents_the_variable(self):
        self.assertIn("# PYSTINO_PROVIDERS_DIR='./providers.d'", EXAMPLE)

    def test_get_kit_carries_the_operators_files_over(self):
        self.assertIn('"$FROM"/providers.d/*.yaml', GET_KIT)
        self.assertIn('"$FROM"/providers.d/*.yml', GET_KIT)


if __name__ == "__main__":
    unittest.main()
