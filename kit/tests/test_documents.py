"""The `documents` service (ADR 0103): static checks on compose.yaml, .env.example and configure.

The service parses uploaded Office files, so what matters is that its box does
not quietly loosen: internal network only, no published port, no volume,
read-only root, no capabilities, limits. The behaviour is proven by the
service's own tests and the release's fresh-kit check. Standard library only.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import re
import shutil
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = (ROOT / "compose.yaml").read_text(encoding="utf-8")
EXAMPLE = (ROOT / ".env.example").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def service(name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n((?:(?!^  \S|^\S).*\n|\n)*)", COMPOSE, re.MULTILINE)
    assert match, f"no service {name}"
    return match.group(1)


DOCUMENTS = service("documents")
CHAT = service("chat")


class DocumentsBox(unittest.TestCase):
    def test_it_runs_with_the_chat_profile(self):
        self.assertRegex(DOCUMENTS, r"profiles: \[chat\]")

    def test_its_image_is_the_chat_version(self):
        self.assertIn("x-documents-image: &documents-image ${DOCUMENTS_IMAGE:-", COMPOSE)
        line = re.search(r"^x-documents-image: .*$", COMPOSE, re.MULTILINE).group(0)
        self.assertIn("/cerea-documents:${CEREA_VERSION:-", line)
        self.assertIn("image: *documents-image", DOCUMENTS)

    def test_it_sits_on_an_internal_network_alone(self):
        self.assertRegex(DOCUMENTS, r"networks: \[docs\]")
        self.assertRegex(COMPOSE, re.compile(r"^networks:\n(?:  .*\n)*?  docs:\n    internal: true\n", re.MULTILINE))
        members = [
            name
            for name in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE)
            if re.search(r"networks: \[[^\]]*\bdocs\b", service(name))
        ]
        self.assertEqual(sorted(members), ["chat", "documents"])

    def test_it_publishes_nothing_and_shares_nothing(self):
        for key in ("ports:", "expose:", "volumes:", "volumes_from", "network_mode", "extra_hosts"):
            self.assertNotIn(key, DOCUMENTS, key)
        self.assertNotIn("docker.sock", DOCUMENTS)
        self.assertNotIn("privileged", DOCUMENTS)

    def test_it_is_confined(self):
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pids_limit:", "tmpfs:"):
            self.assertIn(needle, DOCUMENTS)
        self.assertRegex(DOCUMENTS, r"/tmp:rw,noexec,nosuid,size=\d+m")

    def test_it_has_cpu_and_memory_limits(self):
        self.assertRegex(DOCUMENTS, r"mem_limit: \$\{DOCUMENTS_MEM_LIMIT:-\d+g\}")
        self.assertRegex(DOCUMENTS, r"cpus: \$\{DOCUMENTS_CPUS:-\d+\}")

    def test_it_has_a_healthcheck(self):
        self.assertIn("healthcheck:", DOCUMENTS)
        self.assertIn("/healthz", DOCUMENTS)

    def test_it_takes_its_secret_from_the_variable_the_chat_uses(self):
        self.assertIn("CEREA_DOCUMENTS_SECRET: ${CHAT_DOCUMENTS_SECRET:-}", DOCUMENTS)
        self.assertIn("CHAT_DOCUMENTS_SECRET: ${CHAT_DOCUMENTS_SECRET:-}", CHAT)


class Pins(unittest.TestCase):
    def test_tools_pin_moves_the_documents_image_with_the_chat_image(self):
        loader = importlib.machinery.SourceFileLoader("pin_documents_test", str(ROOT / "tools/pin"))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        pin = importlib.util.module_from_spec(spec)
        loader.exec_module(pin)
        moved = pin.PIN["cerea"].sub(lambda m: m.group(1) + "9.9.9" + m.group(3), COMPOSE)
        self.assertRegex(moved, r"cerea-documents:\$\{CEREA_VERSION:-9\.9\.9\}")
        self.assertRegex(moved, r"/cerea:\$\{CEREA_VERSION:-9\.9\.9\}")
        self.assertEqual(pin.pins(moved)["cerea"], {"9.9.9"})


class ChatSide(unittest.TestCase):
    def test_the_url_defaults_to_the_bundled_service_and_empty_turns_it_off(self):
        self.assertIn("CHAT_DOCUMENTS_URL: ${CHAT_DOCUMENTS_URL-http://documents:8090}", CHAT)

    def test_the_chat_is_on_the_internal_network_and_does_not_wait_for_the_service(self):
        self.assertRegex(CHAT, r"networks: \[default, office, docs\]")
        depends = CHAT.split("depends_on:")[1]
        self.assertNotIn("documents", depends)

    def test_the_example_and_the_readme_explain_it(self):
        self.assertRegex(EXAMPLE, re.compile(r"^CHAT_DOCUMENTS_SECRET=''$", re.MULTILINE))
        self.assertRegex(EXAMPLE, re.compile(r"^# CHAT_DOCUMENTS_URL='http://documents:8090'$", re.MULTILINE))
        for needle in ("doc_edit", "CHAT_DOCUMENTS_SECRET", "internal", "DOCUMENTS_IMAGE"):
            self.assertIn(needle, README)


class Configure(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # The suite's one loaded copy of ./configure (test_configure registers it), or our own.
        cfg = sys.modules.get("configure")
        if cfg is None:
            loader = importlib.machinery.SourceFileLoader("configure", str(ROOT / "configure"))
            spec = importlib.util.spec_from_loader("configure", loader)
            cfg = importlib.util.module_from_spec(spec)
            sys.modules["configure"] = cfg
            loader.exec_module(cfg)
        cls.cfg = cfg

    def test_the_secret_is_minted_and_required_with_the_chat(self):
        self.assertEqual(self.cfg.MINTED["CHAT_DOCUMENTS_SECRET"], 32)
        self.assertIn("CHAT_DOCUMENTS_SECRET", self.cfg.REQUIRED_BY_PROFILE["chat"])

    def test_a_missing_secret_is_reported(self):
        report = self.cfg.Report()
        self.cfg.check_values({"COMPOSE_PROFILES": "chat"}, report)
        self.assertTrue(any("CHAT_DOCUMENTS_SECRET" in e for e in report.errors), report.errors)


@unittest.skipUnless(shutil.which("docker"), "needs docker compose")
class ComposeResolves(unittest.TestCase):
    def test_compose_config_names_the_service_on_the_internal_network_with_both_secrets(self):
        import json

        # The example leaves every secret empty, which compose refuses: fill them (as kit.yml does).
        env = re.sub(
            r"^([A-Z_]*(?:PASSWORD|SECRET|KEY|DIGEST)[A-Z_]*)=''$",
            r"\1='ci-placeholder'",
            EXAMPLE,
            flags=re.MULTILINE,
        )
        env += "\nCHAT_DOCUMENTS_SECRET=shared-secret\nCOMPOSE_PROFILES=gateway,chat\n"
        with tempfile.TemporaryDirectory(prefix="docs-compose-") as tmp:
            envfile = Path(tmp) / "env"
            envfile.write_text(env, encoding="utf-8")
            done = subprocess.run(
                ["docker", "compose", "--env-file", str(envfile), "-f", str(ROOT / "compose.yaml"),
                 "config", "--format", "json"],
                capture_output=True, text=True, timeout=60, cwd=tmp,
            )
        if done.returncode != 0 and "unknown shorthand flag" in done.stderr:
            self.skipTest("docker compose too old for --format json")
        self.assertEqual(done.returncode, 0, done.stderr)
        model = json.loads(done.stdout)
        docs = model["services"]["documents"]
        self.assertEqual(list(docs["networks"]), ["docs"])
        self.assertTrue(model["networks"]["docs"]["internal"])
        self.assertEqual(docs["environment"]["CEREA_DOCUMENTS_SECRET"], "shared-secret")
        chat = model["services"]["chat"]
        self.assertEqual(chat["environment"]["CHAT_DOCUMENTS_SECRET"], "shared-secret")
        self.assertEqual(chat["environment"]["CHAT_DOCUMENTS_URL"], "http://documents:8090")
        self.assertRegex(docs["image"], r"/cerea-documents:")
        self.assertEqual(docs["image"].rsplit(":", 1)[1], chat["image"].rsplit(":", 1)[1])
        self.assertNotIn("ports", docs)


if __name__ == "__main__":
    unittest.main()
