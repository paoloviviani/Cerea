"""The fetch profile's box (the headless browser), as static checks on compose.yaml.

The browser opens pages a model was pointed at, with JavaScript on, so what
matters is that its box does not quietly loosen: its own network (never
`default`), Chromium's sandbox switched on (seccomp profile, --unsafe so the
chat's launch option is honoured), a read-only root, no capabilities, limits. A
unit test cannot start Docker; the behaviour is proven on a running stack (see
the pull request that added this file). Standard library only.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")


def service(name: str) -> str:
    """The text of one top-level service block."""
    match = re.search(rf"^  {re.escape(name)}:\n((?:(?!^  \S|^\S).*\n|\n)*)", COMPOSE, re.MULTILINE)
    assert match, f"no service {name}"
    return match.group(1)


def networks_of(name: str) -> list[str]:
    """The networks a service lists, or ['default'] when it lists none."""
    match = re.search(r"^    networks: \[([^\]]*)\]", service(name), re.MULTILINE)
    return [n.strip() for n in match.group(1).split(",")] if match else ["default"]


PLAYWRIGHT = service("playwright")


class FetchNetwork(unittest.TestCase):
    def test_the_browser_is_on_the_fetch_network_alone(self):
        self.assertEqual(networks_of("playwright"), ["fetch"])

    def test_nothing_but_the_chat_shares_it(self):
        members = [n for n in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE) if "fetch" in networks_of(n)]
        self.assertEqual(sorted(members), ["chat", "playwright"])

    def test_the_chat_keeps_its_other_networks(self):
        self.assertEqual(sorted(networks_of("chat")), sorted(["default", "office", "docs", "objects", "fetch"]))

    def test_the_network_reaches_the_internet(self):
        # Fetching public pages needs a route out, so it is not internal.
        block = re.search(r"^networks:\n(.*)", COMPOSE, re.MULTILINE | re.DOTALL).group(1)
        entry = re.search(r"^  fetch:\n((?:    .*\n)*)", block, re.MULTILINE)
        self.assertIsNotNone(entry)
        self.assertNotIn("internal", entry.group(1))

    def test_it_publishes_and_shares_nothing(self):
        for key in ("ports:", "expose:", "volumes_from", "network_mode", "extra_hosts", "privileged"):
            self.assertNotIn(key, PLAYWRIGHT, key)
        self.assertNotIn("docker.sock", PLAYWRIGHT)
        # The one mount is the server's own config, read-only.
        self.assertEqual(re.findall(r"^      - (\S+)$", PLAYWRIGHT.split("volumes:")[1].split("restart:")[0], re.MULTILINE),
                         ["./playwright/sandbox-${PLAYWRIGHT_SANDBOX:-on}.json:/etc/cerea/playwright-server.json:ro"])


class FetchBox(unittest.TestCase):
    def test_it_is_confined(self):
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pids_limit:", "mem_limit:", "cpus:"):
            self.assertIn(needle, PLAYWRIGHT, needle)
        self.assertRegex(PLAYWRIGHT, r"user: pwuser")
        # One capability back, for the sandbox's chroot in its own user namespace.
        self.assertRegex(PLAYWRIGHT, r"cap_add: \[SYS_CHROOT\]")
        self.assertNotRegex(PLAYWRIGHT, r"SYS_ADMIN|privileged")

    def test_scratch_space_is_tmpfs_and_covers_the_npm_cache(self):
        for path in ("/tmp", "/home/pwuser/.npm"):
            self.assertRegex(PLAYWRIGHT, rf"- {re.escape(path)}(:|\n)")
        # pwuser is 1001 in the Playwright image, and npx runs what it fetched.
        self.assertIn("/home/pwuser/.npm:uid=1001,gid=1001,exec", PLAYWRIGHT)

    def test_the_sandbox_is_enabled_with_playwrights_seccomp_profile(self):
        self.assertIn("seccomp=./seccomp/playwright.json", PLAYWRIGHT)
        self.assertNotIn("seccomp=unconfined", PLAYWRIGHT)
        profile = json.loads((ROOT / "seccomp" / "playwright.json").read_text(encoding="utf-8"))
        self.assertEqual(profile["defaultAction"], "SCMP_ACT_ERRNO")
        names = {n for rule in profile["syscalls"] for n in rule["names"]}
        self.assertIn("clone", names)
        self.assertIn("unshare", names)

    def test_the_vendored_profile_records_its_source_and_licence(self):
        notice = (ROOT / "seccomp" / "NOTICE.md").read_text(encoding="utf-8")
        self.assertIn("Apache-2.0", notice)
        self.assertIn("github.com/microsoft/playwright", notice)
        self.assertRegex(notice, r"[0-9a-f]{40}")

    def test_the_server_enforces_the_sandbox_itself(self):
        # launch-server launches one Chromium with the config's options; clients
        # cannot change them. run-server --unsafe would let a client pick args.
        self.assertIn('"launch-server"', PLAYWRIGHT)
        self.assertNotIn("run-server", PLAYWRIGHT.split("healthcheck:")[0].split("command:")[1])
        self.assertNotIn("--unsafe", PLAYWRIGHT.split("command:")[1].split("\n")[0])
        self.assertNotIn("no-sandbox", PLAYWRIGHT.split("command:")[1].split("\n")[0])
        on = json.loads((ROOT / "playwright" / "sandbox-on.json").read_text(encoding="utf-8"))
        off = json.loads((ROOT / "playwright" / "sandbox-off.json").read_text(encoding="utf-8"))
        self.assertIs(on["chromiumSandbox"], True)
        self.assertIs(off["chromiumSandbox"], False)
        # The two differ in the sandbox alone.
        self.assertEqual({k: v for k, v in on.items() if k != "chromiumSandbox"},
                         {k: v for k, v in off.items() if k != "chromiumSandbox"})
        self.assertEqual(on["wsPath"], "/")  # the chat's PLAYWRIGHT_WS_ENDPOINT path
        for config in (on, off):
            self.assertNotIn("args", config)
            self.assertNotIn("executablePath", config)

    def test_the_sandbox_is_on_unless_switched_off(self):
        self.assertIn("sandbox-${PLAYWRIGHT_SANDBOX:-on}.json", PLAYWRIGHT)

    def test_the_seccomp_profile_is_the_pinned_playwright_version(self):
        version = re.search(r"PLAYWRIGHT_VERSION:-([0-9.]+)", PLAYWRIGHT).group(1)
        notice = (ROOT / "seccomp" / "NOTICE.md").read_text(encoding="utf-8")
        self.assertIn(f"v{version}", notice)


if __name__ == "__main__":
    unittest.main()
