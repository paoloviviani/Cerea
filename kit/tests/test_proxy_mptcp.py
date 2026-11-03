"""The published proxy refuses Multipath TCP (CVE-2026-98432's public exploit path)."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
PROXY = re.search(r"^  proxy:\n((?:(?:    .*)?\n)*)", COMPOSE, re.MULTILINE).group(1)


class ProxyMptcp(unittest.TestCase):
    def test_go_does_not_open_mptcp_listeners(self):
        self.assertRegex(PROXY, r"\n      GODEBUG: multipathtcp=0\n")

    def test_the_proxy_namespace_has_mptcp_off(self):
        self.assertRegex(PROXY, r"\n    sysctls:\n      net\.mptcp\.enabled: \"0\"\n")


if __name__ == "__main__":
    unittest.main()
