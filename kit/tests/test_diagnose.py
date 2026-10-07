"""tools/diagnose: what it masks, what it shows, and that a secret cannot get out.

Standard library only: `python3 -m unittest`. No Docker: the commands it would run
are replaced by a fake runner, so what is tested is the report built from them.
"""

from __future__ import annotations

import contextlib
import importlib.machinery
import io
import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent


def _load():
    loader = importlib.machinery.SourceFileLoader("diagnose", str(ROOT / "tools" / "diagnose"))
    spec = importlib.util.spec_from_loader("diagnose", loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules["diagnose"] = module
    loader.exec_module(module)
    return module


diagnose = _load()

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl"
GATEWAY_KEY = "gwk_1a2b3c4d_" + "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lm9Nb8Vc7Xz6"
PROVIDER_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
DIGEST = "$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"


class Redact(unittest.TestCase):
    def assertMasked(self, text: str, secret: str) -> None:
        out = diagnose.redact(text)
        self.assertNotIn(secret, out, f"{secret!r} survived: {out!r}")

    def test_emails(self):
        self.assertMasked("sign-in by paolo.viviani@linksfoundation.com failed", "linksfoundation")

    def test_tokens_and_keys(self):
        self.assertMasked(f"token {JWT} rejected", JWT)
        self.assertMasked(f"Authorization: Bearer {GATEWAY_KEY}", GATEWAY_KEY)
        self.assertMasked(f"upstream key {GATEWAY_KEY} used", GATEWAY_KEY)
        self.assertMasked(f"calling with {PROVIDER_KEY}", PROVIDER_KEY)
        self.assertMasked("ghp_" + "a1B2c3D4e5" * 4, "a1B2c3D4e5")
        self.assertMasked("AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE")

    def test_named_values(self):
        for line in (
            "password=hunter2hunter2",
            "POSTGRES_PASSWORD='hunter2hunter2'",
            '{"client_secret": "hunter2hunter2"}',
            "access_token: hunter2hunter2",
            "GATEWAY_SECRET_KEY=hunter2hunter2",
            "Cookie: sid=hunter2hunter2; other=1",
            "Set-Cookie: session=hunter2hunter2; HttpOnly",
        ):
            self.assertMasked(line, "hunter2hunter2")

    def test_the_name_is_kept_so_the_line_still_reads(self):
        self.assertEqual(diagnose.redact("password=hunter2"), "password=<redacted>")

    def test_urls_with_credentials_keep_the_host(self):
        out = diagnose.redact("postgresql+asyncpg://gateway:s3cr3tpw@postgres:5432/gateway")
        self.assertNotIn("s3cr3tpw", out)
        self.assertIn("@postgres:5432/gateway", out)

    def test_password_digests_and_private_keys(self):
        self.assertMasked(f"digest: {DIGEST}", "aGFzaGhhc2hoYXNoaGFzaA")
        pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEF\nabcdef\n-----END PRIVATE KEY-----"
        self.assertMasked(f"key:\n{pem}\nafter", "MIIEvQIBADANBgkqhkiG9w0BAQEF")
        self.assertIn("after", diagnose.redact(f"key:\n{pem}\nafter"))

    def test_long_opaque_strings(self):
        self.assertMasked("hash " + "ab12" * 16, "ab12ab12ab12")
        self.assertMasked("opaque " + "Ab1" * 20, "Ab1Ab1Ab1")

    def test_what_a_log_reader_needs_is_left_alone(self):
        for line in (
            "prompt_tokens=412 completion_tokens=96",
            "session: started",
            "GET /v1/models 200 12ms",
            "request 6f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f done",
            "image sha256:" + "a" * 64,
            "quota counter for group a1b2c3d4-0000-0000-0000-000000000001 is 0.3798",
            "/var/lib/docker/volumes/cerea_postgres-data/_data",
        ):
            self.assertEqual(diagnose.redact(line), line)

    def test_a_literal_secret_from_env_is_masked_in_any_shape(self):
        # Not a shape any pattern knows: the .env value itself is the evidence.
        out = diagnose.redact("login failed for hunter-two-hunter", [("hunter-two-hunter", "X_PASSWORD")])
        self.assertEqual(out, "login failed for <redacted:X_PASSWORD>")


class Env(unittest.TestCase):
    TEXT = """# a comment
COMPOSE_PROFILES='gateway,chat,redaction,authelia'
PYSTINO_PRESET='team'
CEREA_VERSION='0.4.3'
CHAT_CODE_TOOL_ENABLED='true'
POSTGRES_PASSWORD='pw-pw-pw-pw-pw'
GATEWAY_UPSTREAM__API_KEY='sk-abcdefghijklmnopqrstuvwxyz'
PUBLIC_ORIGIN='https://cerea.example.org'
AUTHELIA_ADMIN_EMAIL='admin@example.org'
OIDC_ADMIN_EMAIL=''
AUTHELIA_ADMIN_PASSWORD_DIGEST='$argon2id$v=19$m=65536$abc$def'
"""

    def test_parse_strips_quotes_and_comments(self):
        env = diagnose.parse_env(self.TEXT)
        self.assertEqual(env["PYSTINO_PRESET"], "team")
        self.assertEqual(env["AUTHELIA_ADMIN_PASSWORD_DIGEST"], "$argon2id$v=19$m=65536$abc$def")
        self.assertNotIn("# a comment", env)

    def test_only_the_allowlist_shows_a_value(self):
        shown = diagnose.env_section(diagnose.parse_env(self.TEXT))
        for visible in (
            "COMPOSE_PROFILES=gateway,chat,redaction,authelia",
            "PYSTINO_PRESET=team",
            "CEREA_VERSION=0.4.3",
            "CHAT_CODE_TOOL_ENABLED=true",
        ):
            self.assertIn(visible, shown)
        for hidden in (
            "pw-pw-pw-pw-pw",
            "sk-abcdefghijklmnopqrstuvwxyz",
            "cerea.example.org",
            "admin@example.org",
            "argon2id",
        ):
            self.assertNotIn(hidden, shown)
        self.assertIn("POSTGRES_PASSWORD=<redacted>", shown)
        self.assertIn("OIDC_ADMIN_EMAIL=<empty>", shown)

    def test_every_key_is_listed(self):
        env = diagnose.parse_env(self.TEXT)
        shown = diagnose.env_section(env)
        for key in env:
            self.assertIn(f"{key}=", shown)

    def test_the_allowlist_holds_no_secret_named_key(self):
        for key in diagnose.ENV_ALLOWLIST:
            self.assertIsNone(diagnose.SECRET_KEY_NAME.search(key), key)

    def test_secret_literals_skip_short_and_allowlisted_values(self):
        env = {"X_PASSWORD": "short", "Y_SECRET": "long-enough-secret", "CEREA_VERSION": "0.4.3-token"}
        self.assertEqual(diagnose.secret_literals(env), [("long-enough-secret", "Y_SECRET")])


def fake_runner(*, quota_ok: bool = True, leak: str = ""):
    """Answers like Docker would, with `leak` planted in every log."""

    def runner(argv, timeout=60):
        argv = list(argv)
        joined = " ".join(argv)
        if argv[:3] == ["docker", "compose", "logs"]:
            return 0, f"2026-10-06 INFO started\n2026-10-06 ERROR login for a@b.example failed {leak}"
        if argv[:3] == ["docker", "compose", "ps"] and "--services" in argv:
            return 0, "postgres\ngateway\nchat\nextractor\nvalkey"
        if argv[:3] == ["docker", "compose", "ps"] and "json" in argv:
            return 0, '{"Service":"gateway","ID":"abc123","State":"running"}\n{"Service":"chat","ID":"def456"}'
        if argv[:2] == ["docker", "inspect"]:
            return 0, "running health=healthy restarts=0 oom=false exit=0 started=2026-10-05T10:00:00Z"
        if "quota" in argv and "health" in argv:
            if quota_ok:
                return 0, '{"windows": [{"rule": "r", "counter": "0.3798", "ledger": "0.2832"}]}'
            return 1, "pystino: error: argument command: invalid choice: 'quota'"
        if "psql" in joined:
            return 0, " id | name\n----+------\n 1  | r"
        if "valkey-cli" in joined:
            return 0, "q:user:abc:cost:p2026-10:r0 value=379800000 ttl=2000000"
        if argv[:2] == ["df", "-h"]:
            return 0, "Filesystem Size Used Avail Use%\n/dev/sda1 100G 40G 60G 40%"
        if argv[:3] == ["docker", "system", "df"]:
            return 0, "TYPE TOTAL ACTIVE SIZE\nImages 5 5 3GB"
        return 0, f"ok: {joined}"

    return runner


class Report(unittest.TestCase):
    ENV = {
        "COMPOSE_PROFILES": "gateway,chat",
        "POSTGRES_PASSWORD": "pg-secret-value-123",
        "GATEWAY_SECRET_KEY": "a-gateway-secret-key-xyz",
    }

    def test_every_section_is_present(self):
        report = diagnose.build_report(fake_runner(), env=self.ENV)
        for title in (
            "versions and pins",
            "docker compose ps",
            "service health",
            "logs",
            "quota health",
            "disk usage",
            ".env",
        ):
            self.assertIn(f"===== {title}", report)
        for service in diagnose.LOG_SERVICES:
            self.assertIn(f"--- {service} (last 200 lines) ---", report)
        self.assertIn("pins", report)
        self.assertIn("CEREA_VERSION (compose.yaml default)", report)

    def test_no_secret_survives_anywhere(self):
        leak = f"{self.ENV['POSTGRES_PASSWORD']} {JWT} {GATEWAY_KEY} postgresql://u:pw@h/db"
        report = diagnose.build_report(fake_runner(leak=leak), env=self.ENV)
        for secret in (
            self.ENV["POSTGRES_PASSWORD"],
            self.ENV["GATEWAY_SECRET_KEY"],
            JWT,
            GATEWAY_KEY,
            ":pw@",
            "a@b.example",
        ):
            self.assertNotIn(secret, report)
        # ...and the point of the file survived.
        self.assertIn("ERROR login for", report)

    def test_quota_comes_from_the_gateway_when_it_can(self):
        report = diagnose.build_report(fake_runner(quota_ok=True), env=self.ENV)
        self.assertIn("pystino quota health", report)
        self.assertIn('"counter": "0.3798"', report)
        self.assertNotIn("falling back", report)

    def test_quota_falls_back_to_sql_and_valkey_on_an_old_image(self):
        report = diagnose.build_report(fake_runner(quota_ok=False), env=self.ENV)
        self.assertIn("falling back to SQL and valkey-cli", report)
        self.assertIn("FROM limit_rules", report)
        self.assertIn("q:user:abc:cost:p2026-10:r0 value=379800000", report)

    def test_a_failing_section_does_not_lose_the_rest(self):
        def broken(argv, timeout=60):
            if "df" in argv[:3]:
                raise RuntimeError("boom")
            return fake_runner()(argv, timeout)

        report = diagnose.build_report(broken, env=self.ENV)
        self.assertIn("could not collect: RuntimeError: boom", report)
        self.assertIn("===== .env", report)

    def test_a_service_that_is_off_is_said_so(self):
        def runner(argv, timeout=60):
            if list(argv)[:3] == ["docker", "compose", "ps"] and "--services" in argv:
                return 0, "postgres\ngateway\nchat"
            return fake_runner()(argv, timeout)

        report = diagnose.build_report(runner, env=self.ENV)
        self.assertIn("not part of this install", report)

    def test_the_file_is_private_and_dated(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(diagnose, "build_report", return_value="report\n"):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(diagnose.main(["--output", tmp]), 0)
            (path,) = Path(tmp).glob("diagnose-*.txt")
            self.assertRegex(path.name, r"^diagnose-\d{4}-\d{2}-\d{2}\.txt$")
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)


class Script(unittest.TestCase):
    def test_it_is_executable_standard_library_only(self):
        path = ROOT / "tools" / "diagnose"
        self.assertTrue(path.stat().st_mode & 0o111)
        self.assertTrue(path.read_text().startswith("#!/usr/bin/env python3\n"))

    def test_the_readme_documents_it(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("tools/diagnose", readme)


if __name__ == "__main__":
    unittest.main()
