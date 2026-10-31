"""The rustfs profile (RustFS, the chat's optional S3-compatible file store), as
static checks on compose.yaml and .env.example, and ./configure's rules for it.

What matters here: it is off unless asked for, its image is pinned by version
and digest, it sits on an internal network with nothing published, and
./configure never switches an install that already holds files onto it.
Standard library only.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import re
import sys
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


RUSTFS = service("rustfs")


def _load():
    loader = importlib.machinery.SourceFileLoader("configure_rustfs", str(ROOT / "configure"))
    spec = importlib.util.spec_from_loader("configure_rustfs", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules["configure_rustfs"] = module
    loader.exec_module(module)
    return module


cfg = _load()
cfg.fetch_discovery = lambda issuer, timeout=8.0: None


def build(existing=None, **kw):
    base = dict(origin="https://chat.example.org", admin_email="ops@example.org")
    base.update(kw)
    return cfg.build(cfg.Answers(**base), existing or {}, EXAMPLE)


def profiles(values):
    return [p for p in values["COMPOSE_PROFILES"].split(",") if p]


class RustfsBox(unittest.TestCase):
    def test_it_is_off_unless_the_rustfs_profile_is_on(self):
        self.assertRegex(RUSTFS, r"profiles: \[rustfs\]")
        for other in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE):
            if other != "rustfs":
                self.assertNotIn("rustfs]", service(other).split("\n    image")[0], other)

    def test_the_image_is_pinned_by_version_and_digest(self):
        self.assertRegex(
            RUSTFS,
            r"image: \$\{RUSTFS_IMAGE:-rustfs/rustfs:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\}",
        )
        self.assertNotIn("latest", RUSTFS)

    def test_it_sits_on_the_internal_network_alone(self):
        self.assertRegex(RUSTFS, r"networks: \[objects\]")
        self.assertRegex(COMPOSE, re.compile(r"^networks:\n(?:  .*\n)*?  objects:\n    internal: true\n", re.MULTILINE))
        members = [
            name
            for name in re.findall(r"^  (\w[\w-]*):\n", COMPOSE, re.MULTILINE)
            if re.search(r"networks: \[[^\]]*\bobjects\b", service(name))
        ]
        self.assertEqual(sorted(members), ["chat", "rustfs"])

    def test_it_publishes_nothing_and_has_no_console(self):
        for key in ("ports:", "expose:", "network_mode", "extra_hosts", "volumes_from"):
            self.assertNotIn(key, RUSTFS, key)
        self.assertNotIn("docker.sock", RUSTFS)
        self.assertRegex(RUSTFS, r'RUSTFS_CONSOLE_ENABLE: "false"')

    def test_its_data_is_one_named_volume(self):
        self.assertEqual(re.findall(r"^      - (\S+:/\S+)$", RUSTFS.split("volumes:")[1].split("restart:")[0], re.MULTILINE), ["rustfs-data:/data"])
        self.assertRegex(COMPOSE, re.compile(r"^volumes:\n(?:  \S+:\n)*  rustfs-data:\n", re.MULTILINE))

    def test_it_is_confined(self):
        for needle in ("read_only: true", "cap_drop: [ALL]", "no-new-privileges:true", "pids_limit:"):
            self.assertIn(needle, RUSTFS)
        self.assertNotIn("privileged", RUSTFS)
        self.assertRegex(RUSTFS, r"mem_limit: \$\{RUSTFS_MEM_LIMIT:-\d+g\}")
        self.assertRegex(RUSTFS, r"cpus: \$\{RUSTFS_CPUS:-\d+\}")

    def test_its_keys_are_the_chats_and_never_literal(self):
        self.assertIn("RUSTFS_ACCESS_KEY: ${CHAT_S3_ACCESS_KEY_ID:-}", RUSTFS)
        self.assertIn("RUSTFS_SECRET_KEY: ${CHAT_S3_SECRET_ACCESS_KEY:-}", RUSTFS)
        self.assertNotRegex(RUSTFS, r"(?i)(access|secret)_key: [^$\s]")

    def test_it_has_a_healthcheck(self):
        self.assertIn("/health", RUSTFS)
        self.assertIn("service_healthy", re.search(r"rustfs:\n\s+condition: (\w+)", service("chat")).group(0))
        self.assertRegex(service("chat"), r"rustfs:\n\s+condition: service_healthy\n\s+required: false")


class ChatSide(unittest.TestCase):
    def test_the_chat_gets_every_setting_and_defaults_to_gridfs(self):
        chat = service("chat")
        for key in (
            "CHAT_BLOB_STORE", "CHAT_S3_ENDPOINT", "CHAT_S3_REGION", "CHAT_S3_BUCKET",
            "CHAT_S3_ACCESS_KEY_ID", "CHAT_S3_SECRET_ACCESS_KEY", "CHAT_S3_FORCE_PATH_STYLE",
            "CHAT_S3_PREFIX", "CHAT_S3_SSE", "CHAT_S3_SSE_KMS_KEY_ID", "CHAT_S3_CREATE_BUCKET",
        ):
            self.assertIn(f"{key}: ${{{key}:-}}", chat)

    def test_the_example_documents_it_commented_out(self):
        self.assertNotRegex(EXAMPLE, re.compile(r"^CHAT_BLOB_STORE=", re.MULTILINE))
        self.assertNotRegex(EXAMPLE, r"COMPOSE_PROFILES='[^']*rustfs")
        self.assertIn("rustfs", re.search(r"^#   rustfs .*", EXAMPLE, re.MULTILINE).group(0))
        for key in ("CHAT_S3_ENDPOINT", "CHAT_S3_BUCKET", "CHAT_S3_PREFIX", "CHAT_S3_SSE"):
            self.assertRegex(EXAMPLE, re.compile(rf"^# {key}=", re.MULTILINE))

    def test_the_readme_explains_the_option_the_migration_and_the_backup(self):
        for needle in ("--object-store", "rustfs-data", "blobs-migrate", "internal", "CHAT_BLOB_STORE"):
            self.assertIn(needle, README)


class ConfigureRules(unittest.TestCase):
    def test_off_by_default_in_every_preset(self):
        for preset in ("homelab", "team", "enterprise"):
            values = build(preset=preset).values
            self.assertNotIn("rustfs", profiles(values), preset)
            self.assertNotIn("CHAT_BLOB_STORE", values, preset)
            self.assertNotIn("CHAT_S3_ENDPOINT", values, preset)

    def test_a_fresh_install_with_the_flag_uses_it_and_mints_keys(self):
        values = build(rustfs=True).values
        self.assertIn("rustfs", profiles(values))
        self.assertEqual(values["CHAT_BLOB_STORE"], "s3")
        self.assertEqual(values["CHAT_S3_ENDPOINT"], cfg.RUSTFS_ENDPOINT)
        self.assertEqual(values["CHAT_S3_BUCKET"], cfg.RUSTFS_BUCKET)
        self.assertEqual(values["CHAT_S3_FORCE_PATH_STYLE"], "true")
        self.assertEqual(values["CHAT_S3_CREATE_BUCKET"], "true")
        self.assertRegex(values["CHAT_S3_ACCESS_KEY_ID"], r"^[0-9a-f]{20}$")
        self.assertRegex(values["CHAT_S3_SECRET_ACCESS_KEY"], r"^[0-9a-f]{64}$")

    def test_keys_are_minted_once(self):
        first = dict(build(rustfs=True).values)
        again = build(existing=first, rustfs=True).values
        self.assertEqual(again["CHAT_S3_ACCESS_KEY_ID"], first["CHAT_S3_ACCESS_KEY_ID"])
        self.assertEqual(again["CHAT_S3_SECRET_ACCESS_KEY"], first["CHAT_S3_SECRET_ACCESS_KEY"])
        self.assertEqual(build(existing=first).values["CHAT_S3_SECRET_ACCESS_KEY"], first["CHAT_S3_SECRET_ACCESS_KEY"])

    def test_an_existing_install_gets_the_store_but_keeps_gridfs(self):
        existing = dict(build().values)
        result = build(existing=existing, rustfs=True)
        self.assertIn("rustfs", profiles(result.values))
        self.assertNotEqual(result.values.get("CHAT_BLOB_STORE"), "s3")
        self.assertTrue(any("blobs-migrate" in n for n in result.notes), result.notes)
        # Once the operator has copied the files and switched, a re-run keeps s3.
        switched = dict(result.values) | {"CHAT_BLOB_STORE": "s3"}
        self.assertEqual(build(existing=switched).values["CHAT_BLOB_STORE"], "s3")

    def test_removing_it_is_refused_while_the_chat_uses_it(self):
        on = dict(build(rustfs=True).values)
        with self.assertRaisesRegex(cfg.ConfigError, "unreachable"):
            build(existing=on, rustfs=False)
        # Not in use (still GridFS): it can go.
        idle = dict(build().values)
        idle = dict(build(existing=idle, rustfs=True).values)
        off = build(existing=idle, rustfs=False).values
        self.assertNotIn("rustfs", profiles(off))

    def test_your_own_s3_is_left_alone_by_the_flag(self):
        own = dict(build().values) | {
            "CHAT_BLOB_STORE": "s3",
            "CHAT_S3_ENDPOINT": "https://s3.example.org",
            "CHAT_S3_BUCKET": "mine",
            "CHAT_S3_ACCESS_KEY_ID": "AKIA",
            "CHAT_S3_SECRET_ACCESS_KEY": "shh",
        }
        result = build(existing=own, rustfs=True)
        self.assertEqual(result.values["CHAT_S3_ENDPOINT"], "https://s3.example.org")
        self.assertEqual(result.values["CHAT_S3_BUCKET"], "mine")
        self.assertEqual(result.values["CHAT_S3_ACCESS_KEY_ID"], "AKIA")
        self.assertTrue(any("elsewhere" in n for n in result.notes), result.notes)

    def test_check_is_quiet_when_consistent_and_names_what_is_wrong(self):
        def check(values):
            report = cfg.Report()
            cfg.check_values(values, report)
            return report

        on = dict(build(rustfs=True).values)
        report = check(on)
        self.assertFalse([e for e in report.errors if "S3" in e or "rustfs" in e], report.errors)
        self.assertFalse([w for w in report.warnings if "rustfs" in w or "S3" in w], report.warnings)
        self.assertFalse([e for e in check(dict(build().values)).errors if "S3" in e])

        keyless = on | {"CHAT_S3_ACCESS_KEY_ID": ""}
        self.assertTrue(any("rustfs profile is on" in e for e in check(keyless).errors))
        nobucket = on | {"CHAT_S3_BUCKET": ""}
        self.assertTrue(any("CHAT_S3_BUCKET" in e for e in check(nobucket).errors))
        bad = on | {"CHAT_BLOB_STORE": "azure"}
        self.assertTrue(any("not 'gridfs' or 's3'" in e for e in check(bad).errors))
        orphan = on | {"COMPOSE_PROFILES": ",".join(p for p in profiles(on) if p != "rustfs")}
        self.assertTrue(any("rustfs profile is off" in w for w in check(orphan).warnings))

    def test_the_env_file_carries_the_settings(self):
        text = cfg.render(EXAMPLE, build(rustfs=True).values, "# header")
        self.assertIn("CHAT_BLOB_STORE='s3'", text)
        self.assertIn(f"CHAT_S3_ENDPOINT='{cfg.RUSTFS_ENDPOINT}'", text)
        self.assertIn("rustfs", [l for l in text.splitlines() if l.startswith("COMPOSE_PROFILES=")][0])
        self.assertNotIn("\nCHAT_BLOB_STORE=", cfg.render(EXAMPLE, build().values, "# header"))


if __name__ == "__main__":
    unittest.main()
